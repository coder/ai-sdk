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

function run(events: ChatStreamEvent[], dynamicToolNames = new Set<string>(), turnCursor = 0) {
  const t = new TurnTranslator({ dynamicToolNames, turnCursor });
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

describe("TurnTranslator — usage accumulation", () => {
  it("sums per-step usage across the turn's messages (chatd reports usage per committed step)", () => {
    const { parts } = run([
      msg(
        2,
        "assistant",
        [{ type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } }],
        {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_tokens: 800,
          total_cost_micros: 100,
          total_runtime_ms: 1500,
        },
      ),
      msg(3, "tool", [
        { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
      ]),
      msg(4, "assistant", [{ type: "text", text: "Done" }], {
        input_tokens: 1200,
        output_tokens: 30,
        cache_read_tokens: 1000,
        reasoning_tokens: 7,
        total_cost_micros: 120,
        total_runtime_ms: 900,
        context_limit: 200000,
      }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    // Totals cover the WHOLE turn, and inputTokens.total is the full prompt
    // size (uncached + cache reads/writes), not the near-zero uncached count.
    expect(finish.usage.inputTokens).toEqual({
      total: 2200 + 1800,
      noCache: 2200,
      cacheRead: 1800,
      cacheWrite: undefined,
    });
    expect(finish.usage.outputTokens).toEqual({ total: 80, text: undefined, reasoning: 7 });
    expect(finish.providerMetadata).toEqual({
      coder: { total_cost_micros: 220, total_runtime_ms: 2400 },
    });
    // raw carries the turn-accumulated wire usage; context_limit is a model
    // property, so the newest message's value wins rather than being summed.
    expect(finish.usage.raw).toEqual({
      input_tokens: 2200,
      output_tokens: 80,
      reasoning_tokens: 7,
      cache_read_tokens: 1800,
      total_cost_micros: 220,
      total_runtime_ms: 2400,
      context_limit: 200000,
    });
  });

  it("counts a re-streamed revision of the same message once (latest revision wins)", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { input_tokens: 10, output_tokens: 3 }),
      // Same message re-sent (revision bump / history reset replay) with
      // updated usage — must replace, not add.
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { input_tokens: 12, output_tokens: 4 }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(12);
    expect(finish.usage.outputTokens.total).toBe(4);
  });

  it("skips messages at or below the turn cursor entirely (replayed earlier turns)", () => {
    const { parts } = run(
      [
        // Replay of a previous turn's message (id <= cursor) — must count
        // toward neither usage nor content (a mid-turn history_reset re-sends
        // the FULL history, earlier turns included).
        msg(4, "assistant", [{ type: "text", text: "old answer" }], {
          input_tokens: 999,
          output_tokens: 999,
        }),
        msg(6, "assistant", [{ type: "text", text: "new" }], {
          input_tokens: 10,
          output_tokens: 3,
        }),
        status("waiting"),
      ],
      new Set<string>(),
      5,
    );
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.total).toBe(3);
    // The replayed message's text must not re-emit as this turn's output.
    expect(textBlocks(parts)).toEqual(["new"]);
  });

  it("ignores usage on tool messages (chatd attaches usage to assistant steps only)", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { input_tokens: 10, output_tokens: 3 }),
      // A hypothetical server mirroring the step's usage onto the committed
      // tool message must not double-count under summing.
      msg(3, "tool", [], { input_tokens: 10, output_tokens: 3 }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.total).toBe(3);
  });

  it("passes unknown wire usage fields through raw (newest message wins)", () => {
    /** A newer server's usage payload with a field this SDK doesn't know yet. */
    interface FutureUsage extends NonNullable<ChatMessage["usage"]> {
      web_search_requests?: number;
    }
    const older: FutureUsage = { input_tokens: 10, web_search_requests: 2 };
    const newer: FutureUsage = { input_tokens: 5, web_search_requests: 3 };
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], older),
      msg(4, "assistant", [{ type: "text", text: "Bye" }], newer),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    // Known counters sum; the field this SDK doesn't know keeps the newest
    // message's value — `usage.raw` stays a forward-compatible escape hatch.
    expect(finish.usage.raw).toEqual({ input_tokens: 15, web_search_requests: 3 });
  });

  it("adds cache write tokens into inputTokens.total alongside reads", () => {
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "Hi" }], {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_tokens: 1000,
        cache_creation_tokens: 200,
      }),
      status("waiting"),
    ]);
    const finish = parts.at(-1)!;
    expect(finish.type).toBe("finish");
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens).toEqual({
      total: 1205,
      noCache: 5,
      cacheRead: 1000,
      cacheWrite: 200,
    });
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

