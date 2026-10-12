import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import * as AiError from "effect/ai/AiError";
import type * as LanguageModel from "effect/ai/LanguageModel";
import type * as Prompt from "effect/ai/Prompt";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { classifyError } from "../src/errors.js";
import * as CoderLanguageModel from "../src/language-model.js";
import { failure } from "./exit.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

// Provider-shaped raw usage. `undefined` values are allowed by the AI SDK's
// `JSONObject` but are not JSON, so the finish metadata drops them.
const RAW_USAGE = {
  input_tokens: 8,
  cache_read_tokens: 2,
  total_cost_micros: 1234,
  details: { tier: "standard", unset: undefined },
};
const RAW_USAGE_JSON = {
  input_tokens: 8,
  cache_read_tokens: 2,
  total_cost_micros: 1234,
  details: { tier: "standard" },
};

const fakeModel = (overrides: Partial<LanguageModelV4>): LanguageModelV4 => ({
  specificationVersion: "v4",
  provider: "coder",
  modelId: "fake-model",
  supportedUrls: {},
  doGenerate: () => {
    throw new Error("doGenerate not stubbed");
  },
  doStream: () => {
    throw new Error("doStream not stubbed");
  },
  ...overrides,
});

const service = (model: LanguageModelV4): Effect.Effect<LanguageModel.LanguageModel> =>
  CoderLanguageModel.fromModel(model);

const streamOf = (parts: ReadonlyArray<LanguageModelV4StreamPart>) =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

