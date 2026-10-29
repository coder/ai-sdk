/**
 * An Effect 4 `effect/ai` `LanguageModel` implemented on top of Coder AI
 * Gateway via `@coder/ai-sdk-provider`.
 *
 * The bridge core ({@link fromModel}) adapts *any* AI SDK
 * `LanguageModelV4` to `effect/ai`'s `LanguageModel` service; {@link make} /
 * {@link layer} bind it to a Coder AI Gateway model resolved from
 * `CoderProviderSettings` or an existing `CoderProvider`.
 *
 * Limitations (fail loudly with an `InvalidRequestError` reason rather than
 * silently degrade): provider-defined tools are not expressible in the
 * `LanguageModelV4` call options. Response parts with no `effect/ai`
 * equivalent (custom parts, reasoning files, tool approval requests,
 * URL/reference/text file payloads) are dropped, and so are tool approval
 * parts in the prompt (`effect/ai` resolves and strips them before the call).
 * In JSON mode, a `generateText` result's `structuredOutputText` replaces its
 * text parts, because `effect/ai` parses the joined text parts as the answer.
 *
 * Provider-executed tool calls and results for tools that are not in the
 * call's toolkit (e.g. Coder Agents' server-side tools) cannot be decoded by
 * `effect/ai`, whose tool parts are typed by the toolkit. They are moved to
 * the finish part's `metadata.coder.serverToolCalls` instead; streaming still
 * emits their `tool-params-start` / `tool-params-end` markers.
 *
 * `effect/ai`'s `Response.Usage` has no slot for the provider's raw usage
 * (`LanguageModelV4Usage.raw`), so it travels in the finish part's
 * `metadata.coder.rawUsage` (see {@link CoderFinishMetadata}).
 */
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FilePart,
  LanguageModelV4FinishReason,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4TextPart,
  LanguageModelV4ToolChoice,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4ToolResultPart,
  LanguageModelV4Usage,
  SharedV4FileData,
} from "@ai-sdk/provider";
import {
  type CoderProvider,
  type CoderProviderSettings,
  createCoder,
} from "@coder/ai-sdk-provider";
import * as AiError from "effect/ai/AiError";
import * as LanguageModel from "effect/ai/LanguageModel";
import type * as Prompt from "effect/ai/Prompt";
import type * as Response from "effect/ai/Response";
import * as Tool from "effect/ai/Tool";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { toAiError } from "./errors.js";
import { toDraft07 } from "./schema.js";

const MODULE = "CoderLanguageModel";

/** The model source: provider settings, or an already-constructed provider. */
export type ProviderSource = CoderProviderSettings | { readonly provider: CoderProvider };

/**
 * What the bridge records under the finish part's `metadata.coder`, as plain
 * JSON. Each key is present only when there is something to report, and the
 * finish part has no `metadata.coder` when neither is:
 *
 * - `serverToolCalls`: provider-executed tool activity for tools outside the
 *   call's toolkit (see the module docs), in call order.
 * - `rawUsage`: the provider's raw usage (`LanguageModelV4Usage.raw`), present
 *   only when the provider reports it. Keys whose value is `undefined` are
 *   dropped.
 */
export type CoderFinishMetadata = {
  readonly serverToolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly params?: Schema.Json;
    readonly result?: Schema.Json;
    readonly isFailure?: boolean;
  }>;
  readonly rawUsage?: { readonly [key: string]: Schema.Json };
};

/**
 * Generation controls forwarded to the underlying model. Options given at
 * construction apply to every call; {@link withGenerationOptions} overrides
 * them per call.
 */
export type GenerationOptions = Pick<
  LanguageModelV4CallOptions,
  | "maxOutputTokens"
  | "temperature"
  | "topP"
  | "topK"
  | "presencePenalty"
  | "frequencyPenalty"
  | "stopSequences"
  | "seed"
  | "reasoning"
  | "providerOptions"
>;

/**
 * Per-call generation overrides, read when a request starts and merged over
 * the construction-time {@link GenerationOptions} (per-call keys win; nested
 * objects such as `providerOptions` are replaced, not merged). Provide it with
 * {@link withGenerationOptions}, the same way `effect/ai` providers expose
 * their `Config` services.
 */
export class GenerationConfig extends Context.Service<GenerationConfig, GenerationOptions>()(
  "@coder/ai-sdk-effect/GenerationConfig",
) {}

