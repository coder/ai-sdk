import { describe, expect, it } from "vitest";
import { TurnTranslator } from "../../src/model/translate.js";
import type { ChatStreamEvent, ChatMessage, ChatMessagePart } from "../../src/coder/types.js";

function msg(
  id: number,
  role: ChatMessage["role"],
  content: ChatMessagePart[],
  usage?: ChatMessage["usage"],
): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "c",
    message: { id, chat_id: "c", role, created_at: "", content, usage },
  };
}
function part(role: "assistant" | "tool", p: ChatMessagePart): ChatStreamEvent {
  return { type: "message_part", chat_id: "c", message_part: { role, part: p } };
}
function status(s: ChatStreamEvent["status"] extends infer _ ? string : never): ChatStreamEvent {
  return { type: "status", chat_id: "c", status: { status: s as never } };
}

function run(events: ChatStreamEvent[], dynamicToolNames = new Set<string>()) {
  const t = new TurnTranslator({ dynamicToolNames });
  const parts = [] as ReturnType<TurnTranslator["ingest"]>;
  for (const ev of events) {
    parts.push(...t.ingest(ev));
    if (t.terminalStatus) break;
  }
  parts.push(...t.finish());
  return { parts, t };
}

describe("TurnTranslator — snapshot (fast) mode", () => {
  it("emits a single text block from a full message snapshot", () => {
    const { parts } = run([
      msg(1, "user", [{ type: "text", text: "hi" }]),
      msg(2, "assistant", [{ type: "text", text: "Hello there" }], {
        input_tokens: 10,
        output_tokens: 3,
      }),
      status("waiting"),
    ]);
    const types = parts.map((p) => p.type);
    expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"]);
    const delta = parts.find((p) => p.type === "text-delta");
    expect(delta && "delta" in delta ? delta.delta : "").toBe("Hello there");
    const finish = parts.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("stop");
    expect(finish.type === "finish" && finish.usage.inputTokens.total).toBe(10);
    expect(finish.type === "finish" && finish.usage.outputTokens.total).toBe(3);
  });
});

describe("TurnTranslator — delta (streaming) mode", () => {
  it("emits reasoning then text deltas and does NOT double-count the trailing snapshot", () => {
    const { parts } = run([
      part("assistant", { type: "reasoning", text: "Think" }),
      part("assistant", { type: "reasoning", text: "ing..." }),
      part("assistant", { type: "text", text: "Hel" }),
      part("assistant", { type: "text", text: "lo" }),
      // trailing full snapshot with the SAME complete content:
      msg(2, "assistant", [
        { type: "reasoning", text: "Thinking..." },
        { type: "text", text: "Hello" },
      ]),
      status("waiting"),
    ]);
    const types = parts.map((p) => p.type);
    expect(types).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(text).toBe("Hello");
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(reasoning).toBe("Thinking...");
  });
});

describe("TurnTranslator — client (custom) tools", () => {
  it("emits a non-provider-executed tool-call from action_required and finishes tool-calls", () => {
    const { parts } = run(
      [
        part("assistant", { type: "text", text: "Let me check the weather." }),
        {
          type: "action_required",
          chat_id: "c",
          action_required: {
            tool_calls: [
              { tool_call_id: "tc1", tool_name: "getWeather", args: '{"city":"Paris"}' },
            ],
          },
        },
        status("requires_action"),
      ],
      new Set(["getWeather"]),
    );
    const call = parts.find((p) => p.type === "tool-call");
    expect(call).toBeDefined();
    expect(call && "toolName" in call ? call.toolName : "").toBe("getWeather");
    expect(call && "input" in call ? call.input : "").toBe('{"city":"Paris"}');
    expect(call && "providerExecuted" in call ? call.providerExecuted : undefined).toBeFalsy();
    const finish = parts.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("tool-calls");
  });
});

describe("TurnTranslator — server (provider-executed) tools", () => {
  it("surfaces chatd's own tools as provider-executed call + result", () => {
    const { parts } = run([
      msg(2, "assistant", [
        { type: "tool-call", tool_call_id: "s1", tool_name: "read_file", args: { path: "/x" } },
      ]),
      msg(3, "tool", [
        {
          type: "tool-result",
          tool_call_id: "s1",
          tool_name: "read_file",
          result: { content: "data" },
        },
      ]),
      msg(4, "assistant", [{ type: "text", text: "Done" }]),
      status("waiting"),
    ]);
    const call = parts.find((p) => p.type === "tool-call");
    expect(call && "providerExecuted" in call ? call.providerExecuted : false).toBe(true);
    // `dynamic: true` is what lets the AI SDK accept a tool name that is not in the
    // client ToolSet. Without it the call is marked `invalid`, which injects a phantom
    // tool-error output and halts the tool loop on this step — stranding the turn when
    // a client tool call is pending in the same segment.
    expect(call && "dynamic" in call ? call.dynamic : false).toBe(true);
    const inputStart = parts.find((p) => p.type === "tool-input-start");
    expect(inputStart && "dynamic" in inputStart ? inputStart.dynamic : false).toBe(true);
    const result = parts.find((p) => p.type === "tool-result");
    expect(result).toBeDefined();
    expect(result && "toolCallId" in result ? result.toolCallId : "").toBe("s1");
    // The result must mirror the call's dynamic flag, or call and result land in
    // different buckets (dynamicToolCalls vs. static toolResults) and can't pair.
    expect(result && "dynamic" in result ? result.dynamic : false).toBe(true);
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(text).toBe("Done");
  });
});

describe("TurnTranslator — orphaned server tool results", () => {
  it("drops a tool-result whose call streamed in a previous segment (would crash the AI SDK call-less)", () => {
    const { parts } = run([
      // Resume segment: chatd replays only messages after the cursor, so the tool
      // result arrives without its originating assistant tool-call message.
      msg(7, "tool", [
        {
          type: "tool-result",
          tool_call_id: "s-prev",
          tool_name: "web_search",
          result: { hits: 3 },
        },
      ]),
      msg(8, "assistant", [{ type: "text", text: "Done" }]),
      status("waiting"),
    ]);
    expect(parts.some((p) => p.type === "tool-result")).toBe(false);
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(text).toBe("Done");
  });
});

describe("TurnTranslator — errors", () => {
  it("emits an error part and finishes with error", () => {
    const { parts } = run([
      {
        type: "error",
        chat_id: "c",
        error: { message: "overloaded", kind: "overloaded", retryable: true },
      },
      status("error"),
    ]);
    expect(parts.some((p) => p.type === "error")).toBe(true);
    const finish = parts.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("error");
  });
});
