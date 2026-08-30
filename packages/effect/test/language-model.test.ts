import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import * as AiError from "@effect/ai/AiError";
import type * as LanguageModel from "@effect/ai/LanguageModel";
import type * as Prompt from "@effect/ai/Prompt";
import * as Tool from "@effect/ai/Tool";
import * as Toolkit from "@effect/ai/Toolkit";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { classifyError } from "../src/errors.js";
import * as CoderLanguageModel from "../src/language-model.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
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

const service = (model: LanguageModelV4): Effect.Effect<LanguageModel.Service> =>
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
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
    expect(response.usage.totalTokens).toBe(15);
    expect(response.usage.cachedInputTokens).toBe(2);
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
      parameters: { city: Schema.String },
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
          additionalProperties: false,
        },
      },
    ]);
    expect(captured?.toolChoice).toEqual({ type: "auto" });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolResults).toHaveLength(1);
    expect(response.toolResults[0]?.result).toEqual({ temperature: 21 });
  });

  it("fails with MalformedInput for the oneOf tool choice mode", async () => {
    const GetWeather = Tool.make("get_weather", {
      parameters: { city: Schema.String },
      success: Schema.Struct({ temperature: Schema.Number }),
    });
    const toolkit = Toolkit.make(GetWeather);
    const model = fakeModel({});

    const exit = await Effect.runPromiseExit(
      Effect.flatMap(service(model), (m) =>
        m.generateText({ prompt: "weather?", toolkit, toolChoice: { oneOf: ["get_weather"] } }),
      ).pipe(
        Effect.provide(toolkit.toLayer({ get_weather: () => Effect.succeed({ temperature: 0 }) })),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("MalformedInput");
    expect(String(exit)).toContain("oneOf");
  });

  it("fails with MalformedOutput when tool call arguments are not JSON", async () => {
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

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("MalformedOutput");
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

    const auth = await run(401);
    expect(Exit.isFailure(auth)).toBe(true);
    if (Exit.isFailure(auth) && auth.cause._tag === "Fail") {
      const error = auth.cause.error;
      expect(error._tag).toBe("HttpResponseError");
      expect(classifyError(error)).toBe("auth");
    }

    const throttled = await run(429);
    if (Exit.isFailure(throttled) && throttled.cause._tag === "Fail") {
      expect(classifyError(throttled.cause.error)).toBe("rate-limit");
    }

    const network = await run(undefined);
    if (Exit.isFailure(network) && network.cause._tag === "Fail") {
      expect(network.cause.error._tag).toBe("HttpRequestError");
      expect(classifyError(network.cause.error)).toBe("transport");
    }
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

    const Weather = Schema.Struct({ city: Schema.String, temperature: Schema.Number });
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
        additionalProperties: false,
      },
    });
  });
});

describe("streamText", () => {
  it("maps stream parts onto @effect/ai stream parts", async () => {
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

    const types = Chunk.toReadonlyArray(parts).map((part) => part.type);
    expect(types).toEqual([
      "response-metadata",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const text = Chunk.toReadonlyArray(parts)
      .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
      .join("");
    expect(text).toBe("Hello");
  });

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

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(AiError.isAiError(exit.cause.error)).toBe(true);
      expect(classifyError(exit.cause.error)).toBe("provider-unavailable");
    }
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
        const fiber = yield* Effect.fork(Stream.runCollect(m.streamText({ prompt: "hi" })));
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