/**
 * Run `self` with per-call generation overrides. Nested calls merge, with the
 * innermost override winning per key.
 *
 * @example
 * ```ts
 * LanguageModel.generateText({ prompt: "hi" }).pipe(
 *   CoderLanguageModel.withGenerationOptions({ temperature: 0 }),
 * );
 * ```
 */
export const withGenerationOptions: {
  (
    overrides: GenerationOptions,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, GenerationConfig>>;
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    overrides: GenerationOptions,
  ): Effect.Effect<A, E, Exclude<R, GenerationConfig>>;
} = dual(
  2,
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    overrides: GenerationOptions,
  ): Effect.Effect<A, E, Exclude<R, GenerationConfig>> =>
    Effect.flatMap(Effect.serviceOption(GenerationConfig), (current) =>
      Effect.provideService(self, GenerationConfig, {
        ...Option.getOrElse(current, () => ({})),
        ...overrides,
      }),
    ),
);

/** Construction-time options with the caller's per-call overrides applied. */
const resolveGeneration = (generation: GenerationOptions): Effect.Effect<GenerationOptions> =>
  Effect.map(Effect.serviceOption(GenerationConfig), (overrides) =>
    Option.match(overrides, {
      onNone: () => generation,
      onSome: (perCall) => ({ ...generation, ...perCall }),
    }),
  );

/**
 * Build a `LanguageModel` service from any AI SDK `LanguageModelV4`. This is
 * the bridge core; it performs no HTTP itself and is directly testable with a
 * fake model.
 */
export const fromModel = (
  model: LanguageModelV4,
  generation: GenerationOptions = {},
): Effect.Effect<LanguageModel.LanguageModel> =>
  LanguageModel.make({
    generateText: (options) => generateText(model, options, generation),
    streamText: (options) => streamText(model, options, generation),
  });

/** {@link fromModel} as a `Layer`. */
export const layerFromModel = (
  model: LanguageModelV4,
  generation: GenerationOptions = {},
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, fromModel(model, generation));

/**
 * Build a `LanguageModel` service for a Coder AI Gateway model. `source` is
 * either `CoderProviderSettings` (a provider is constructed for you) or
 * `{ provider }` to reuse an existing `CoderProvider` — both auth modes
 * (centralized and BYOK) come along unchanged.
 */
export const make = (
  modelId: string,
  source: ProviderSource,
  generation: GenerationOptions = {},
): Effect.Effect<LanguageModel.LanguageModel, AiError.AiError> =>
  Effect.flatMap(
    Effect.try({
      try: () => {
        const provider = "provider" in source ? source.provider : createCoder(source);
        return provider.languageModel(modelId);
      },
      catch: (error) =>
        invalidRequest("make", error instanceof Error ? error.message : String(error)),
    }),
    (model) => fromModel(model, generation),
  );

/** {@link make} as a `Layer` providing `LanguageModel`. */
export const layer = (
  modelId: string,
  source: ProviderSource,
  generation: GenerationOptions = {},
): Layer.Layer<LanguageModel.LanguageModel, AiError.AiError> =>
  Layer.effect(LanguageModel.LanguageModel, make(modelId, source, generation));

// ---------------------------------------------------------------------------
// generateText / streamText implementations
// ---------------------------------------------------------------------------

const generateText = (
  model: LanguageModelV4,
  options: LanguageModel.ProviderOptions,
  generation: GenerationOptions,
): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError> =>
  Effect.gen(function* () {
    const callOptions = yield* buildCallOptions(
      options,
      yield* resolveGeneration(generation),
      "generateText",
    );
    const result = yield* Effect.tryPromise({
      try: (signal) => model.doGenerate({ ...callOptions, abortSignal: signal }),
      catch: (error) => toAiError({ module: MODULE, method: "generateText", error }),
    });
    return yield* Effect.try({
      try: () => {
        const parts: Array<Response.PartEncoded> = [];
        const serverTools = new ServerToolCalls(options);
        if (result.response !== undefined) {
          parts.push(responseMetadataPart(result.response));
        }
        // `effect/ai` parses the joined text parts as the JSON answer. A
        // provider's `structuredOutputText` (e.g. OpenAI Responses drafts
        // followed by a final answer) replaces them. An empty string is an
        // explicit selection and must not fall back to the text parts.
        const structured =
          options.responseFormat.type === "json" ? result.structuredOutputText : undefined;
        for (const content of result.content) {
          if (serverTools.absorb(content)) continue;
          if (structured !== undefined && content.type === "text") continue;
          parts.push(...contentToParts(content));
        }
        if (structured !== undefined) {
          parts.push({ type: "text", text: structured });
        }
        parts.push(finishPart(result.finishReason, result.usage, serverTools));
        return parts;
      },
      catch: (error) => toAiError({ module: MODULE, method: "generateText", error }),
    });
  });

