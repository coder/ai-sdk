/**
 * An `@effect/ai` `LanguageModel` over Coder Agents (chatd), backed by
 * `@coder/ai-sdk-agent`'s `CoderLanguageModel`.
 *
 * The agent model is a `LanguageModelV4`, so it runs through the same bridge
 * core as the gateway model ({@link fromModel}): `TurnTranslator` output
 * becomes an Effect `Stream`, and agent errors map to `AiError` (see
 * `errors.ts`). What this module adds:
 *
 * - **Session ownership.** chatd holds the conversation. One service owns one
 *   chat: each call sends only the prompt's newest user message (or client
 *   tool results), and system messages apply when the chat is created. The
 *   scoped {@link make} / {@link layer} dispose the model when the scope
 *   closes. The chat itself is not archived.
 * - **Interruption.** Interrupting the consuming fiber aborts the call. The
 *   agent model then interrupts the chat's run server-side, at most once.
 * - **Per-call agent options.** {@link withAgentOptions} changes `model` or
 *   `reasoningEffort` for one call. chatd applies both per user message, so a
 *   change swaps in a fresh `CoderLanguageModel` that resumes the same chat
 *   (`chatId` + `lastSeenMessageId`). It is refused while client tool results
 *   are being submitted, because that continues a turn in progress.
 *
 * Sampling controls (`temperature`, `maxOutputTokens`, ...) are chosen by
 * chatd, so the agent model rejects them, and any `providerOptions` other
 * than `coder`, with `MalformedInput`.
 */
import {
  InvalidArgumentError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import {
  classifyTurnAction,
  CoderChatClient,
  type CoderLanguageModelConfig,
  CoderLanguageModel as ChatdModel,
  type ReasoningEffort,
} from "@coder/ai-sdk-agent";
import * as AiError from "@effect/ai/AiError";
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { type GenerationOptions, fromModel, withGenerationOptions } from "./language-model.js";

/** Settings for {@link make}: the agent model config plus a connection. */
export type AgentModelSettings = Omit<CoderLanguageModelConfig, "client"> & {
  /** A pre-built chatd client. Otherwise one is built from `baseUrl` + `token`. */
  readonly client?: CoderChatClient;
  /** Coder deployment URL. Defaults to `CODER_URL`. */
  readonly baseUrl?: string;
  /** Coder session token. Defaults to `CODER_SESSION_TOKEN`. */
  readonly token?: string;
};

/** Per-call agent options; unset keys fall back to {@link AgentModelSettings}. */
export interface AgentOptions {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Run `self` with per-call agent options. They travel on the shared
 * generation channel as `providerOptions.coder`, so they replace any
 * `providerOptions` set by an outer {@link withGenerationOptions}.
 */
export const withAgentOptions = (
  options: AgentOptions,
): (<A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) => {
  const coder: Record<string, string> = {};
  if (options.model !== undefined) coder.model = options.model;
  if (options.reasoningEffort !== undefined) coder.reasoningEffort = options.reasoningEffort;
  return withGenerationOptions({ providerOptions: { coder } });
};

/**
 * Build a `LanguageModel` service over a Coder Agents chat. The chat is
 * created on the first call (or resumed from `settings.chatId`); closing the
 * scope disposes the model and its event stream.
 */
export const make = (
  settings: AgentModelSettings,
): Effect.Effect<LanguageModel.Service, AiError.AiError, Scope.Scope> =>
  Effect.flatMap(
    Effect.acquireRelease(
      Effect.try({
        try: () => new AgentSession(settings),
        catch: (error) =>
          new AiError.MalformedInput({
            module: MODULE,
            method: "make",
            description: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
      }),
      (session) => Effect.promise(() => session.dispose()),
    ),
    (session) => fromModel(session),
  );

/** {@link make} as a scoped `Layer` providing `LanguageModel`. */
export const layer = (
  settings: AgentModelSettings,
): Layer.Layer<LanguageModel.LanguageModel, AiError.AiError> =>
  Layer.scoped(LanguageModel.LanguageModel, make(settings));

const MODULE = "CoderAgentModel";

/** Generation controls chatd does not accept from API clients. */
const UNSUPPORTED: ReadonlyArray<keyof GenerationOptions> = [
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "reasoning",
];

const invalid = (message: string, argument = "providerOptions.coder"): InvalidArgumentError =>
  new InvalidArgumentError({ argument, message });

/** Validates the call's agent options and resolves them against the settings. */
const turnOptions = (
  settings: Omit<CoderLanguageModelConfig, "client">,
  options: LanguageModelV4CallOptions,
): AgentOptions => {
  for (const key of UNSUPPORTED) {
    if (options[key] !== undefined) {
      throw invalid(`Coder Agents choose "${key}" server-side; it cannot be set per call`, key);
    }
  }
  // chatd reads system messages (where the bridge puts the JSON schema) only
  // when it creates the chat, and enforces no schema itself.
  if (options.responseFormat?.type === "json") {
    throw invalid(
      "Coder Agents do not support structured output; use CoderLanguageModel (AI Gateway) instead",
      "responseFormat",
    );
  }
  // chatd has no tool-choice control; only the default "auto" is honest.
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto") {
    throw invalid(
      `Coder Agents only support the "auto" tool choice, got "${options.toolChoice.type}"`,
      "toolChoice",
    );
  }
  const namespaces = Object.keys(options.providerOptions ?? {});
  const foreign = namespaces.find((namespace) => namespace !== "coder");
  if (foreign !== undefined) {
    throw invalid(`only providerOptions.coder is honored, got "${foreign}"`, "providerOptions");
  }
  let perCall: AgentOptions;
  try {
    perCall = decodeAgentOptions(options.providerOptions?.coder ?? {});
  } catch (error) {
    throw invalid(`expected only a string model and reasoningEffort: ${String(error)}`);
  }
  return {
    model: perCall.model ?? settings.model,
    reasoningEffort: perCall.reasoningEffort ?? settings.reasoningEffort,
  };
};

const decodeAgentOptions = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    reasoningEffort: Schema.optional(Schema.String),
  }),
  { onExcessProperty: "error" },
);

