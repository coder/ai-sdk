import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CoderChatClient } from "../../src/coder/client.js";
import type { Chat, ChatMessage, ChatMessagePart, ChatStreamEvent } from "../../src/coder/types.js";
import { CoderAgent } from "../../src/index.js";

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
function status(s: string): ChatStreamEvent {
  return { type: "status", chat_id: "chat-1", status: { status: s as never } };
}

/**
 * Scripted client that serves one event segment per `streamEvents` call — a
 * turn that pauses for a client tool spans two segments (two doStream calls).
 */
class FakeClient {
  #segments: ChatStreamEvent[][];
  #call = 0;

  constructor(segments: ChatStreamEvent[][]) {
    this.#segments = segments;
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

  async submitToolResults(): Promise<void> {}

  async interruptChat(): Promise<Chat> {
    throw new Error("not used");
  }

  async *streamEvents(): AsyncGenerator<ChatStreamEvent, void, void> {
    const events = this.#segments[this.#call++] ?? [];
    for (const ev of events) {
      await Promise.resolve();
      yield ev;
    }
  }
}

// Segment 1: a server-tool step, then a step that requests the client tool.
// Mirrors the real protocol: every committed assistant message carries that
// step's usage, and chatd normalizes `input_tokens` to the UNCACHED count.
const segment1: ChatStreamEvent[] = [
  status("running"),
  msg(1, "user", [{ type: "text", text: "hi" }]),
  msg(
    2,
    "assistant",
    [{ type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } }],
    { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 800, total_cost_micros: 100 },
  ),
  msg(3, "tool", [
    { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
  ]),
  msg(
    4,
    "assistant",
    [{ type: "tool-call", tool_call_id: "c1", tool_name: "getWeather", args: { city: "Paris" } }],
    { input_tokens: 1100, output_tokens: 40, total_cost_micros: 110 },
  ),
  status("requires_action"),
  {
    type: "action_required",
    chat_id: "chat-1",
    action_required: {
      tool_calls: [{ tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' }],
    },
  },
];

// Segment 2 (resume after the tool result): the final text step.
const segment2: ChatStreamEvent[] = [
  status("running"),
  msg(5, "tool", [
    { type: "tool-result", tool_call_id: "c1", tool_name: "getWeather", result: { temp: 21 } },
  ]),
  msg(6, "assistant", [{ type: "text", text: "It is 21C in Paris." }], {
    input_tokens: 1200,
    output_tokens: 30,
    cache_read_tokens: 1000,
    total_cost_micros: 120,
    context_limit: 200000,
  }),
  status("waiting"),
];

describe("CoderAgent.generate — turn usage", () => {
  it("reports the whole turn's token consumption (all steps, cache included)", async () => {
    const agent = new CoderAgent({
      client: new FakeClient([segment1, segment2]) as unknown as CoderChatClient,
      organizationId: "org-1",
      tools: {
        getWeather: tool({
          description: "Get weather",
          inputSchema: z.object({ city: z.string() }),
          execute: async () => ({ temp: 21 }),
        }),
      },
    });

    const result = await agent.generate({ prompt: "hi" });

    expect(result.text).toBe("It is 21C in Paris.");
    expect(result.finishReason).toBe("stop");
    expect(result.steps).toHaveLength(2);

    // Turn totals across all three model steps: full prompt size (uncached +
    // cache reads), not the near-zero uncached count of the last step only.
    expect(result.usage.inputTokens).toBe(1000 + 1100 + 1200 + 800 + 1000);
    expect(result.usage.outputTokens).toBe(50 + 40 + 30);
    expect(result.usage.inputTokenDetails.noCacheTokens).toBe(3300);
    expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(1800);

    // Per-segment cost sums the segment's steps (100+110, then 120).
    expect(result.steps.map((s) => s.providerMetadata?.coder)).toEqual([
      { total_cost_micros: 210 },
      { total_cost_micros: 120 },
    ]);
  });
});