const streamText = (
  model: LanguageModelV4,
  options: LanguageModel.ProviderOptions,
  generation: GenerationOptions,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const callOptions = yield* buildCallOptions(
        options,
        yield* resolveGeneration(generation),
        "streamText",
      );
      const serverTools = new ServerToolCalls(options);
      // Tie request cancellation to the stream scope so that fiber
      // interruption aborts the underlying HTTP request. Aborting after a
      // normal end is a no-op.
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (c) => Effect.sync(() => c.abort()),
      );
      const result = yield* Effect.tryPromise({
        try: () => model.doStream({ ...callOptions, abortSignal: controller.signal }),
        catch: (error) => toAiError({ module: MODULE, method: "streamText", error }),
      });
      return Stream.fromReadableStream({
        evaluate: () => result.stream,
        onError: (error) => toAiError({ module: MODULE, method: "streamText", error }),
      }).pipe(
        Stream.flatMap((part) => {
          if (part.type === "error") {
            return Stream.fail(
              toAiError({ module: MODULE, method: "streamText", error: part.error }),
            );
          }
          try {
            if (serverTools.absorb(part)) return Stream.empty;
            return Stream.fromIterable(streamPartToParts(part, serverTools));
          } catch (error) {
            return Stream.fail(toAiError({ module: MODULE, method: "streamText", error }));
          }
        }),
      );
    }),
  );

// ---------------------------------------------------------------------------
// Request mapping: effect/ai ProviderOptions -> LanguageModelV4CallOptions
// ---------------------------------------------------------------------------

const invalidRequest = (method: string, description: string, parameter?: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InvalidRequestError({ parameter, description }),
  });

const buildCallOptions = (
  options: LanguageModel.ProviderOptions,
  generation: GenerationOptions,
  method: string,
): Effect.Effect<LanguageModelV4CallOptions, AiError.AiError> =>
  Effect.try({
    try: () => {
      const prompt = promptToV4(options.prompt);
      const callOptions: LanguageModelV4CallOptions = { ...generation, prompt };
      if (options.tools.length > 0) {
        callOptions.tools = options.tools.map((tool) => toolToV4(tool, method));
      }
      // Forwarded even without tools (`effect/ai` then passes "none"), so the
      // model sees exactly what the caller asked for.
      callOptions.toolChoice = toolChoiceToV4(options, method);
      if (options.responseFormat.type === "json") {
        // The same transform `effect/ai` decodes the answer with.
        const schema = toDraft07(
          LanguageModel.defaultCodecTransformer(options.responseFormat.schema).jsonSchema,
        );
        callOptions.responseFormat = {
          type: "json",
          name: options.responseFormat.objectName,
          schema,
        };
        // Models without native structured-output support fall back to a
        // schema-less JSON mode (OpenAI's `json_object`), which requires the
        // word "JSON" in the messages and gets no schema on the wire. Inject
        // the schema as a leading system instruction — the same strategy the
        // AI SDK's own `generateObject` uses.
        prompt.unshift({
          role: "system",
          content:
            `JSON schema:\n${JSON.stringify(schema)}\n` +
            `You MUST answer with a JSON object that matches the JSON schema above.`,
        });
      }
      return callOptions;
    },
    catch: (error) => toAiError({ module: MODULE, method, error }),
  });

const toolToV4 = (tool: Tool.Any, method: string) => {
  if (Tool.isProviderDefined(tool)) {
    throw invalidRequest(
      method,
      `provider-defined tool "${tool.name}" is not supported by the Coder AI Gateway bridge`,
      "tools",
    );
  }
  const result: NonNullable<LanguageModelV4CallOptions["tools"]>[number] = {
    type: "function",
    name: tool.name,
    inputSchema: toDraft07(Tool.getJsonSchema(tool)),
  };
  const description = Tool.getDescription(tool);
  if (description !== undefined) {
    result.description = description;
  }
  return result;
};

