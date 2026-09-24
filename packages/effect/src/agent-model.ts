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
 *
 * Sampling controls (`temperature`, `maxOutputTokens`, ...) are chosen by
 * chatd, so the agent model rejects them, and any `providerOptions`, with
 * `MalformedInput`.
 */
import {
  InvalidArgumentError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import {
  CoderChatClient,
  type CoderLanguageModelConfig,
  CoderLanguageModel as ChatdModel,
} from "@coder/ai-sdk-agent";
import * as AiError from "@effect/ai/AiError";
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { type GenerationOptions, fromModel } from "./language-model.js";

/** Settings for {@link make}: the agent model config plus a connection. */
export type AgentModelSettings = Omit<CoderLanguageModelConfig, "client"> & {
  /** A pre-built chatd client. Otherwise one is built from `baseUrl` + `token`. */
  readonly client?: CoderChatClient;
  /** Coder deployment URL. Defaults to `CODER_URL`. */
  readonly baseUrl?: string;
  /** Coder session token. Defaults to `CODER_SESSION_TOKEN`. */
  readonly token?: string;
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

const invalid = (message: string, argument: string): InvalidArgumentError =>
  new InvalidArgumentError({ argument, message });

/** Fails fast on call options chatd would silently ignore. */
const rejectUnsupported = (options: LanguageModelV4CallOptions): void => {
  for (const key of UNSUPPORTED) {
    if (options[key] !== undefined) {
      throw invalid(`Coder Agents choose "${key}" server-side; it cannot be set per call`, key);
    }
  }
  // chatd has no tool-choice control; only the default "auto" is honest.
  if (options.toolChoice !== undefined && options.toolChoice.type !== "auto") {
    throw invalid(
      `Coder Agents only support the "auto" tool choice, got "${options.toolChoice.type}"`,
      "toolChoice",
    );
  }
  const namespaces = Object.keys(options.providerOptions ?? {});
  if (namespaces.length > 0) {
    throw invalid(
      `Coder Agents do not accept providerOptions (got "${namespaces.join(", ")}")`,
      "providerOptions",
    );
  }
};

/**
 * A `LanguageModelV4` that owns one chat through a `CoderLanguageModel`,
 * validating call options and tracking the in-flight call. Like the agent
 * model, it is single-flight.
 */
class AgentSession implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "coder.chatd";
  readonly supportedUrls = {};
  readonly #model: ChatdModel;
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
    let client: CoderChatClient;
    if (settings.client !== undefined) {
      client = settings.client;
    } else if (baseUrl && token) {
      client = new CoderChatClient({
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
    // The model config gets the client, not the raw credentials.
    const { client: _client, baseUrl: _baseUrl, token: _token, ...modelSettings } = settings;
    this.#model = new ChatdModel({ ...modelSettings, client });
  }

  get modelId(): string {
    return this.#model.modelId;
  }

  async doGenerate(options: LanguageModelV4CallOptions) {
    this.#begin(options);
    try {
      return await this.#model.doGenerate(options);
    } finally {
      this.#busy = false;
    }
  }

  async doStream(options: LanguageModelV4CallOptions) {
    this.#begin(options);
    let result: Awaited<ReturnType<ChatdModel["doStream"]>>;
    try {
      result = await this.#model.doStream(options);
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
    await this.#model[Symbol.asyncDispose]();
  }

  /** Validates the call and marks the session busy. */
  #begin(options: LanguageModelV4CallOptions): void {
    if (this.#busy) {
      throw invalid("a call is already in flight on this Coder Agents session", "prompt");
    }
    rejectUnsupported(options);
    this.#checkTools(options);
    this.#busy = true;
  }

  #checkTools(options: LanguageModelV4CallOptions): void {
    const tools = JSON.stringify(options.tools ?? []);
    if (this.#model.chatId === undefined || this.#tools === undefined) {
      // This call creates (or first attaches to) the chat and registers them.
      this.#tools = tools;
    } else if (tools !== this.#tools) {
      throw invalid(
        "the toolkit cannot change after the chat is created: chatd registers client tools only then",
        "tools",
      );
    }
  }
}
