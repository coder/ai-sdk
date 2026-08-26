import { describe, expect, it } from "vitest";
import type { CoderChatClient } from "../../src/coder/client.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import type { Chat, ChatMessage, ChatMessagePart, ChatStreamEvent } from "../../src/coder/types.js";

/** A minimal scripted stand-in for {@link CoderChatClient} (single turn). */
class FakeClient {
  #events: ChatStreamEvent[];

  constructor(events: ChatStreamEvent[]) {
    this.#events = events;
  }

  async resolveModelConfigId(): Promise<string | undefined> {
    return undefined;
  }

  async createChat(): Promise<Chat> {
    return {
      id: "chat-1",
      organization_id: "org-1",
      owner_id: "u",
      title: "t",
      status: "running",
      created_at: "",
      updated_at: "",
      archived: false,
    };
  }

  async interruptChat(): Promise<Chat> {
    throw new Error("not used");
  }

  async *streamEvents(): AsyncGenerator<ChatStreamEvent, void, void> {
    for (const ev of this.#events) {
      await Promise.resolve();
      yield ev;
    }
  }
}

function msg(
  id: number,
  role: ChatMessage["role"],
  content: ChatMessagePart[],
  usage?: ChatMessage["usage"],
): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "chat-1",
    message: { id, chat_id: "chat-1", role, created_at: "", content, usage },
  };
}
function part(p: ChatMessagePart): ChatStreamEvent {
  return { type: "message_part", chat_id: "chat-1", message_part: { role: "assistant", part: p } };
}
function status(s: string): ChatStreamEvent {
  return { type: "status", chat_id: "chat-1", status: { status: s as never } };
}

function makeModel(events: ChatStreamEvent[]): CoderLanguageModel {
  return new CoderLanguageModel({
    client: new FakeClient(events) as unknown as CoderChatClient,
    organizationId: "org-1",
  });
}

/**
 * A server-tool turn whose final text streams via deltas and is then finalized
 * by a trailing snapshot — the shape that used to duplicate text — plus a
 * source part and cost-bearing usage.
 */
const serverToolTurn: ChatStreamEvent[] = [
  status("running"),
  // chatd attaches per-step usage to EVERY assistant message it commits; the
  // turn's usage is the sum, not the last message's.
  msg(
    2,
    "assistant",
    [{ type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } }],
    { input_tokens: 8, output_tokens: 2, total_cost_micros: 100, total_runtime_ms: 1000 },
  ),
  msg(3, "tool", [
    { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
  ]),
  part({ type: "source", source_id: "src-1", url: "https://example.com/a", title: "A" }),
  part({ type: "text", text: "Done" }),
  msg(
    4,
    "assistant",
    [
      { type: "source", source_id: "src-1", url: "https://example.com/a", title: "A" },
      { type: "text", text: "Done" },
    ],
    { input_tokens: 10, output_tokens: 3, total_cost_micros: 1234, total_runtime_ms: 5678 },
  ),
  status("waiting"),
];

describe("CoderLanguageModel.doGenerate aggregation", () => {
  it("aggregates a streamed turn once: deduped text, source content, provider metadata", async () => {
    const model = makeModel(serverToolTurn);
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    // The trailing snapshot must not duplicate the delta-streamed text.
    expect(result.content.filter((c) => c.type === "text")).toEqual([
      { type: "text", text: "Done" },
    ]);
    // Source parts land in the generate() content (once).
    expect(result.content.filter((c) => c.type === "source")).toEqual([
      { type: "source", sourceType: "url", id: "src-1", url: "https://example.com/a", title: "A" },
    ]);
    // The finish part's provider metadata and raw usage flow into the result,
    // summed across both committed steps.
    expect(result.providerMetadata).toEqual({
      coder: { total_cost_micros: 1334, total_runtime_ms: 6678 },
    });
    expect(result.usage.inputTokens.total).toBe(18);
    expect(result.usage.outputTokens.total).toBe(5);
    expect(result.usage.raw).toEqual({
      input_tokens: 18,
      output_tokens: 5,
      total_cost_micros: 1334,
      total_runtime_ms: 6678,
    });
  });

  it("omits providerMetadata when the server sends no cost fields (old servers)", async () => {
    const model = makeModel([
      status("running"),
      msg(2, "assistant", [{ type: "text", text: "Hi" }], { input_tokens: 10, output_tokens: 3 }),
      status("waiting"),
    ]);
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    expect(result.providerMetadata).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("streams source parts via doStream", async () => {
    const model = makeModel(serverToolTurn);
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    const parts: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const sources = parts.filter((p) => (p as { type: string }).type === "source");
    expect(sources).toEqual([
      { type: "source", sourceType: "url", id: "src-1", url: "https://example.com/a", title: "A" },
    ]);
  });
});

describe("CoderLanguageModel resume cursor validation (#115)", () => {
  const config = (overrides: Record<string, unknown>) =>
    ({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
      ...overrides,
    }) as never;

  it("rejects a cursor without its chat id", () => {
    expect(() => new CoderLanguageModel(config({ lastSeenMessageId: 40 }))).toThrow(
      /requires chatId/,
    );
  });

  it("rejects non-positive and non-integer cursors (0 is the internal sentinel)", () => {
    for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new CoderLanguageModel(config({ chatId: "chat-1", lastSeenMessageId: bad })),
      ).toThrow(/positive integer/);
    }
  });

  it("accepts a valid pair and exposes it via the getter", () => {
    const model = new CoderLanguageModel(config({ chatId: "chat-1", lastSeenMessageId: 40 }));
    expect(model.lastSeenMessageId).toBe(40);
    // resetSession drops the cursor with the session.
    model.resetSession();
    expect(model.lastSeenMessageId).toBeUndefined();
  });

  it("exposes undefined before any turn on a fresh model", () => {
    const model = new CoderLanguageModel(config({}));
    expect(model.lastSeenMessageId).toBeUndefined();
  });
});
