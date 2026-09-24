import type {
  Chat,
  ChatMessage,
  ChatMessagePart,
  ChatStreamEvent,
  CoderChatClient,
  CreateChatMessageRequest,
  CreateChatRequest,
  SubmitToolResultsRequest,
} from "@coder/ai-sdk-agent";
import { CoderApiError } from "@coder/ai-sdk-agent";
import * as AiError from "@effect/ai/AiError";
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Prompt from "@effect/ai/Prompt";
import * as Tool from "@effect/ai/Tool";
import * as Toolkit from "@effect/ai/Toolkit";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import * as CoderAgentModel from "../src/agent-model.js";
import * as CoderLanguageModelGen from "../src/language-model.js";
import { classifyError, isTransient } from "../src/errors.js";

const CHAT = "chat-1";

const status = (value: string): ChatStreamEvent => ({
  type: "status",
  chat_id: CHAT,
  status: { status: value as never },
});
const delta = (part: ChatMessagePart): ChatStreamEvent => ({
  type: "message_part",
  chat_id: CHAT,
  message_part: { role: "assistant", part },
});
const message = (
  id: number,
  role: ChatMessage["role"],
  content: Array<ChatMessagePart>,
  usage?: ChatMessage["usage"],
): ChatStreamEvent => ({
  type: "message",
  chat_id: CHAT,
  message: { id, chat_id: CHAT, role, created_at: "", content, usage },
});
const chat = (id: string): Chat => ({
  id,
  organization_id: "org-1",
  owner_id: "u",
  title: "t",
  status: "running",
  created_at: "",
  updated_at: "",
  archived: false,
});

interface LiveStream {
  readonly queue: Array<ChatStreamEvent | "stall">;
  wake?: () => void;
}

/**
 * A scripted chatd client. Each dial (or tool-result submission on a live
 * socket) delivers the next scripted batch; a batch ending in `"stall"` then
 * waits until the stream is closed. Records every call the model makes.
 */
class FakeClient {
  readonly created: Array<CreateChatRequest> = [];
  readonly messages: Array<CreateChatMessageRequest> = [];
  readonly submitted: Array<SubmitToolResultsRequest> = [];
  readonly interrupted: Array<string> = [];
  readonly resolved: Array<string> = [];
  openStreams = 0;
  onStall: (() => void) | undefined;
  createChatError: Error | undefined;
  readonly #batches: Array<Array<ChatStreamEvent | "stall">>;
  #live: LiveStream | undefined;
  #nextId = 100;

  constructor(batches: Array<Array<ChatStreamEvent | "stall">>) {
    this.#batches = batches;
  }

  get asClient(): CoderChatClient {
    // SAFETY: the model only calls the methods implemented here.
    return this as unknown as CoderChatClient;
  }