describe("generateText", () => {
  it("maps a text response, finish reason, and usage", async () => {
    let captured: LanguageModelV4CallOptions | undefined;
    const model = fakeModel({
      doGenerate: async (options) => {
        captured = options;
        return {
          content: [{ type: "text", text: "Hello from the gateway" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE,
          warnings: [],
          response: { id: "resp_1", modelId: "gpt-test" },
        };
      },
    });

    const response = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => m.generateText({ prompt: "Say hello" })),
    );

    expect(response.text).toBe("Hello from the gateway");
    expect(response.finishReason).toBe("stop");
    expect(response.usage.inputTokens).toEqual({
      uncached: 8,
      total: 10,
      cacheRead: 2,
      cacheWrite: undefined,
    });
    expect(response.usage.outputTokens).toEqual({ total: 5, text: 5, reasoning: undefined });
    // No raw usage from the provider: no `metadata.coder` on the finish part.
    const finish = response.content.find((part) => part.type === "finish");
    expect(finish?.metadata).toEqual({});
    expect(captured?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Say hello" }] },
    ]);
  });

  it("maps system/user/assistant/tool messages onto the spec prompt", async () => {
    let captured: LanguageModelV4CallOptions | undefined;
    const model = fakeModel({
      doGenerate: async (options) => {
        captured = options;
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const messages: Array<Prompt.MessageEncoded> = [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "What is the weather in Berlin?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "User wants weather." },
          {
            type: "tool-call",
            id: "call_1",
            name: "get_weather",
            params: { city: "Berlin" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "get_weather",
            isFailure: false,
            result: { temperature: 21 },
            providerExecuted: false,
          },
        ],
      },
    ];

    await Effect.runPromise(
      Effect.flatMap(service(model), (m) => m.generateText({ prompt: messages })),
    );

    expect(captured?.prompt).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "What is the weather in Berlin?" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "User wants weather." },
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "get_weather",
            input: { city: "Berlin" },
            providerExecuted: false,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "get_weather",
            output: { type: "json", value: { temperature: 21 } },
          },
        ],
      },
    ]);
  });

  it("sends tool definitions as JSON schema and resolves tool calls", async () => {
    const GetWeather = Tool.make("get_weather", {
      description: "Look up the current weather",
      parameters: Schema.Struct({ city: Schema.String }),
      success: Schema.Struct({ temperature: Schema.Number }),
    });
    const toolkit = Toolkit.make(GetWeather);

    let captured: LanguageModelV4CallOptions | undefined;
    const model = fakeModel({
      doGenerate: async (options) => {
        captured = options;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "get_weather",
              input: `{"city":"Berlin"}`,
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const response = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => m.generateText({ prompt: "weather?", toolkit })).pipe(
        Effect.provide(
          toolkit.toLayer({
            get_weather: ({ city }) => Effect.succeed({ temperature: city === "Berlin" ? 21 : 0 }),
          }),
        ),
      ),
    );

    expect(captured?.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Look up the current weather",
        inputSchema: {
          type: "object",
          required: ["city"],
          properties: { city: { type: "string" } },
          additionalProperties: true,
        },
      },
    ]);
    expect(captured?.toolChoice).toEqual({ type: "auto" });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolResults).toHaveLength(1);
    expect(response.toolResults[0]?.result).toEqual({ temperature: 21 });
  });

  it("forwards generation controls to the underlying model", async () => {
    let captured: LanguageModelV4CallOptions | undefined;
    const model = fakeModel({
      doGenerate: async (options) => {
        captured = options;
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    await Effect.runPromise(
      Effect.flatMap(
        CoderLanguageModel.fromModel(model, {
          maxOutputTokens: 128,
          temperature: 0,
          topP: 0.9,
          stopSequences: ["END"],
          seed: 42,
        }),
        (m) => m.generateText({ prompt: "hi" }),
      ),
    );

    expect(captured?.maxOutputTokens).toBe(128);
    expect(captured?.temperature).toBe(0);
    expect(captured?.topP).toBe(0.9);
    expect(captured?.stopSequences).toEqual(["END"]);
    expect(captured?.seed).toBe(42);
  });

  it("applies per-call overrides over construction options, innermost first", async () => {
    const captured: Array<LanguageModelV4CallOptions> = [];
    const model = fakeModel({
      doGenerate: async (options) => {
        captured.push(options);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const m = yield* CoderLanguageModel.fromModel(model, { temperature: 1, seed: 7 });
        yield* m.generateText({ prompt: "plain" });
        yield* m
          .generateText({ prompt: "outer" })
          .pipe(CoderLanguageModel.withGenerationOptions({ temperature: 0, topP: 0.5 }));
        yield* m.generateText({ prompt: "nested" }).pipe(
          CoderLanguageModel.withGenerationOptions({
            topP: 0.1,
            providerOptions: { coder: { note: "x" } },
          }),
          CoderLanguageModel.withGenerationOptions({ temperature: 0, topP: 0.5 }),
        );
      }),
    );

    expect(captured.map((o) => [o.temperature, o.topP, o.seed, o.providerOptions])).toEqual([
      [1, undefined, 7, undefined],
      [0, 0.5, 7, undefined],
      [0, 0.1, 7, { coder: { note: "x" } }],
    ]);
  });

  it("moves provider-executed tool activity outside the toolkit to finish metadata", async () => {
    const model = fakeModel({
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Listed the files." },
          {
            type: "tool-call",
            toolCallId: "srv_1",
            toolName: "execute",
            input: `{"command":"ls"}`,
            providerExecuted: true,
          },
          { type: "tool-result", toolCallId: "srv_1", toolName: "execute", result: "a.txt" },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
    });

    const response = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => m.generateText({ prompt: "ls" })),
    );

    expect(response.text).toBe("Listed the files.");
    expect(response.toolCalls).toHaveLength(0);
    const finish = response.content.find((part) => part.type === "finish");
    expect(finish?.metadata).toEqual({
      coder: {
        serverToolCalls: [
          {
            id: "srv_1",
            name: "execute",
            params: { command: "ls" },
            result: "a.txt",
            isFailure: false,
          },
        ],
      },
    });
  });

  it("carries the provider's raw usage as finish metadata.coder.rawUsage", async () => {
    const model = fakeModel({
      doGenerate: async () => ({
        content: [
          { type: "text", text: "Listed the files." },
          {
            type: "tool-call",
            toolCallId: "srv_1",
            toolName: "execute",
            input: `{"command":"ls"}`,
            providerExecuted: true,
          },
          { type: "tool-result", toolCallId: "srv_1", toolName: "execute", result: "a.txt" },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: { ...USAGE, raw: RAW_USAGE },
        warnings: [],
      }),
    });

    const response = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => m.generateText({ prompt: "ls" })),
    );

    const finish = response.content.find((part) => part.type === "finish");
    expect(finish?.metadata).toEqual({
      coder: {
        rawUsage: RAW_USAGE_JSON,
        serverToolCalls: [
          {
            id: "srv_1",
            name: "execute",
            params: { command: "ls" },
            result: "a.txt",
            isFailure: false,
          },
        ],
      },
    });
  });

  describe("tool choice", () => {
    const GetWeather = Tool.make("get_weather", {
      parameters: Schema.Struct({ city: Schema.String }),
      success: Schema.Struct({ temperature: Schema.Number }),
    });
    const GetTime = Tool.make("get_time", { success: Schema.String });
    const toolkit = Toolkit.make(GetWeather, GetTime);
    const handlers = toolkit.toLayer({
      get_weather: () => Effect.succeed({ temperature: 0 }),
      get_time: () => Effect.succeed("noon"),
    });
    const capture = () => {
      const calls: Array<LanguageModelV4CallOptions> = [];
      const model = fakeModel({
        doGenerate: async (options) => {
          calls.push(options);
          return {
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: USAGE,
            warnings: [],
          };
        },
      });
      return { calls, model };
    };

    it("forwards the no-toolkit default even without tools", async () => {
      const { calls, model } = capture();
      await Effect.runPromise(
        Effect.flatMap(service(model), (m) => m.generateText({ prompt: "x" })),
      );
      expect(calls[0]?.tools).toBeUndefined();
      expect(calls[0]?.toolChoice).toEqual({ type: "none" });
    });

    it("maps oneOf to its mode over the narrowed tools", async () => {
      const { calls, model } = capture();
      await Effect.runPromise(
        Effect.flatMap(service(model), (m) =>
          m.generateText({
            prompt: "weather?",
            toolkit,
            toolChoice: { mode: "required", oneOf: ["get_weather" as const] },
          }),
        ).pipe(Effect.provide(handlers)),
      );
      expect(calls[0]?.tools?.map((tool) => tool.name)).toEqual(["get_weather"]);
      expect(calls[0]?.toolChoice).toEqual({ type: "required" });
    });

    it("rejects a required tool call when no tool is left to call", async () => {
      const { calls, model } = capture();
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(service(model), (m) =>
          m.generateText({ prompt: "x", toolkit, toolChoice: { mode: "required", oneOf: [] } }),
        ).pipe(Effect.provide(handlers)),
      );
      const error = failure(exit);
      expect(error.reason._tag).toBe("InvalidRequestError");
      expect(error.message).toContain("needs at least one tool");
      expect(calls).toHaveLength(0);
    });
  });

  it("fails with InvalidOutputError when tool call arguments are not JSON", async () => {
    const model = fakeModel({
      doGenerate: async () => ({
        content: [
          { type: "tool-call", toolCallId: "call_1", toolName: "broken", input: "{not json" },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: USAGE,
        warnings: [],
      }),
    });

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(service(model), (m) =>
        m.generateText({ prompt: "x", disableToolCallResolution: true }),
      ),
    );

    expect(failure(exit).reason._tag).toBe("InvalidOutputError");
  });

  it("maps HTTP failures to the typed AiError taxonomy", async () => {
    const failWith = (statusCode?: number) =>
      fakeModel({
        doGenerate: async () => {
          throw new APICallError({
            message: "failed",
            url: "https://coder.example.com/gateway",
            requestBodyValues: {},
            statusCode,
            responseBody: "denied",
          });
        },
      });

    const run = (statusCode?: number) =>
      Effect.runPromiseExit(
        Effect.flatMap(service(failWith(statusCode)), (m) => m.generateText({ prompt: "x" })),
      );

    const auth = failure(await run(401));
    expect(auth.reason._tag).toBe("AuthenticationError");
    expect(classifyError(auth)).toBe("auth");

    expect(classifyError(failure(await run(429)))).toBe("rate-limit");
    expect(classifyError(failure(await run(402)))).toBe("quota");

    const network = failure(await run(undefined));
    expect(network.reason._tag).toBe("NetworkError");
    expect(classifyError(network)).toBe("transport");
  });
});

