import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CoderChatClient } from "../../src/coder/client.js";
import { CoderAgent } from "../../src/agent/coder-agent.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import type {
  Chat,
  ChatStreamEvent,
  CreateChatMessageResponse,
  CreateChatRequest,
  SubmitToolResultsRequest,
} from "../../src/coder/types.js";

/** A scripted, in-memory stand-in for {@link CoderChatClient}. */
class FakeClient {
  turns: ChatStreamEvent[][];
  #turnIndex = 0;
  createdChats: CreateChatRequest[] = [];
  submitted: SubmitToolResultsRequest[] = [];
  #nextMessageId = 1000;

  constructor(turns: ChatStreamEvent[][]) {
    this.turns = turns;
  }

  async resolveModelConfigId(): Promise<string | undefined> {
    return undefined;
  }

  async createChat(req: CreateChatRequest): Promise<Chat> {
    this.createdChats.push(req);
    return {
      id: "chat-1",
      organization_id: req.organization_id,
      owner_id: "u",
      title: "t",
      status: "running",
      created_at: "",
      updated_at: "",
      archived: false,
    };
  }

  async createChatMessage(): Promise<CreateChatMessageResponse> {
    return {
      queued: false,
      message: { id: ++this.#nextMessageId, chat_id: "chat-1", role: "user", created_at: "" },
    };
  }

  async submitToolResults(_chatId: string, req: SubmitToolResultsRequest): Promise<void> {
    this.submitted.push(req);
  }

  async *streamEvents(): AsyncGenerator<ChatStreamEvent, void, void> {
    const events = this.turns[this.#turnIndex++] ?? [];
    for (const ev of events) {
      // Simulate async delivery.
      await Promise.resolve();
      yield ev;
    }
  }

  async archiveChat(): Promise<void> {}
  async interruptChat(): Promise<Chat> {
    throw new Error("not used");
  }
}

function msg(
  id: number,
  role: "user" | "assistant" | "tool",
  content: { type: string; text?: string }[],
): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "chat-1",
    message: { id, chat_id: "chat-1", role, created_at: "", content: content as never },
  };
}
function textPart(text: string): ChatStreamEvent {
  return {
    type: "message_part",
    chat_id: "chat-1",
    message_part: { role: "assistant", part: { type: "text", text } },
  };
}
function status(s: string): ChatStreamEvent {
  return { type: "status", chat_id: "chat-1", status: { status: s as never } };
}

function makeAgent<T extends Record<string, unknown>>(fake: FakeClient, tools?: T) {
  return new CoderAgent({
    client: fake as unknown as CoderChatClient,
    organizationId: "org-1",
    instructions: "be helpful",
    ...(tools ? { tools: tools as never } : {}),
  });
}

describe("CoderAgent integration (mock client)", () => {
  it("generates plain text over one turn", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("Hello!"),
        msg(2, "assistant", [{ type: "text", text: "Hello!" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);
    const result = await agent.generate({ prompt: "hi" });

    expect(result.text).toBe("Hello!");
    expect(result.steps).toHaveLength(1);
    expect(agent.chatId).toBe("chat-1");
    expect(fake.createdChats).toHaveLength(1);
    expect(fake.createdChats[0]?.system_prompt).toBe("be helpful");
    expect(fake.createdChats[0]?.client_type).toBe("api");
  });

  it("runs a custom tool round-trip: action_required → execute → submit results → resume", async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
    const tools = {
      getWeather: tool({
        description: "Get the weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute,
      }),
    };

    const fake = new FakeClient([
      // Turn 1: assistant says it will check, then requests the client tool.
      // NOTE: chatd emits the `requires_action` status BEFORE the
      // `action_required` event (matching real wire order) — this guards the
      // model loop against breaking before the tool calls arrive.
      [
        status("running"),
        textPart("Checking the weather."),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: "chat-1",
          action_required: {
            tool_calls: [
              { tool_call_id: "tc1", tool_name: "getWeather", args: '{"city":"Paris"}' },
            ],
          },
        },
      ],
      // Turn 2: after results are submitted, assistant produces the final text.
      [
        status("running"),
        textPart("It's 21°C in Paris."),
        msg(3, "assistant", [{ type: "text", text: "It's 21°C in Paris." }]),
        status("waiting"),
      ],
    ]);

    const agent = makeAgent(fake, tools);
    const result = await agent.generate({ prompt: "weather in Paris?" });

    // The tool executed with the parsed args.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ city: "Paris" });

    // Results were submitted back to chatd with the chatd-issued tool_call_id.
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]?.results[0]?.tool_call_id).toBe("tc1");
    expect(fake.submitted[0]?.results[0]?.is_error).toBe(false);

    // Two steps: the tool turn and the final answer turn.
    expect(result.steps).toHaveLength(2);
    expect(result.text).toContain("21");

    // The custom tool was registered as a chatd dynamic tool at chat creation.
    expect(fake.createdChats[0]?.unsafe_dynamic_tools?.map((t) => t.name)).toEqual(["getWeather"]);
  });

  it("streams text deltas via stream()", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("a"),
        textPart("b"),
        textPart("c"),
        msg(2, "assistant", [{ type: "text", text: "abc" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);
    const result = await agent.stream({ prompt: "spell it" });

    let streamed = "";
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe("abc");
    expect(await result.text).toBe("abc");
  });
});

describe("CoderLanguageModel guards", () => {
  it("throws on a prompt with no user message or tool results", async () => {
    const model = new CoderLanguageModel({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    } as never);
    const reader = stream.getReader();
    await reader.read(); // stream-start
    await expect(reader.read()).rejects.toThrow(/no user message or tool results/);
  });

  it("rejects concurrent turns on one instance (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking = {
      resolveModelConfigId: async () => undefined,
      createChat: async () => ({
        id: "c1",
        organization_id: "o",
        owner_id: "u",
        title: "t",
        status: "running",
        created_at: "",
        updated_at: "",
        archived: false,
      }),
      // Yields one non-terminal event then blocks (on a releasable gate),
      // keeping turn 1 in-flight while we attempt a concurrent turn 2.
      streamEvents: async function* () {
        yield status("running");
        await gate;
      },
    };
    const model = new CoderLanguageModel({
      client: blocking as unknown as CoderChatClient,
      organizationId: "o",
    });

    const s1 = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    const r1 = s1.stream.getReader();
    await r1.read(); // starts turn 1 → sets in-flight

    const s2 = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi2" }] }],
    } as never);
    const r2 = s2.stream.getReader();
    await expect(r2.read()).rejects.toThrow(/single-flight/);

    release(); // let turn 1 unblock so cleanup completes
    await r1.cancel();
  }, 10_000);
});
