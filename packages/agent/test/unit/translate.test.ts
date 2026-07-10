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

/** Reassembles the closed text blocks (start→deltas→end), in emission order. */
function textBlocks(parts: ReturnType<TurnTranslator["ingest"]>): string[] {
  const open = new Map<string, string>();
  const blocks: string[] = [];
  for (const p of parts) {
    if (p.type === "text-start") open.set(p.id, "");
    else if (p.type === "text-delta") open.set(p.id, (open.get(p.id) ?? "") + p.delta);
    else if (p.type === "text-end") {
      blocks.push(open.get(p.id) ?? "");
      open.delete(p.id);
    }
  }
  return blocks;
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

describe("TurnTranslator — trailing snapshots after deltas", () => {
  it("emits delta-streamed final text once when its snapshot follows an earlier assistant message", () => {
    const { parts } = run([
      msg(2, "assistant", [
        { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
      ]),
      msg(3, "tool", [
        { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
      ]),
      part("assistant", { type: "text", text: "Done" }),
      // Trailing snapshot of the SAME message the deltas streamed — must be a
      // no-op for text, even though its id differs from the previous snapshot's.
      msg(4, "assistant", [{ type: "text", text: "Done" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["Done"]);
  });

  it("keeps per-message text blocks across a multi-round tool turn (no duplicates, no merged blocks)", () => {
    const round = (id: number, text: string, callId: string): ChatStreamEvent[] => [
      part("assistant", { type: "text", text }),
      part("assistant", { type: "tool-call", tool_call_id: callId, tool_name: "run", args: {} }),
      msg(id, "assistant", [
        { type: "text", text },
        { type: "tool-call", tool_call_id: callId, tool_name: "run", args: {} },
      ]),
      msg(id + 1, "tool", [
        { type: "tool-result", tool_call_id: callId, tool_name: "run", result: {} },
      ]),
    ];
    const { parts } = run([
      ...round(2, "A", "s1"),
      ...round(4, "B", "s2"),
      part("assistant", { type: "text", text: "C" }),
      msg(6, "assistant", [{ type: "text", text: "C" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["A", "B", "C"]);
  });

  it("emits delta-streamed reasoning once when its snapshot follows an earlier assistant message", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "tool-call", tool_call_id: "s1", tool_name: "run", args: {} }]),
      msg(3, "tool", [{ type: "tool-result", tool_call_id: "s1", tool_name: "run", result: {} }]),
      part("assistant", { type: "reasoning", text: "Think" }),
      part("assistant", { type: "text", text: "Done" }),
      msg(4, "assistant", [
        { type: "reasoning", text: "Think" },
        { type: "text", text: "Done" },
      ]),
      status("waiting"),
    ]);
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(reasoning).toBe("Think");
    expect(textBlocks(parts)).toEqual(["Done"]);
  });

  it("does not duplicate when an empty snapshot announces the message before its deltas", () => {
    const { parts } = run([
      msg(2, "assistant", []),
      part("assistant", { type: "text", text: "Hel" }),
      part("assistant", { type: "text", text: "lo" }),
      msg(2, "assistant", [{ type: "text", text: "Hello" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["Hello"]);
  });

  it("still emits a snapshot-only message that follows a delta-streamed one", () => {
    // Mode is decided per message: A streamed via deltas, B arrives snapshot-only.
    const { parts } = run([
      part("assistant", { type: "text", text: "A" }),
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      msg(4, "assistant", [{ type: "text", text: "B" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["A", "B"]);
  });
});

describe("TurnTranslator — source parts", () => {
  it("emits a url source from a streamed message_part once, deduping the trailing snapshot", () => {
    const src: ChatMessagePart = {
      type: "source",
      source_id: "src-1",
      url: "https://example.com/a",
      title: "A",
    };
    const { parts } = run([
      part("assistant", src),
      part("assistant", { type: "text", text: "Cited." }),
      msg(2, "assistant", [src, { type: "text", text: "Cited." }]),
      status("waiting"),
    ]);
    expect(parts.filter((p) => p.type === "source")).toEqual([
      { type: "source", sourceType: "url", id: "src-1", url: "https://example.com/a", title: "A" },
    ]);
    expect(textBlocks(parts)).toEqual(["Cited."]);
  });

  it("emits sources from a snapshot-only turn, falling back to the url as id", () => {
    const { parts } = run([
      msg(2, "assistant", [
        { type: "source", url: "https://example.com/b" },
        { type: "text", text: "See source." },
      ]),
      status("waiting"),
    ]);
    expect(parts.filter((p) => p.type === "source")).toEqual([
      {
        type: "source",
        sourceType: "url",
        id: "https://example.com/b",
        url: "https://example.com/b",
      },
    ]);
  });

  it("skips source parts without a url (the V4 part requires id + url)", () => {
    const { parts } = run([
      msg(2, "assistant", [
        { type: "source", source_id: "src-broken" },
        { type: "text", text: "ok" },
      ]),
      status("waiting"),
    ]);
    expect(parts.some((p) => p.type === "source")).toBe(false);
    expect(textBlocks(parts)).toEqual(["ok"]);
  });
});

describe("TurnTranslator — usage cost metadata", () => {
  it("surfaces wire cost/runtime under providerMetadata.coder and the verbatim usage under usage.raw", () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 3,
      total_cost_micros: 1234,
      total_runtime_ms: 5678,
    };
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], usage),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    expect(finish.providerMetadata).toEqual({
      coder: { total_cost_micros: 1234, total_runtime_ms: 5678 },
    });
    expect(finish.usage.raw).toEqual(usage);
  });

  it("includes only the cost keys the wire actually sent", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { total_cost_micros: 42 }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.providerMetadata).toEqual({ coder: { total_cost_micros: 42 } });
  });

  it("omits providerMetadata when the server sends no cost fields (old servers)", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { input_tokens: 10, output_tokens: 3 }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.providerMetadata).toBeUndefined();
    expect(finish.usage.raw).toEqual({ input_tokens: 10, output_tokens: 3 });
  });

  it("leaves usage.raw unset when no usage arrived", () => {
    const { parts } = run([msg(2, "assistant", [{ type: "text", text: "Hi" }]), status("waiting")]);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.usage.raw).toBeUndefined();
    expect(finish.providerMetadata).toBeUndefined();
  });
});