  async resolveModelConfigId(model: string): Promise<string> {
    this.resolved.push(model);
    return `cfg-${model}`;
  }
  async createChat(req: CreateChatRequest): Promise<Chat> {
    if (this.createChatError) throw this.createChatError;
    this.created.push(req);
    return chat(CHAT);
  }
  async createChatMessage(_chatId: string, req: CreateChatMessageRequest) {
    this.messages.push(req);
    const id = ++this.#nextId;
    return { queued: false, message: { id, chat_id: CHAT, role: "user" as const, created_at: "" } };
  }
  async submitToolResults(_chatId: string, req: SubmitToolResultsRequest): Promise<void> {
    this.submitted.push(req);
    if (this.#live) {
      this.#live.queue.push(...(this.#batches.shift() ?? []));
      this.#live.wake?.();
    }
  }
  async getMessages() {
    return { messages: [], queued_messages: [], has_more: false };
  }
  async interruptChat(chatId: string): Promise<Chat> {
    this.interrupted.push(chatId);
    return chat(chatId);
  }
  streamEvents(_chatId: string, opts?: { signal?: AbortSignal }) {
    const live: LiveStream = {
      queue: [...(this.#batches.shift() ?? [])],
    };
    this.#live = live;
    this.openStreams += 1;
    return this.#deliver(live, opts?.signal);
  }
  async *#deliver(live: LiveStream, signal: AbortSignal | undefined) {
    try {
      while (!signal?.aborted) {
        const next = live.queue.shift();
        if (next === "stall") this.onStall?.();
        else if (next !== undefined) {
          await Promise.resolve();
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          live.wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      this.openStreams -= 1;
      if (this.#live === live) this.#live = undefined;
    }
  }
}

const run = <A, E>(
  fake: FakeClient,
  body: Effect.Effect<A, E, LanguageModel.LanguageModel>,
  settings: Partial<CoderAgentModel.AgentModelSettings> = {},
) =>
  Effect.runPromiseExit(
    body.pipe(
      Effect.provide(
        CoderAgentModel.layer({ client: fake.asClient, organizationId: "org-1", ...settings }),
      ),
    ),
  );

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail") return exit.cause.error;
  throw new Error(`expected a typed failure, got ${String(exit)}`);
};

const simpleTurn = (id: number, text: string) => [
  status("running"),
  delta({ type: "text", text }),
  message(id, "assistant", [{ type: "text", text }]),
  status("waiting"),
];

describe("CoderAgentModel", () => {
  it("streams text and reasoning through the TurnTranslator, then finish and usage", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        delta({ type: "reasoning", text: "Thinking." }),
        delta({ type: "text", text: "Hel" }),
        delta({ type: "text", text: "lo" }),
        message(
          2,
          "assistant",
          [
            { type: "reasoning", text: "Thinking." },
            { type: "text", text: "Hello" },
          ],
          { input_tokens: 12, output_tokens: 4 },
        ),
        status("waiting"),
      ],
    ]);

    const exit = await run(
      fake,
      Stream.runCollect(
        LanguageModel.streamText({
          prompt: Prompt.make([
            { role: "system", content: "Be brief." },
            { role: "user", content: "hi" },
          ]),
        }),
      ),
    );

    const parts = Chunk.toReadonlyArray(Exit.getOrElse(exit, () => Chunk.empty()));
    expect(parts.map((p) => p.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const finish = parts.at(-1);
    expect(finish?.type === "finish" && finish.reason).toBe("stop");
    expect(finish?.type === "finish" && finish.usage.inputTokens).toBe(12);
    expect(fake.created[0]?.system_prompt).toBe("Be brief.");
    expect(fake.interrupted).toEqual([]);
    expect(fake.openStreams).toBe(0);
  });

  it("resolves client tool calls with the toolkit and submits their results", async () => {
    const GetWeather = Tool.make("get_weather", {
      parameters: { city: Schema.String },
      success: Schema.Struct({ temperature: Schema.Number }),
    });
    const toolkit = Toolkit.make(GetWeather);
    const fake = new FakeClient([
      [
        status("running"),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: CHAT,
          action_required: {
            tool_calls: [
              { tool_call_id: "tc1", tool_name: "get_weather", args: '{"city":"Paris"}' },
            ],
          },
        },
      ],
      simpleTurn(3, "It is 21°C."),
    ]);

    const exit = await run(
      fake,
      Effect.gen(function* () {
        const first = yield* LanguageModel.generateText({ prompt: "weather?", toolkit });
        const prompt = Prompt.merge(
          Prompt.make("weather?"),
          Prompt.fromResponseParts(first.content),
        );
        const second = yield* LanguageModel.generateText({ prompt, toolkit });
        return [first, second] as const;
      }).pipe(
        Effect.provide(toolkit.toLayer({ get_weather: () => Effect.succeed({ temperature: 21 }) })),
      ),
    );

    const [first, second] = Exit.getOrElse(exit, () => {
      throw new Error(String(exit));
    });
    expect(first.toolCalls.map((c) => [c.name, c.params])).toEqual([
      ["get_weather", { city: "Paris" }],
    ]);
    expect(first.toolResults[0]?.result).toEqual({ temperature: 21 });
    expect(fake.created[0]?.unsafe_dynamic_tools?.map((t) => t.name)).toEqual(["get_weather"]);
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]?.results[0]?.tool_call_id).toBe("tc1");
    expect(second.text).toBe("It is 21°C.");
  });

  it("closes a stream paused for client tools when the scope closes", async () => {
    const Ping = Tool.make("ping", { success: Schema.String });
    const toolkit = Toolkit.make(Ping);
    const fake = new FakeClient([
      [
        status("running"),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: CHAT,
          action_required: { tool_calls: [{ tool_call_id: "tc1", tool_name: "ping", args: "{}" }] },
        },
      ],
    ]);

    const exit = await run(
      fake,
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "ping", toolkit });
        return fake.openStreams;
      }).pipe(Effect.provide(toolkit.toLayer({ ping: () => Effect.succeed("pong") }))),
    );

    // The paused socket survives the call and is closed by the layer's release.
    expect(Exit.getOrElse(exit, () => -1)).toBe(1);
    expect(fake.openStreams).toBe(0);
    expect(fake.interrupted).toEqual([]);
  });

  it("reports chatd server-side tools in finish metadata", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        message(2, "assistant", [
          { type: "tool-call", tool_call_id: "s1", tool_name: "execute", args: { command: "ls" } },
        ]),
        message(3, "tool", [
          { type: "tool-result", tool_call_id: "s1", tool_name: "execute", result: "a.txt" },
        ]),
        message(4, "assistant", [{ type: "text", text: "Done." }]),
        status("waiting"),
      ],
    ]);

    const exit = await run(fake, LanguageModel.generateText({ prompt: "ls" }));

    const response = Exit.getOrElse(exit, () => {
      throw new Error(String(exit));
    });
    expect(response.text).toBe("Done.");
    const finish = response.content.find((p) => p.type === "finish");
    expect(finish?.metadata).toEqual({
      coder: {
        serverToolCalls: [
          {
            id: "s1",
            name: "execute",
            params: { command: "ls" },
            result: "a.txt",
            isFailure: false,
          },
        ],
      },
    });
  });

  it("interrupts the chat exactly once when the consuming fiber is interrupted", async () => {
    const fake = new FakeClient([
      [status("running"), delta({ type: "text", text: "Wor" }), "stall"],
    ]);
    const stalled = new Promise<void>((resolve) => {
      fake.onStall = resolve;
    });

    const exit = await run(
      fake,
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Stream.runCollect(LanguageModel.streamText({ prompt: "hi" })),
        );
        yield* Effect.promise(() => stalled);
        yield* Fiber.interrupt(fiber);
        // Let the model's fire-and-forget interrupt and stream close settle.
        yield* Effect.sleep("20 millis");
        return { interrupted: [...fake.interrupted], open: fake.openStreams };
      }),
    );

    expect(Exit.getOrElse(exit, () => undefined)).toEqual({ interrupted: [CHAT], open: 0 });
    expect(fake.interrupted).toEqual([CHAT]);
  });

  it("maps a turn timeout to a transient timeout AiError and interrupts once", async () => {
    const fake = new FakeClient([[status("running"), "stall"]]);

    const exit = await run(fake, LanguageModel.generateText({ prompt: "hi" }), {
      requestTimeoutMs: 20,
    });

    const error = failure(exit);
    expect(AiError.isAiError(error)).toBe(true);
    expect(classifyError(error)).toBe("timeout");
    expect(isTransient(error)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.interrupted).toEqual([CHAT]);
    expect(fake.openStreams).toBe(0);
  });

  it("maps chat and API errors to classified AiErrors", async () => {
    const chatFailure = new FakeClient([
      [
        status("running"),
        {
          type: "error",
          chat_id: CHAT,
          error: { message: "overloaded", status_code: 529, retryable: true },
        },
        status("error"),
      ],
    ]);
    const streamed = failure(
      await run(chatFailure, Stream.runDrain(LanguageModel.streamText({ prompt: "hi" }))),
    );
    expect(streamed._tag).toBe("UnknownError");
    expect(classifyError(streamed)).toBe("provider-unavailable");
    expect(isTransient(streamed)).toBe(true);

    const denied = new FakeClient([]);
    denied.createChatError = new CoderApiError({
      status: 403,
      method: "POST",
      path: "/api/experimental/chats",
      message: "Forbidden",
    });
    const api = failure(await run(denied, LanguageModel.generateText({ prompt: "hi" })));
    expect(api._tag).toBe("HttpResponseError");
    expect(classifyError(api)).toBe("auth");
    expect(isTransient(api)).toBe(false);
  });

  it("rejects options chatd cannot honor with MalformedInput", async () => {
    const sampling = failure(
      await run(
        new FakeClient([]),
        LanguageModel.generateText({ prompt: "hi" }).pipe(
          CoderLanguageModelGen.withGenerationOptions({ temperature: 0 }),
        ),
      ),
    );
    expect(sampling._tag).toBe("MalformedInput");
    expect(sampling.description).toContain("temperature");

    const unknownOption = failure(
      await run(
        new FakeClient([]),
        LanguageModel.generateText({ prompt: "hi" }).pipe(
          CoderLanguageModelGen.withGenerationOptions({
            providerOptions: { coder: { mode: "x" } },
          }),
        ),
      ),
    );
    expect(unknownOption._tag).toBe("MalformedInput");

    const Ping = Tool.make("ping", { success: Schema.String });
    const toolkit = Toolkit.make(Ping);
    const toolChoice = failure(
      await run(
        new FakeClient([]),
        LanguageModel.generateText({ prompt: "hi", toolkit, toolChoice: "none" }).pipe(
          Effect.provide(toolkit.toLayer({ ping: () => Effect.succeed("pong") })),
        ),
      ),
    );
    expect(toolChoice._tag).toBe("MalformedInput");
    expect(toolChoice.description).toContain("tool choice");

    const structured = failure(
      await run(
        new FakeClient([]),
        LanguageModel.generateObject({ prompt: "hi", schema: Schema.Struct({ a: Schema.String }) }),
      ),
    );
    expect(structured._tag).toBe("MalformedInput");
    expect(structured.description).toContain("structured output");
  });

  it("rejects a toolkit change after the chat is created", async () => {
    const Ping = Tool.make("ping", { success: Schema.String });
    const toolkit = Toolkit.make(Ping);
    const fake = new FakeClient([simpleTurn(2, "one")]);

    const exit = await run(
      fake,
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "one", toolkit });
        return yield* LanguageModel.generateText({ prompt: "two" });
      }).pipe(Effect.provide(toolkit.toLayer({ ping: () => Effect.succeed("pong") }))),
    );

    const error = failure(exit);
    expect(error._tag).toBe("MalformedInput");
    expect(error.description).toContain("toolkit cannot change");
    expect(fake.created).toHaveLength(1);
    expect(fake.messages).toEqual([]);
  });

  it("applies per-call model and reasoning effort on the same chat", async () => {
    const fake = new FakeClient([
      simpleTurn(2, "one"),
      simpleTurn(102, "two"),
      simpleTurn(104, "three"),
    ]);

    const exit = await run(
      fake,
      Effect.gen(function* () {
        yield* LanguageModel.generateText({ prompt: "one" });
        yield* LanguageModel.generateText({ prompt: "two" }).pipe(
          CoderAgentModel.withAgentOptions({ model: "big", reasoningEffort: "high" }),
        );
        yield* LanguageModel.generateText({ prompt: "three" });
      }),
      { model: "small", reasoningEffort: "low" },
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      model_config_id: "cfg-small",
      reasoning_effort: "low",
    });
    expect(fake.messages).toEqual([
      expect.objectContaining({ model_config_id: "cfg-big", reasoning_effort: "high" }),
      expect.objectContaining({ model_config_id: "cfg-small", reasoning_effort: "low" }),
    ]);
  });

  it("refuses to change agent options while submitting tool results", async () => {
    const fake = new FakeClient([]);
    const prompt = Prompt.make([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [{ type: "tool-call", id: "tc1", name: "get_weather", params: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "tc1",
            name: "get_weather",
            result: 1,
            isFailure: false,
            providerExecuted: false,
          },
        ],
      },
    ]);
    const error = failure(
      await run(
        fake,
        LanguageModel.generateText({ prompt }).pipe(
          CoderAgentModel.withAgentOptions({ model: "big" }),
        ),
      ),
    );
    expect(error._tag).toBe("MalformedInput");
    expect(fake.submitted).toEqual([]);
  });

  it("does not record the toolkit of a call it rejects", async () => {
    const Ping = Tool.make("ping", { success: Schema.String });
    const toolkit = Toolkit.make(Ping);
    const fake = new FakeClient([simpleTurn(2, "ok")]);
    const resume = Prompt.make([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", id: "tc1", name: "ping", params: {} }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "tc1",
            name: "ping",
            result: "pong",
            isFailure: false,
            providerExecuted: false,
          },
        ],
      },
    ]);

    const exit = await run(
      fake,
      Effect.gen(function* () {
        const rejected = yield* Effect.either(
          LanguageModel.generateText({ prompt: resume, toolkit }).pipe(
            CoderAgentModel.withAgentOptions({ model: "big" }),
          ),
        );
        // The corrected call registers no toolkit and must not be refused.
        const next = yield* LanguageModel.generateText({ prompt: "again" });
        return [rejected._tag, next.text] as const;
      }).pipe(Effect.provide(toolkit.toLayer({ ping: () => Effect.succeed("pong") }))),
      { chatId: CHAT },
    );

    expect(Exit.getOrElse(exit, () => undefined)).toEqual(["Left", "ok"]);
    expect(fake.submitted).toEqual([]);
  });
});