describe("generateObject", () => {
  it("passes the JSON response format and decodes the value", async () => {
    let captured: LanguageModelV4CallOptions | undefined;
    const model = fakeModel({
      doGenerate: async (options) => {
        captured = options;
        return {
          content: [{ type: "text", text: `{"city":"Berlin","temperature":21}` }],
          finishReason: { unified: "stop", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const Weather = Schema.Struct({ city: Schema.String, temperature: Schema.Finite });
    const response = await Effect.runPromise(
      Effect.flatMap(service(model), (m) =>
        m.generateObject({ prompt: "weather in berlin", schema: Weather, objectName: "weather" }),
      ),
    );

    expect(response.value).toEqual({ city: "Berlin", temperature: 21 });
    expect(captured?.responseFormat).toEqual({
      type: "json",
      name: "weather",
      schema: {
        type: "object",
        required: ["city", "temperature"],
        properties: { city: { type: "string" }, temperature: { type: "number" } },
        additionalProperties: true,
      },
    });
    // Schema-less JSON modes (e.g. OpenAI json_object) need the instruction.
    const first = captured?.prompt[0];
    expect(first?.role).toBe("system");
    if (first?.role === "system") {
      expect(first.content).toContain("JSON schema:");
      expect(first.content).toContain(`"city"`);
    }
  });
});

describe("streamText", () => {
  it("maps stream parts onto effect/ai stream parts", async () => {
    const model = fakeModel({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "resp_1", modelId: "gpt-test" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hel" },
          { type: "text-delta", id: "t1", delta: "lo" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
        ]),
      }),
    });

    const parts = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => Stream.runCollect(m.streamText({ prompt: "hi" }))),
    );

    const types = parts.map((part) => part.type);
    expect(types).toEqual([
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
    expect(text).toBe("Hello");
  });

  it("streams server tool markers and reports server tool calls on finish", async () => {
    const model = fakeModel({
      doStream: async () => ({
        stream: streamOf([
          { type: "tool-input-start", id: "srv_1", toolName: "execute", providerExecuted: true },
          { type: "tool-input-end", id: "srv_1" },
          {
            type: "tool-call",
            toolCallId: "srv_1",
            toolName: "execute",
            input: `{"command":"false"}`,
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "srv_1",
            toolName: "execute",
            result: "exit 1",
            isError: true,
          },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
        ]),
      }),
    });

    const parts = await Effect.runPromise(
      Effect.flatMap(service(model), (m) => Stream.runCollect(m.streamText({ prompt: "hi" }))),
    );

    expect(parts.map((part) => part.type)).toEqual([
      "tool-params-start",
      "tool-params-end",
      "finish",
    ]);
    expect(parts.at(-1)?.metadata).toEqual({
      coder: {
        serverToolCalls: [
          {
            id: "srv_1",
            name: "execute",
            params: { command: "false" },
            result: "exit 1",
            isFailure: true,
          },
        ],
      },
    });
  });

  it.each([
    ["present", { ...USAGE, raw: RAW_USAGE }, { coder: { rawUsage: RAW_USAGE_JSON } }],
    ["absent", USAGE, {}],
  ] as const)(
    "carries raw usage on the finish part only when %s",
    async (_label, usage, metadata) => {
      const model = fakeModel({
        doStream: async () => ({
          stream: streamOf([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hi" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ]),
        }),
      });

      const parts = await Effect.runPromise(
        Effect.flatMap(service(model), (m) => Stream.runCollect(m.streamText({ prompt: "hi" }))),
      );

      const finish = parts.at(-1);
      expect(finish?.type).toBe("finish");
      expect(finish?.metadata).toEqual(metadata);
    },
  );

  it("fails the stream with a typed AiError on error parts", async () => {
    const model = fakeModel({
      doStream: async () => ({
        stream: streamOf([
          { type: "text-start", id: "t1" },
          {
            type: "error",
            error: new APICallError({
              message: "upstream exploded",
              url: "https://coder.example.com/gateway",
              requestBodyValues: {},
              statusCode: 503,
            }),
          },
        ]),
      }),
    });

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(service(model), (m) => Stream.runCollect(m.streamText({ prompt: "hi" }))),
    );

    const error = failure(exit);
    expect(AiError.isAiError(error)).toBe(true);
    expect(classifyError(error)).toBe("provider-unavailable");
  });

  it("aborts the underlying request when the consuming fiber is interrupted", async () => {
    let signal: AbortSignal | undefined;
    const model = fakeModel({
      doStream: async (options) => {
        signal = options.abortSignal;
        return {
          // A stream that never produces a part and never closes.
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull: () => new Promise<void>(() => {}),
          }),
        };
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const m = yield* service(model);
        const fiber = yield* Effect.forkChild(Stream.runCollect(m.streamText({ prompt: "hi" })));
        // Give the stream a chance to start and issue the request.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const check = () => {
                if (signal !== undefined) return resolve();
                setTimeout(check, 5);
              };
              check();
            }),
        );
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });
});
