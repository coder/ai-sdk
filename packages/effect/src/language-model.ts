/**
 * An `@effect/ai` `LanguageModel` implemented on top of Coder AI Gateway via
 * `@coder/ai-sdk-provider`.
 *
 * The bridge core ({@link fromModel}) adapts *any* AI SDK
 * `LanguageModelV4` to `@effect/ai`'s `LanguageModel` service; {@link make} /
 * {@link layer} bind it to a Coder AI Gateway model resolved from
 * `CoderProviderSettings` or an existing `CoderProvider`.
 *
 * Spike limitations (fail loudly with `MalformedInput` rather than silently
 * degrade): provider-defined tools and the `oneOf` tool-choice mode are not
 * expressible in the `LanguageModelV4` call options. Response parts with no
 * `@effect/ai` equivalent (custom parts, reasoning files, tool approval
 * requests, URL/reference/text file payloads) are dropped.
 */
import type {
  JSONSchema7,
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
import * as AiError from "@effect/ai/AiError";
import * as LanguageModel from "@effect/ai/LanguageModel";
import type * as Prompt from "@effect/ai/Prompt";
import type * as Response from "@effect/ai/Response";
import * as Tool from "@effect/ai/Tool";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { toAiError } from "./errors.js";

const MODULE = "CoderLanguageModel";

/** The model source: provider settings, or an already-constructed provider. */
export type ProviderSource = CoderProviderSettings | { readonly provider: CoderProvider };

/**
 * Generation controls forwarded to the underlying model on every call. These
 * are fixed at construction time; a per-call override channel (an Effect
 * config service, as `@effect/ai`'s own providers use) is Phase 2.
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
>;

/**
 * Build a `LanguageModel` service from any AI SDK `LanguageModelV4`. This is
 * the bridge core; it performs no HTTP itself and is directly testable with a
 * fake model.
 */
export const fromModel = (
  model: LanguageModelV4,
  generation: GenerationOptions = {},
): Effect.Effect<LanguageModel.Service> =>
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
): Effect.Effect<LanguageModel.Service, AiError.AiError> =>
  Effect.flatMap(
    Effect.try({
      try: () => {
        const provider = "provider" in source ? source.provider : createCoder(source);
        return provider.languageModel(modelId);
      },
      catch: (error) =>
        new AiError.MalformedInput({
          module: MODULE,
          method: "make",
          description: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
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
    const callOptions = yield* buildCallOptions(options, generation, "generateText");
    const result = yield* Effect.tryPromise({
      try: (signal) => model.doGenerate({ ...callOptions, abortSignal: signal }),
      catch: (error) => toAiError({ module: MODULE, method: "generateText", error }),
    });
    return yield* Effect.try({
      try: () => {
        const parts: Array<Response.PartEncoded> = [];
        if (result.response !== undefined) {
          parts.push(responseMetadataPart(result.response));
        }
        for (const content of result.content) {
          parts.push(...contentToParts(content));
        }
        parts.push(finishPart(result.finishReason, result.usage));
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
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const callOptions = yield* buildCallOptions(options, generation, "streamText");
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
            return Stream.fromIterable(streamPartToParts(part));
          } catch (error) {
            return Stream.fail(toAiError({ module: MODULE, method: "streamText", error }));
          }
        }),
      );
    }),
  );

// ---------------------------------------------------------------------------
// Request mapping: @effect/ai ProviderOptions -> LanguageModelV4CallOptions
// ---------------------------------------------------------------------------

const unsupported = (method: string, description: string): AiError.MalformedInput =>
  new AiError.MalformedInput({ module: MODULE, method, description });

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
        callOptions.toolChoice = toolChoiceToV4(options.toolChoice, method);
      }
      if (options.responseFormat.type === "json") {
        // SAFETY: effect's JsonSchema7 output is structurally a JSON Schema
        // draft-07 document; only the nominal type differs from `JSONSchema7`.
        const schema = Tool.getJsonSchemaFromSchemaAst(
          options.responseFormat.schema.ast,
        ) as JSONSchema7;
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
    throw unsupported(
      method,
      `provider-defined tool "${tool.name}" is not supported by the Coder AI Gateway bridge`,
    );
  }
  const result: NonNullable<LanguageModelV4CallOptions["tools"]>[number] = {
    type: "function",
    name: tool.name,
    // SAFETY: effect's JsonSchema7 output is structurally a JSON Schema
    // draft-07 document; only the nominal type differs from `JSONSchema7`.
    inputSchema: Tool.getJsonSchemaFromSchemaAst(tool.parametersSchema.ast) as JSONSchema7,
  };
  const description =
    tool.description ?? Tool.getDescriptionFromSchemaAst(tool.parametersSchema.ast);
  if (description !== undefined) {
    result.description = description;
  }
  return result;
};

const toolChoiceToV4 = (
  toolChoice: LanguageModel.ProviderOptions["toolChoice"],
  method: string,
): LanguageModelV4ToolChoice => {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return { type: toolChoice };
  }
  if ("tool" in toolChoice) {
    return { type: "tool", toolName: toolChoice.tool };
  }
  throw unsupported(method, `the "oneOf" tool choice mode cannot be expressed in a gateway call`);
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
        }
      }
      return { role: "assistant", content };
    }
    case "tool": {
      const content: Array<LanguageModelV4ToolResultPart> = [];
      for (const part of message.content) {
        content.push(toolResultToV4(part));
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
// Response mapping: V4 content/stream parts -> @effect/ai encoded parts
// ---------------------------------------------------------------------------

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
    throw new AiError.MalformedOutput({
      module: MODULE,
      method: "toolCallPart",
      description: `tool call arguments are not valid JSON: ${content.input}`,
      cause,
    });
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
 * be represented. URL / reference / text payloads are dropped (spike caveat).
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
    // No @effect/ai representation exists for these; see module docs.
    case "custom":
    case "reasoning-file":
    case "tool-approval-request":
      return [];
  }
};

const streamPartToParts = (
  part: Exclude<LanguageModelV4StreamPart, { type: "error" }>,
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
      return [finishPart(part.finishReason, part.usage)];
    // `stream-start` (warnings) and `raw` chunks have no equivalent.
    case "stream-start":
    case "raw":
      return [];
    default:
      return sharedContentToParts(part);
  }
};

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

const finishPart = (
  finishReason: LanguageModelV4FinishReason,
  usage: LanguageModelV4Usage,
): Response.FinishPartEncoded => {
  const inputTokens = usage.inputTokens.total;
  const outputTokens = usage.outputTokens.total;
  let totalTokens: number | undefined;
  if (inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    type: "finish",
    reason: finishReason.unified,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens: usage.outputTokens.reasoning,
      cachedInputTokens: usage.inputTokens.cacheRead,
    },
  };
};