/**
 * `effect/ai` has already narrowed `tools` to a `oneOf` subset, so `oneOf`
 * maps to its `mode`. A choice that demands a tool call fails when there are
 * no tools to call.
 */
const toolChoiceToV4 = (
  options: LanguageModel.ProviderOptions,
  method: string,
): LanguageModelV4ToolChoice => {
  const { toolChoice } = options;
  let result: LanguageModelV4ToolChoice;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    result = { type: toolChoice };
  } else if ("tool" in toolChoice) {
    result = { type: "tool", toolName: toolChoice.tool };
  } else {
    result = { type: toolChoice.mode ?? "auto" };
  }
  if (options.tools.length === 0 && (result.type === "required" || result.type === "tool")) {
    throw invalidRequest(
      method,
      `tool choice "${result.type}" needs at least one tool, but the call has none`,
      "toolChoice",
    );
  }
  return result;
};

const promptToV4 = (prompt: Prompt.Prompt): LanguageModelV4Prompt => {
  const messages: LanguageModelV4Prompt = [];
  for (const message of prompt.content) {
    messages.push(messageToV4(message));
  }
  return messages;
};

const messageToV4 = (message: Prompt.Message): LanguageModelV4Message => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user": {
      const content: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else {
          content.push(filePartToV4(part));
        }
      }
      return { role: "user", content };
    }
    case "assistant": {
      const content: Extract<LanguageModelV4Message, { role: "assistant" }>["content"] = [];
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            content.push({ type: "text", text: part.text });
            break;
          case "reasoning":
            content.push({ type: "reasoning", text: part.text });
            break;
          case "file":
            content.push(filePartToV4(part));
            break;
          case "tool-call":
            content.push({
              type: "tool-call",
              toolCallId: part.id,
              toolName: part.name,
              input: part.params,
              providerExecuted: part.providerExecuted,
            });
            break;
          case "tool-result":
            content.push(toolResultToV4(part));
            break;
          // Tool approvals are resolved by `effect/ai` (see module docs).
          case "tool-approval-request":
            break;
        }
      }
      return { role: "assistant", content };
    }
    case "tool": {
      const content: Array<LanguageModelV4ToolResultPart> = [];
      for (const part of message.content) {
        if (part.type === "tool-result") content.push(toolResultToV4(part));
      }
      return { role: "tool", content };
    }
  }
};

const filePartToV4 = (part: Prompt.FilePart): LanguageModelV4FilePart => {
  let data: SharedV4FileData;
  if (part.data instanceof URL) {
    data = { type: "url", url: part.data };
  } else {
    // Base64 string or raw bytes, per the `Prompt.FilePart` contract.
    data = { type: "data", data: part.data };
  }
  const result: LanguageModelV4FilePart = {
    type: "file",
    mediaType: part.mediaType,
    data,
  };
  if (part.fileName !== undefined) {
    result.filename = part.fileName;
  }
  return result;
};

const toolResultToV4 = (part: Prompt.ToolResultPart): LanguageModelV4ToolResultPart => {
  // SAFETY: tool results round-trip through JSON wire payloads (they are the
  // decoded `result` of an executed tool call), so they are JSON-serializable.
  const value = (part.result ?? null) as JSONValue;
  let output: LanguageModelV4ToolResultOutput;
  if (part.isFailure) {
    output = { type: "error-json", value };
  } else if (part.modelOutput !== undefined) {
    // A tool's `toModelOutput` mapping (effect 4.0.7+) replaces the result
    // sent to the model.
    output = {
      type: "content",
      value: part.modelOutput.map((item) =>
        item.type === "text" ? { type: "text", text: item.text } : filePartToV4(item),
      ),
    };
  } else {
    output = { type: "json", value };
  }
  return {
    type: "tool-result",
    toolCallId: part.id,
    toolName: part.name,
    output,
  };
};

// ---------------------------------------------------------------------------
// Response mapping: V4 content/stream parts -> effect/ai encoded parts
// ---------------------------------------------------------------------------

const invalidOutput = (method: string, description: string): AiError.AiError =>
  AiError.make({ module: MODULE, method, reason: new AiError.InvalidOutputError({ description }) });