/**
 * A `LanguageModelV4` that owns one chat through a current `CoderLanguageModel`,
 * swapping it (on the same chat) when per-call agent options change. Like the
 * agent model, it is single-flight.
 */
class AgentSession implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "coder.chatd";
  readonly supportedUrls = {};
  /** The model config without connection settings (the token stays out of it). */
  readonly #settings: Omit<CoderLanguageModelConfig, "client">;
  readonly #client: CoderChatClient;
  #current: ChatdModel;
  #options: AgentOptions;
  #busy = false;
  /**
   * The tools registered with the chat. chatd receives client tools only when
   * the chat is created, so later calls must send the same toolkit.
   */
  #tools: string | undefined;

  constructor(settings: AgentModelSettings) {
    const env = globalThis.process?.env;
    const baseUrl = settings.baseUrl ?? env?.CODER_URL;
    const token = settings.token ?? env?.CODER_SESSION_TOKEN;
    if (settings.client !== undefined) {
      this.#client = settings.client;
    } else if (baseUrl && token) {
      this.#client = new CoderChatClient({
        baseUrl,
        token,
        onTransportEvent: settings.onTransportEvent,
      });
    } else {
      throw new Error(
        "CoderAgentModel requires `client`, or `baseUrl` and `token` " +
          "(or the CODER_URL and CODER_SESSION_TOKEN environment variables).",
      );
    }
    const { client: _client, baseUrl: _baseUrl, token: _token, ...modelSettings } = settings;
    this.#settings = modelSettings;
    this.#options = { model: settings.model, reasoningEffort: settings.reasoningEffort };
    this.#current = this.#build(this.#options, settings.chatId, settings.lastSeenMessageId);
  }

  get modelId(): string {
    return this.#current.modelId;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    const model = await this.#begin(options);
    try {
      return await model.doGenerate(options);
    } finally {
      this.#busy = false;
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const model = await this.#begin(options);
    let result: Awaited<ReturnType<ChatdModel["doStream"]>>;
    try {
      result = await model.doStream(options);
    } catch (error) {
      this.#busy = false;
      throw error;
    }
    // Stay busy until the stream ends, fails, or is cancelled.
    const reader = result.stream.getReader();
    const stream = new ReadableStream({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (next.done) {
            this.#busy = false;
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          this.#busy = false;
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } finally {
          this.#busy = false;
        }
      },
    });
    return { ...result, stream };
  }

  async dispose(): Promise<void> {
    await this.#current[Symbol.asyncDispose]();
  }

  /** Marks the session busy and returns the model for this call's options. */
  async #begin(options: LanguageModelV4CallOptions): Promise<ChatdModel> {
    if (this.#busy) {
      throw invalid("a call is already in flight on this Coder Agents session", "prompt");
    }
    const wanted = turnOptions(this.#settings, options);
    const change =
      wanted.model !== this.#options.model ||
      wanted.reasoningEffort !== this.#options.reasoningEffort;
    if (change && classifyTurnAction(options.prompt).kind !== "new-turn") {
      throw invalid(
        "model and reasoningEffort can only change on a new user message, " +
          "not while client tool results are submitted",
      );
    }
    // Last check: it records the toolkit, so a rejected call must not reach it.
    this.#checkTools(options);
    this.#busy = true;
    try {
      if (change) {
        const previous = this.#current;
        const chatId = previous.chatId;
        const next = this.#build(wanted, chatId, chatId ? previous.lastSeenMessageId : undefined);
        await previous[Symbol.asyncDispose]();
        this.#current = next;
        this.#options = wanted;
      }
      return this.#current;
    } catch (error) {
      this.#busy = false;
      throw error;
    }
  }

  #checkTools(options: LanguageModelV4CallOptions): void {
    const tools = JSON.stringify(options.tools ?? []);
    if (this.#current.chatId === undefined || this.#tools === undefined) {
      // This call creates (or first attaches to) the chat and registers them.
      this.#tools = tools;
    } else if (tools !== this.#tools) {
      throw invalid(
        "the toolkit cannot change after the chat is created: chatd registers client tools only then",
        "tools",
      );
    }
  }

  #build(options: AgentOptions, chatId?: string, lastSeenMessageId?: number): ChatdModel {
    const config: CoderLanguageModelConfig = {
      ...this.#settings,
      client: this.#client,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      chatId,
      lastSeenMessageId,
    };
    return new ChatdModel(config);
  }
}