describe("TurnTranslator — redial replay", () => {
  it("recovers text and reasoning committed while the stream was disconnected", () => {
    // Deltas stream part of the message, the connection drops, and the message
    // COMMITS during the gap: the redialed stream replays only the full
    // snapshot (no more deltas for that episode). The snapshot's surplus over
    // the emitted length is exactly the content generated during the gap and
    // must be emitted, not treated as a redundant trailing snapshot.
    const { parts } = run([
      part("assistant", { type: "reasoning", text: "Think" }),
      part("assistant", { type: "text", text: "Hel" }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(
        2,
        "assistant",
        [
          { type: "reasoning", text: "Think" },
          { type: "text", text: "Hello world" },
        ],
        { input_tokens: 5, output_tokens: 4 },
      ),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["Hello world"]);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(5);
  });

  it("does not re-emit earlier steps when a multi-step turn replays from the original cursor", () => {
    // Two committed steps (a server-tool round), then a drop: the redial
    // replays BOTH snapshots from the turn's original after_id. The earlier
    // message must not re-trigger the boundary logic and re-emit its text.
    const step1 = msg(
      2,
      "assistant",
      [
        { type: "text", text: "Step one" },
        { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
      ],
      { input_tokens: 10, output_tokens: 2 },
    );
    const toolMsg = msg(3, "tool", [
      { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
    ]);
    const step2 = msg(4, "assistant", [{ type: "text", text: "Step two" }], {
      input_tokens: 20,
      output_tokens: 3,
    });
    const { parts } = run([
      step1,
      toolMsg,
      step2,
      // — drop; redial replays the whole turn —
      step1,
      toolMsg,
      step2,
      status("waiting"),
    ]);

    expect(textBlocks(parts)).toEqual(["Step one", "Step two"]);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
    expect(parts.filter((p) => p.type === "tool-result")).toHaveLength(1);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(30);
    expect(finish.usage.outputTokens.total).toBe(5);
  });

  it("does not splice a replayed committed snapshot into the next step's open deltas", () => {
    // Step 1 commits (text + tool call closes its block); step 2's deltas are
    // streaming when the drop hits. currentAssistantId still names step 1
    // (deltas carry no id), so the replayed step-1 snapshot must NOT be
    // diffed against the open step-2 block ("Sec" + "First".slice(3) = "st").
    const step1 = msg(2, "assistant", [
      { type: "text", text: "First" },
      { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
    ]);
    const toolMsg = msg(3, "tool", [
      { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
    ]);
    const { parts } = run([
      step1,
      toolMsg,
      part("assistant", { type: "text", text: "Sec" }),
      // — drop; redial replays the turn, then step 2 finishes —
      step1,
      toolMsg,
      part("assistant", { type: "text", text: "ond" }),
      msg(4, "assistant", [{ type: "text", text: "Second" }]),
      status("waiting"),
    ]);
    // Block granularity matches the no-drop flow (a snapshot-opened block stays
    // open across snapshot-content tool calls); what matters is the total text:
    // no spurious splice suffix, nothing double-emitted.
    expect(textBlocks(parts).join("")).toBe("FirstSecond");
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });

  it("recovers a reasoning suffix when reasoning was the open block at the drop", () => {
    // The drop happens while REASONING is still streaming; the message commits
    // during the gap with completed reasoning plus final text. The open
    // reasoning block must reconcile before snapshot text opens its own block
    // (which closes reasoning and would discard its length cursor).
    const { parts } = run([
      part("assistant", { type: "reasoning", text: "Think" }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(2, "assistant", [
        { type: "reasoning", text: "Thinking hard" },
        { type: "text", text: "Answer" },
      ]),
      status("waiting"),
    ]);
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(reasoning).toBe("Thinking hard");
    expect(textBlocks(parts)).toEqual(["Answer"]);
    // Block order preserved: reasoning completes before text opens.
    const types = parts.map((p) => p.type);
    expect(types.indexOf("reasoning-end")).toBeLessThan(types.indexOf("text-start"));
  });

  it("does not double-emit content, tool calls, or usage when a reconnect replays the turn", () => {
    // A redial replays the turn from its original after_id, so the translator
    // re-sees events it already ingested: the committed snapshot of a message
    // whose deltas streamed, and the pending action_required. Neither may
    // double-emit.
    const action: ChatStreamEvent = {
      type: "action_required",
      chat_id: "c",
      action_required: {
        tool_calls: [{ tool_call_id: "t1", tool_name: "myTool", args: "{}" }],
      },
    };
    const { parts } = run(
      [
        part("assistant", { type: "text", text: "Hel" }),
        part("assistant", { type: "text", text: "lo" }),
        msg(2, "assistant", [{ type: "text", text: "Hello" }], {
          input_tokens: 10,
          output_tokens: 2,
        }),
        action,
        // — reconnect: chatd re-syncs the committed snapshot and the pending action —
        msg(2, "assistant", [{ type: "text", text: "Hello" }], {
          input_tokens: 10,
          output_tokens: 2,
        }),
        action,
        status("requires_action"),
      ],
      new Set(["myTool"]),
    );

    expect(textBlocks(parts)).toEqual(["Hello"]);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
    const finish = parts.at(-1)!;
    if (finish.type !== "finish") return;
    expect(finish.usage.inputTokens.total).toBe(10);
    expect(finish.usage.outputTokens.total).toBe(2);
    expect(finish.finishReason.unified).toBe("tool-calls");
  });
});

describe("TurnTranslator — commit-during-disconnect reconciliation (#60)", () => {
  it("emits the text tail from a trailing snapshot when the text block was closed before the drop", () => {
    // Text streamed, then reasoning opened (closing the text block), then the
    // stream dropped; the message COMMITS during the gap with MORE text after
    // the reasoning. The trailing snapshot must yield both remaining suffixes
    // — a closed block's content is tracked in the per-message ledger, not
    // lost with the block's cursor.
    const { parts } = run([
      part("assistant", { type: "text", text: "A" }),
      part("assistant", { type: "reasoning", text: "Th" }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(2, "assistant", [
        { type: "text", text: "A" },
        { type: "reasoning", text: "Think" },
        { type: "text", text: "B" },
      ]),
      status("waiting"),
    ]);
    expect(textBlocks(parts).join("")).toBe("AB");
    const reasoning = parts
      .filter((p) => p.type === "reasoning-delta")
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
    expect(reasoning).toBe("Think");
  });

  it("recovers missing snapshot content in wire-part order, not open-block-first", () => {
    // Only text streamed before the drop; the committed snapshot interleaves
    // an unseen reasoning part BETWEEN the seen text and the text tail. The
    // recovered blocks must follow the snapshot's part order (A, Think, B) —
    // not emit the whole text tail first because the text block was open.
    const { parts } = run([
      part("assistant", { type: "text", text: "A" }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(2, "assistant", [
        { type: "text", text: "A" },
        { type: "reasoning", text: "Think" },
        { type: "text", text: "B" },
      ]),
      status("waiting"),
    ]);
    expect(parts.map((p) => p.type)).toEqual([
      "text-start",
      "text-delta", // streamed "A"
      "text-end",
      "reasoning-start",
      "reasoning-delta", // recovered "Think"
      "reasoning-end",
      "text-start",
      "text-delta", // recovered "B"
      "text-end",
      "finish",
    ]);
    expect(textBlocks(parts)).toEqual(["A", "B"]);
  });

  it("recovers the tail when an announced message commits during the disconnect (same-id snapshot)", () => {
    // chatd can announce a message with an empty snapshot before its deltas.
    // If the message then commits while the stream is down, the reconnect's
    // full snapshot carries the SAME id the announce did — it must still fill
    // in the tail the lost deltas never delivered.
    const { parts } = run([
      msg(2, "assistant", []),
      part("assistant", { type: "text", text: "Hel" }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(2, "assistant", [{ type: "text", text: "Hello world" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts).join("")).toBe("Hello world");
  });

  it("does not diff a delta-streamed step against the previous snapshot-only step's cursor", () => {
    // Step 1 arrived snapshot-only (committed before the client connected);
    // step 2 streams via deltas and its trailing snapshot arrives after a
    // drop. The snapshot must reconcile against what was emitted FOR THAT
    // MESSAGE — diffing against a block-length cursor polluted by step 1
    // would emit a corrupt suffix ("e") and lose the tail.
    const { parts } = run([
      msg(
        2,
        "assistant",
        [
          { type: "text", text: "One" },
          { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
        ],
        { input_tokens: 1, output_tokens: 1 },
      ),
      msg(3, "tool", [
        { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
      ]),
      part("assistant", { type: "text", text: "Two " }),
      // — drop; commit during the gap; redial replays the snapshot —
      msg(4, "assistant", [{ type: "text", text: "Two done" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts).join("")).toBe("OneTwo done");
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });
});

describe("TurnTranslator — earlier-message revision reconciliation (#57)", () => {
  it("emits the appended suffix when an earlier message's snapshot is revised mid-turn", () => {
    const { parts } = run([
      msg(2, "assistant", [
        { type: "text", text: "First" },
        { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
      ]),
      msg(3, "tool", [
        { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
      ]),
      msg(4, "assistant", [{ type: "text", text: "Second" }]),
      // Revision bump: chatd re-streams message 2 with appended content.
      msg(2, "assistant", [
        { type: "text", text: "First — amended" },
        { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
      ]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["First", "Second", " — amended"]);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });

  it("emits a revision suffix once even when the revised snapshot replays", () => {
    const revised = msg(2, "assistant", [{ type: "text", text: "First!" }]);
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "First" }]),
      msg(4, "assistant", [{ type: "text", text: "Second" }]),
      revised,
      // — redial replays the already-reconciled revision —
      revised,
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["First", "Second", "!"]);
  });

  it("brackets a revision suffix in its own block instead of splicing it into open deltas", () => {
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
      part("assistant", { type: "text", text: "C1" }),
      // Revision of step 1 lands while step 3's deltas are open: its suffix
      // must land in its OWN block, not splice into the open step-3 block.
      msg(2, "assistant", [
        { type: "text", text: "A — amended" },
        { type: "tool-call", tool_call_id: "s1", tool_name: "run", args: {} },
      ]),
      part("assistant", { type: "text", text: "C2" }),
      msg(6, "assistant", [{ type: "text", text: "C1C2" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["A", "B", "C1", " — amended", "C2"]);
  });

  it("does not let a same-id revision claim the next step's open deltas on a prefix collision", () => {
    // Message 2 committed with "A"; the next step streams "B"; then a
    // revision of message 2 arrives whose content is "ABX". #currentAssistantId
    // still names message 2 (deltas carry no id), and the revision's content
    // extends ledger + pending — but the pending "B" belongs to the NEXT,
    // still-uncommitted message and must not be claimed (claiming would
    // splice "X" into the open next-step block and desync both messages).
    // The revision reconciles later, once the next step commits and a
    // re-sent snapshot takes the earlier-message path.
    const revised = msg(2, "assistant", [{ type: "text", text: "ABX" }]);
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      part("assistant", { type: "text", text: "B" }),
      revised,
      msg(4, "assistant", [{ type: "text", text: "B" }]),
      // — chatd re-sends the revised snapshot (replay/revision bump) —
      revised,
      status("waiting"),
    ]);
    // The next step's "B" delta stays in its own stream; the revision suffix
    // "BX" lands once, bracketed, after the race resolves.
    expect(textBlocks(parts)).toEqual(["AB", "BX"]);
  });

  it("treats a tool-only snapshot as substantive: its revision cannot claim next-step deltas", () => {
    // Message 2 committed with only a tool call (no text/reasoning). That is
    // a SUBSTANTIVE commit, not an announce: a later same-id revision racing
    // the next step's open deltas must not claim them just because the
    // message's text ledger is empty. The revision reconciles only after the
    // next step commits, in its own bracketed block.
    const revised = msg(2, "assistant", [
      { type: "text", text: "Result: 42" },
      { type: "tool-call", tool_call_id: "s1", tool_name: "run", args: {} },
    ]);
    const { parts } = run([
      msg(2, "assistant", [{ type: "tool-call", tool_call_id: "s1", tool_name: "run", args: {} }]),
      msg(3, "tool", [{ type: "tool-result", tool_call_id: "s1", tool_name: "run", result: {} }]),
      part("assistant", { type: "text", text: "Result: " }),
      revised, // mid-race: must claim nothing
      msg(4, "assistant", [{ type: "text", text: "Result: ok" }]),
      revised, // after the race resolves: reconciles, bracketed
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["Result: ok", "Result: 42"]);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });

  it("settles pending deltas on a suppressed rewrite commit so later messages reconcile", () => {
    // A delta-streamed message commits with REWRITTEN content ("Hi" does not
    // extend the emitted "Hello"): the rewrite itself stays suppressed, but
    // the commit still settles ownership of the deltas — stale pending
    // content must not poison the NEXT message's reconciliation.
    const { parts } = run([
      part("assistant", { type: "text", text: "Hello" }),
      msg(2, "assistant", [{ type: "text", text: "Hi" }]),
      msg(4, "assistant", [{ type: "text", text: "Next" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["Hello", "Next"]);
  });

  it("reconciles a revision deferred during a delta race once the next step commits", () => {
    // The mid-race revision arrives ONCE on a healthy connection — chatd does
    // not re-send it later. Its suffix must be cached and reconciled when the
    // next step's snapshot settles delta ownership, not wait for a replay
    // that never comes.
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      part("assistant", { type: "text", text: "B" }),
      msg(2, "assistant", [{ type: "text", text: "A+" }]), // mid-race, sent once
      msg(4, "assistant", [{ type: "text", text: "B" }]), // resolves the race
      status("waiting"),
    ]);
    // "A" and the step-2 delta share a block (snapshot-opened block stays
    // open); the deferred revision suffix "+" lands bracketed after the race
    // resolves.
    expect(textBlocks(parts)).toEqual(["AB", "+"]);
  });

  it("keeps suppressing a rewrite revision that cannot be expressed as a suffix", () => {
    // A revision that REWRITES already-emitted content cannot be reconciled
    // in a delta stream (emitted text cannot be retracted) — the safe side is
    // suppression, as before.
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "First" }]),
      msg(4, "assistant", [{ type: "text", text: "Second" }]),
      msg(2, "assistant", [{ type: "text", text: "Rewritten" }]),
      status("waiting"),
    ]);
    expect(textBlocks(parts)).toEqual(["First", "Second"]);
  });
});

describe("TurnTranslator — deferred-revision flush at segment end (#78)", () => {
  it("flushes a deferred revision when the segment ends terminally without a settling snapshot", () => {
    // A same-id revision deferred behind the next step's open deltas is
    // normally drained by that step's settling snapshot. If the step instead
    // dies terminally (error mid-generation) WITHOUT committing, finish() is
    // the segment's last chance — chatd sent the revision once and will not
    // re-send it on a healthy connection.
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      part("assistant", { type: "text", text: "B" }), // next step's deltas, never committed
      msg(2, "assistant", [{ type: "text", text: "A+" }]), // mid-race revision, sent once
      status("error"), // terminal: no settling snapshot ever arrives
    ]);
    // The unclaimed next-step delta "B" stays in its block; the revision
    // suffix "+" lands bracketed at finish.
    expect(textBlocks(parts)).toEqual(["AB", "+"]);
  });

  it("flushes deferred revisions before the terminal error part, not only at finish", () => {
    // chatd's mid-generation failure arrives as an `error` EVENT (with the
    // terminal `status: error` batched behind it). doGenerate() throws on the
    // yielded error part and closes the generator before finish() can run
    // (see issue #72), so the flush must precede the error part within
    // ingest itself — parts yielded after it are never pulled.
    const t = new TurnTranslator({ dynamicToolNames: new Set() });
    const before = [
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      part("assistant", { type: "text", text: "B" }),
      msg(2, "assistant", [{ type: "text", text: "A+" }]), // mid-race revision: deferred
    ].flatMap((ev) => t.ingest(ev));
    const errParts = t.ingest({
      type: "error",
      chat_id: "c",
      error: { message: "overloaded", kind: "overloaded", retryable: true },
    });
    // The revision suffix "+" lands bracketed BEFORE the error part.
    expect(errParts.map((p) => p.type)).toEqual([
      "text-end",
      "text-start",
      "text-delta",
      "text-end",
      "error",
    ]);
    expect(textBlocks([...before, ...errParts])).toEqual(["AB", "+"]);
  });

  it("keeps suppressing a deferred rewrite at the terminal flush", () => {
    // Attribution care: at finish the pending deltas' owner never committed,
    // so the flush may emit only ledger-extension suffixes — a deferred
    // REWRITE ("X" does not extend "A") stays suppressed, exactly as it
    // would on the settled path.
    const { parts } = run([
      msg(2, "assistant", [{ type: "text", text: "A" }]),
      part("assistant", { type: "text", text: "B" }),
      msg(2, "assistant", [{ type: "text", text: "X" }]), // rewrite, deferred
      status("error"),
    ]);
    expect(textBlocks(parts)).toEqual(["AB"]);
  });
});

describe("TurnTranslator — multi-kind revision suffixes in wire order (#79)", () => {
  /** Kind-tagged delta sequence, for asserting cross-kind emission order. */
  const deltas = (parts: ReturnType<TurnTranslator["ingest"]>): string[] =>
    parts.flatMap((p) =>
      p.type === "text-delta" || p.type === "reasoning-delta"
        ? [`${p.type === "text-delta" ? "text" : "reasoning"}:${p.delta}`]
        : [],
    );

  it("emits an earlier-message revision's suffixes in wire-part order, not kind-grouped", () => {
    // Message 2 emitted [text "A", reasoning "R"]; a revision appends to BOTH
    // kinds: [text "AB", reasoning "RQ"]. The suffixes must surface in the
    // snapshot's wire order — "B" then "Q" — not reasoning-first.
    const { parts } = run([
      msg(2, "assistant", [
        { type: "text", text: "A" },
        { type: "reasoning", text: "R" },
      ]),
      msg(4, "assistant", [{ type: "text", text: "Second" }]),
      msg(2, "assistant", [
        { type: "text", text: "AB" },
        { type: "reasoning", text: "RQ" },
      ]),
      status("waiting"),
    ]);
    expect(deltas(parts)).toEqual([
      "text:A",
      "reasoning:R",
      "text:Second",
      "text:B",
      "reasoning:Q",
    ]);
    // The suffixes stay bracketed in their own blocks, outside "Second"'s.
    expect(textBlocks(parts)).toEqual(["A", "Second", "B"]);
  });

  it("emits a deferred multi-kind revision in wire order once the race settles", () => {
    // The deferred-revision drain reconciles through the same path, so a
    // revision cached during a delta race must also keep wire-part order.
    const { parts } = run([
      msg(2, "assistant", [
        { type: "text", text: "A" },
        { type: "reasoning", text: "R" },
      ]),
      part("assistant", { type: "text", text: "B" }), // next step's deltas open
      msg(2, "assistant", [
        { type: "text", text: "A2" },
        { type: "reasoning", text: "RQ" },
      ]), // mid-race revision: deferred
      msg(4, "assistant", [{ type: "text", text: "B" }]), // settles the race
      status("waiting"),
    ]);
    expect(deltas(parts)).toEqual(["text:A", "reasoning:R", "text:B", "text:2", "reasoning:Q"]);
  });
});

describe("TurnTranslator — retained-stream replays (#44)", () => {
  it("clears a stale terminal status when a non-terminal transition follows", () => {
    // A stream retained across a client-tool pause can redial mid-resume:
    // the reconnect's status snapshot may still say `requires_action` from
    // the PREVIOUS segment's pause. The later `running` transition proves the
    // chat is generating again — the stale settle must not survive it, or the
    // segment loop would treat the whole resumed generation as post-settle.
    const t = new TurnTranslator({ dynamicToolNames: new Set() });
    t.ingest(status("requires_action"));
    expect(t.terminalStatus).toBe("requires_action");
    t.ingest(status("running"));
    expect(t.terminalStatus).toBeUndefined();
    t.ingest(status("waiting"));
    expect(t.terminalStatus).toBe("waiting");
  });

  it("suppresses replayed action_required calls whose results were already submitted", () => {
    // A redial while the chat is still flipping out of requires_action can
    // replay the previous segment's `action_required`; re-emitting a call the
    // session already answered would make the AI SDK run the tool twice.
    const t = new TurnTranslator({
      dynamicToolNames: new Set(["myTool"]),
      submittedToolCallIds: new Set(["tc-answered"]),
    });
    const parts = t.ingest({
      type: "action_required",
      chat_id: "c",
      action_required: {
        tool_calls: [
          { tool_call_id: "tc-answered", tool_name: "myTool", args: "{}" },
          { tool_call_id: "tc-new", tool_name: "myTool", args: "{}" },
        ],
      },
    });
    const calls = parts.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolCallId: "tc-new" });
  });
});