/** Per the V4 spec, tool call arguments arrive as a stringified JSON object. */
const toolCallPart = (content: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: string;
  readonly providerExecuted?: boolean;
}): Response.ToolCallPartEncoded => {
  let params: Response.ToolCallPartEncoded["params"];
  try {
    params = content.input.trim() === "" ? {} : JSON.parse(content.input);
  } catch (cause) {
    throw invalidOutput(
      "toolCallPart",
      `tool call arguments are not valid JSON (${String(cause)}): ${content.input}`,
    );
  }
  return {
    type: "tool-call",
    id: content.toolCallId,
    name: content.toolName,
    params,
    providerExecuted: content.providerExecuted ?? false,
  };
};

/**
 * `Response.FilePartEncoded.data` is a base64 string; only `data` payloads can
 * be represented. URL / reference / text payloads are dropped.
 */
const fileDataToBase64 = (data: SharedV4FileData): string | undefined => {
  if (data.type !== "data") return undefined;
  if (data.data instanceof Uint8Array) {
    return Buffer.from(data.data).toString("base64");
  }
  return data.data;
};

/** Content types that map identically in generate results and stream parts. */
type SharedContent = Exclude<LanguageModelV4Content, { type: "text" } | { type: "reasoning" }>;

type SharedPartEncoded =
  | Response.ToolCallPartEncoded
  | Response.ToolResultPartEncoded
  | Response.FilePartEncoded
  | Response.UrlSourcePartEncoded
  | Response.DocumentSourcePartEncoded;

const contentToParts = (content: LanguageModelV4Content): Array<Response.PartEncoded> => {
  switch (content.type) {
    case "text":
      return [{ type: "text", text: content.text }];
    case "reasoning":
      return [{ type: "reasoning", text: content.text }];
    default:
      return sharedContentToParts(content);
  }
};

const sharedContentToParts = (content: SharedContent): Array<SharedPartEncoded> => {
  switch (content.type) {
    case "tool-call":
      return [toolCallPart(content)];
    case "tool-result":
      return [
        {
          type: "tool-result",
          id: content.toolCallId,
          name: content.toolName,
          result: content.result,
          isFailure: content.isError ?? false,
          providerExecuted: true,
        },
      ];
    case "file": {
      const data = fileDataToBase64(content.data);
      if (data === undefined) return [];
      return [{ type: "file", mediaType: content.mediaType, data }];
    }
    case "source":
      if (content.sourceType === "url") {
        return [
          {
            type: "source",
            sourceType: "url",
            id: content.id,
            url: content.url,
            title: content.title ?? content.url,
          },
        ];
      }
      return [
        {
          type: "source",
          sourceType: "document",
          id: content.id,
          mediaType: content.mediaType,
          title: content.title,
          fileName: content.filename,
        },
      ];
    // Not mapped to `effect/ai` parts; see module docs.
    case "custom":
    case "reasoning-file":
    case "tool-approval-request":
      return [];
  }
};

const streamPartToParts = (
  part: Exclude<LanguageModelV4StreamPart, { type: "error" }>,
  serverTools: ServerToolCalls,
): Array<Response.StreamPartEncoded> => {
  switch (part.type) {
    case "text-start":
      return [{ type: "text-start", id: part.id }];
    case "text-delta":
      return [{ type: "text-delta", id: part.id, delta: part.delta }];
    case "text-end":
      return [{ type: "text-end", id: part.id }];
    case "reasoning-start":
      return [{ type: "reasoning-start", id: part.id }];
    case "reasoning-delta":
      return [{ type: "reasoning-delta", id: part.id, delta: part.delta }];
    case "reasoning-end":
      return [{ type: "reasoning-end", id: part.id }];
    case "tool-input-start":
      return [
        {
          type: "tool-params-start",
          id: part.id,
          name: part.toolName,
          providerExecuted: part.providerExecuted ?? false,
        },
      ];
    case "tool-input-delta":
      return [{ type: "tool-params-delta", id: part.id, delta: part.delta }];
    case "tool-input-end":
      return [{ type: "tool-params-end", id: part.id }];
    case "response-metadata":
      return [responseMetadataPart(part)];
    case "finish":
      return [finishPart(part.finishReason, part.usage, serverTools)];
    // `stream-start` (warnings) and `raw` chunks have no equivalent.
    case "stream-start":
    case "raw":
      return [];
    default:
      return sharedContentToParts(part);
  }
};

/** A provider-executed tool call the call's toolkit cannot represent. */
interface ServerToolCall {
  readonly id: string;
  readonly name: string;
  params?: unknown;
  result?: unknown;
  isFailure?: boolean;
}

/**
 * Collects provider-executed tool activity for tools outside the call's
 * toolkit (see the module docs) for the finish part's metadata.
 */
class ServerToolCalls {
  readonly #toolNames: ReadonlySet<string>;
  readonly #calls = new Map<string, ServerToolCall>();

  constructor(options: LanguageModel.ProviderOptions) {
    this.#toolNames = new Set(options.tools.map((tool) => tool.name));
  }

  /** Records `part` and returns `true` when it must not reach `effect/ai`. */
  absorb(part: LanguageModelV4Content | LanguageModelV4StreamPart): boolean {
    if (part.type === "tool-call") {
      if (part.providerExecuted !== true || this.#toolNames.has(part.toolName)) return false;
      const call = this.#entry(part.toolCallId, part.toolName);
      call.params = toolCallPart(part).params;
      return true;
    }
    if (part.type === "tool-result") {
      if (this.#toolNames.has(part.toolName)) return false;
      const call = this.#entry(part.toolCallId, part.toolName);
      call.result = part.result;
      call.isFailure = part.isError ?? false;
      return true;
    }
    return false;
  }

  /** The recorded calls as plain JSON, or `undefined` when there are none. */
  toJson(): CoderFinishMetadata["serverToolCalls"] {
    if (this.#calls.size === 0) return undefined;
    // Finish metadata must be plain JSON. Params come from `JSON.parse` and
    // results from the provider's JSON payload; the round trip drops the
    // `undefined` object values that the AI SDK's `JSONValue` allows.
    return JSON.parse(JSON.stringify([...this.#calls.values()]));
  }

  #entry(id: string, name: string): ServerToolCall {
    let call = this.#calls.get(id);
    if (call === undefined) {
      call = { id, name };
      this.#calls.set(id, call);
    }
    if (call.name !== name) {
      throw invalidOutput(
        "serverToolCall",
        `tool call ${id} changed its tool name from "${call.name}" to "${name}"`,
      );
    }
    return call;
  }
}

const responseMetadataPart = (metadata: {
  readonly id?: string;
  readonly modelId?: string;
  readonly timestamp?: Date;
}): Response.ResponseMetadataPartEncoded => ({
  type: "response-metadata",
  id: metadata.id,
  modelId: metadata.modelId,
  timestamp: metadata.timestamp?.toISOString(),
});

/**
 * Map the AI SDK's unified finish reason onto `effect/ai`'s. `effect/ai` has
 * no `"interrupted"` (the provider stream ended without a completion signal),
 * so it becomes `"unknown"`: the model gave no finish reason. Like every
 * reason other than stop/tool-calls/pause, `effect/ai` treats it as an
 * incomplete response and does not run tool handlers.
 */
const toFinishReason = (
  unified: LanguageModelV4FinishReason["unified"],
): Response.FinishPartEncoded["reason"] => (unified === "interrupted" ? "unknown" : unified);

/** The finish part, with `metadata.coder` only when it has keys. */
const finishPart = (
  finishReason: LanguageModelV4FinishReason,
  usage: LanguageModelV4Usage,
  serverTools: ServerToolCalls,
): Response.FinishPartEncoded => {
  const part: Response.FinishPartEncoded = {
    type: "finish",
    reason: toFinishReason(finishReason.unified),
    usage: {
      inputTokens: {
        uncached: usage.inputTokens.noCache,
        total: usage.inputTokens.total,
        cacheRead: usage.inputTokens.cacheRead,
        cacheWrite: usage.inputTokens.cacheWrite,
      },
      outputTokens: {
        total: usage.outputTokens.total,
        text: usage.outputTokens.text,
        reasoning: usage.outputTokens.reasoning,
      },
    },
  };
  const coder: { -readonly [K in keyof CoderFinishMetadata]: CoderFinishMetadata[K] } = {};
  const serverToolCalls = serverTools.toJson();
  if (serverToolCalls !== undefined) coder.serverToolCalls = serverToolCalls;
  // The raw usage is a `JSONObject`; the round trip drops `undefined` values.
  if (usage.raw !== undefined) coder.rawUsage = JSON.parse(JSON.stringify(usage.raw));
  if (Object.keys(coder).length === 0) return part;
  return { ...part, metadata: { coder } };
};
