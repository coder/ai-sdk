import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { CoderAgentError, CoderApiError, CoderChatError } from "../errors.js";
import { CoderChatClient } from "../coder/client.js";
import type { ChatInputPart, CreateChatRequest } from "../coder/types.js";
import { dataContentToFileContent } from "../files.js";
import {
  classifyTurnAction,
  dynamicToolNames,
  extractSystemPrompt,
  type FilePartUploader,
  toolsToDynamicTools,
  type UserContent,
  userContentToInputParts,
} from "./prompt.js";
import { TurnTranslator } from "./translate.js";

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export interface CoderLanguageModelConfig {
  client: CoderChatClient;
  organizationId: string;
  /** Model hint (UUID, `provider:model`, model id, or display-name substring). */
  model?: string;
  /** Bind the chat to a Coder workspace (enables workspace tools). */
  workspaceId?: string;
  /** chatd-side MCP servers to enable. */
  mcpServerIds?: string[];
  planMode?: "" | "plan";
  /** Resume an existing chat instead of creating a new one. */
  chatId?: string;
  /**
   * Per-segment time budget in milliseconds, applied to each model round-trip
   * (one `doStream`/`doGenerate` call: chat creation or message/tool-result
   * submission, plus the server-side run until it settles or pauses for a client
   * tool). If exceeded, the run is interrupted server-side and the call rejects
   * with a retryable {@link CoderChatError} (`kind: "timeout"`). A multi-step
   * `generate()` that drives client tools makes several segments, so this bounds
   * each segment, not the whole call — to cap total wall-clock, pass
   * `abortSignal: AbortSignal.timeout(ms)`. Unset or non-positive means no limit.
   */
  requestTimeoutMs?: number;
}

/**
 * A {@link LanguageModelV3} that is backed by a remote Coder `chatd` agent
 * runtime instead of a raw LLM. One model instance owns one chatd chat
 * (a "session"): the chat is created lazily on the first turn and reused for
 * subsequent turns and for client-tool resume steps.
 *
 * The chatd server runs the agent loop (model calls, server-side tools,
 * compaction) itself. This model therefore represents *one chatd segment* per
 * `doStream` call — it advances the chat until it settles (`waiting`/
 * `completed`) or pauses for a client tool (`requires_action`). When the AI SDK
 * executes a client tool and calls `doStream` again with the tool result, this
 * model resumes the same chat. The two loops mesh at the client-tool boundary.
 *
 * NOTE: a single model instance is single-flight — do not run concurrent
 * generations against the same instance/session.
 */
export class CoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "coder.chatd";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly #config: CoderLanguageModelConfig;
  #chatId: string | undefined;
  #lastSeenMessageId = 0;
  #resolvedModelConfigId: string | undefined;
  #modelResolved = false;
  readonly #submittedToolCallIds = new Set<string>();
  #inFlight = false;

  constructor(config: CoderLanguageModelConfig) {
    this.#config = config;
    this.modelId = config.model ?? "chatd";
    this.#chatId = config.chatId;
  }

  get chatId(): string | undefined {
    return this.#chatId;
  }

  /** Drops the current session so the next turn creates a fresh chat. */
  resetSession(): void {
    this.#chatId = undefined;
    this.#lastSeenMessageId = 0;
    this.#submittedToolCallIds.clear();
  }

  async #resolveModelConfigId(signal?: AbortSignal): Promise<string | undefined> {
    if (this.#modelResolved) return this.#resolvedModelConfigId;
    if (this.#config.model) {
      this.#resolvedModelConfigId = await this.#config.client.resolveModelConfigId(
        this.#config.model,
        signal,
      );
    }
    this.#modelResolved = true;
    return this.#resolvedModelConfigId;
  }

  /**
   * Resolve a user message's content to chatd input parts, uploading any file
   * parts to chat-file storage (the upload endpoint needs only the organization
   * id, so this runs before the chat exists). Pre-uploaded files carried via
   * `providerOptions.coder.fileId` are referenced without re-uploading.
   */
  #buildContent(content: UserContent, signal?: AbortSignal): Promise<ChatInputPart[]> {
    const uploadFile: FilePartUploader = async (f) => {
      const uploaded = await this.#config.client.uploadChatFile(
        this.#config.organizationId,
        { content: dataContentToFileContent(f.data), mediaType: f.mediaType, name: f.filename },
        signal,
      );
      return uploaded.id;
    };
    return userContentToInputParts(content, uploadFile);
  }

  async *#runTurn(
    options: LanguageModelV3CallOptions,
  ): AsyncGenerator<LanguageModelV3StreamPart, void, void> {
    // A single model instance owns one chatd session's mutable state, so it is
    // single-flight: reject overlapping turns rather than silently corrupting
    // chatId / lastSeenMessageId / submitted tool-call tracking.
    if (this.#inFlight) {
      throw new CoderAgentError(
        "A generation is already in flight on this CoderAgent (single-flight). Use a separate CoderAgent instance for concurrent sessions.",
      );
    }
    this.#inFlight = true;

    // Combine the caller's abort signal with an optional per-turn timeout into a
    // single signal (the platform composes and cleans these up for us). When
    // there's neither a caller signal nor a timeout, `signal` stays undefined and
    // there is no per-turn setup. Keep a reference to our *own* timeout signal so
    // a timeout stays distinguishable from a caller abort — even when the caller's
    // own signal is itself an `AbortSignal.timeout` (whose reason is a TimeoutError
    // too, so reason-sniffing alone would misclassify it).
    const externalSignal = options.abortSignal;
    const timeoutMs = this.#config.requestTimeoutMs;
    const timeoutSignal =
      timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const sources = [externalSignal, timeoutSignal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const signal: AbortSignal | undefined =
      sources.length > 0 ? AbortSignal.any(sources) : undefined;

    // Translator is hoisted so `finally` can read whether the turn settled.
    const translator = new TurnTranslator({ dynamicToolNames: dynamicToolNames(options.tools) });

    // Interrupting the *server* run (not just closing the WebSocket) is what frees
    // the chat's workspace/resources. Fire it at most once — on abort/timeout, and
    // on teardown of an unsettled turn (see `finally`), which also covers stream
    // `cancel()` and premature close, neither of which aborts the signal. A chat
    // whose id we never received (createChat aborted mid-flight) can't be reached.
    let interruptSent = false;
    const interrupt = (): void => {
      const id = this.#chatId;
      if (interruptSent || !id) return;
      interruptSent = true;
      void this.#config.client.interruptChat(id).catch(() => {});
    };
    signal?.addEventListener("abort", interrupt, { once: true });

    // Map an abort of the combined signal to the right error. Our own
    // `timeoutSignal` having fired means a per-turn timeout; otherwise it's a
    // caller abort, re-thrown as the caller's reason (preserving AbortError so the
    // AI SDK still recognizes the cancellation).
    const throwIfAborted = (): void => {
      if (timeoutSignal?.aborted) {
        throw new CoderChatError({
          message: `Coder Agent turn exceeded its ${timeoutMs}ms requestTimeoutMs budget.`,
          kind: "timeout",
          retryable: true,
        });
      }
      if (signal?.aborted) {
        throw (
          externalSignal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
        );
      }
    };

    try {
      const { prompt } = options;

      // chatd does not constrain output to a JSON schema server-side, so a
      // `responseFormat: json` request can't be honored. Warn rather than
      // silently mislead — schema-constrained output should go through the
      // provider (@coder/ai-sdk-provider) instead.
      const warnings: SharedV3Warning[] = [];
      if (options.responseFormat?.type === "json") {
        warnings.push({
          type: "unsupported",
          feature: "responseFormat",
          details:
            "Coder Agents does not enforce a JSON schema server-side, so structured output is best-effort (not schema-constrained). For reliable structured output, use @coder/ai-sdk-provider (createCoder) with generateObject / Output.object.",
        });
      }
      yield { type: "stream-start", warnings };

      const action = classifyTurnAction(prompt);
      if (action.kind === "noop") {
        throw new CoderAgentError(
          "CoderAgent received a prompt with no user message or tool results to act on.",
        );
      }

      let afterId: number | undefined;

      if (action.kind === "new-turn") {
        // Resolve the model config and upload any file parts concurrently — they
        // are independent round-trips. (Uploads run before the chat exists and
        // resolve file parts to `file` input parts referencing their uploaded ids.)
        const [modelConfigId, content] = await Promise.all([
          this.#resolveModelConfigId(signal),
          this.#buildContent(action.content, signal),
        ]);
        if (!this.#chatId) {
          const req: CreateChatRequest = {
            organization_id: this.#config.organizationId,
            content,
            client_type: "api",
          };
          const system = extractSystemPrompt(prompt);
          if (system) req.system_prompt = system;
          const tools = toolsToDynamicTools(options.tools);
          if (tools.length > 0) req.unsafe_dynamic_tools = tools;
          if (modelConfigId) req.model_config_id = modelConfigId;
          if (this.#config.workspaceId) req.workspace_id = this.#config.workspaceId;
          if (this.#config.mcpServerIds?.length) req.mcp_server_ids = this.#config.mcpServerIds;
          if (this.#config.planMode) req.plan_mode = this.#config.planMode;
          const chat = await this.#config.client.createChat(req, signal);
          this.#chatId = chat.id;
          afterId = this.#lastSeenMessageId > 0 ? this.#lastSeenMessageId : undefined;
        } else {
          const resp = await this.#config.client.createChatMessage(
            this.#chatId,
            {
              content,
              ...(modelConfigId ? { model_config_id: modelConfigId } : {}),
            },
            signal,
          );
          afterId = resp.message?.id ?? this.#lastSeenMessageId;
        }
      } else {
        // resume
        if (!this.#chatId)
          throw new CoderChatError({ message: "cannot submit tool results before a chat exists" });
        const fresh = action.toolResults.filter(
          (r) => !this.#submittedToolCallIds.has(r.tool_call_id),
        );
        if (fresh.length > 0) {
          await this.#config.client.submitToolResults(this.#chatId, { results: fresh }, signal);
          for (const r of fresh) this.#submittedToolCallIds.add(r.tool_call_id);
        }
        afterId = this.#lastSeenMessageId;
      }

      const chatId = this.#chatId as string;
      // chatd emits the `requires_action` status BEFORE the `action_required`
      // event that carries the pending tool calls, so for that status we keep
      // reading until the client tool calls have actually been emitted (bounded
      // by a safety counter, since the stream is a live subscription).
      let sinceRequiresAction = 0;
      try {
        for await (const ev of this.#config.client.streamEvents(chatId, { afterId, signal })) {
          for (const part of translator.ingest(ev)) yield part;
          const status = translator.terminalStatus;
          if (status) {
            if (status !== "requires_action") break;
            if (translator.clientToolCallSeen) break;
            if (++sinceRequiresAction > 200) break;
          }
        }
      } catch (err) {
        // Abort surfaces here only if the reader threw instead of closing cleanly;
        // prefer the abort/timeout classification.
        throwIfAborted();
        // The reader only throws transport-level CoderAgentErrors (socket error /
        // unparseable frame). Surface them as a retryable stream failure so a
        // caller's `CoderChatError && retryable` retry path catches a dropped
        // connection instead of seeing a bare, non-retryable error.
        if (
          err instanceof CoderAgentError &&
          !(err instanceof CoderApiError) &&
          !(err instanceof CoderChatError)
        ) {
          throw new CoderChatError({
            message: `Coder chat stream failed mid-turn: ${err.message}`,
            kind: "stream_closed",
            retryable: true,
          });
        }
        throw err;
      }

      // The stream loop exits cleanly when the socket closes on abort, so classify
      // an abort/timeout here before treating the end as a normal/closed turn.
      throwIfAborted();

      // No terminal status: the stream ended before the turn settled. If an
      // `error` event arrived (without a trailing `status: error`), fall through to
      // finish() so the real error surfaces (unified:"error" + the error part),
      // consistent with the `status: error` path; otherwise it's a genuine
      // premature close — surface it rather than a clean (truncated) `stop`.
      if (!translator.terminalStatus && !translator.error) {
        throw new CoderChatError({
          message:
            "Coder chat stream ended before the turn settled (connection closed or the server ended the stream without a terminal status).",
          kind: "stream_closed",
          retryable: true,
        });
      }

      for (const part of translator.finish()) yield part;
    } catch (err) {
      // A timeout/caller abort during the REST phase (createChat / message /
      // tool-results / model resolution) rejects the fetch before the stream loop;
      // reclassify so the documented retryable timeout/abort contract still holds.
      throwIfAborted();
      throw err;
    } finally {
      // Advance the cursor on every exit (success, abort, error) so resuming the
      // same chat doesn't re-read messages already streamed this turn.
      if (translator.maxMessageId > this.#lastSeenMessageId)
        this.#lastSeenMessageId = translator.maxMessageId;
      signal?.removeEventListener("abort", interrupt);
      // Teardown of an unsettled turn — stream cancel(), premature close, or an
      // abort the listener didn't cover — interrupt the server so it stops.
      if (!translator.terminalStatus) interrupt();
      this.#inFlight = false;
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    // A consumer can tear the stream down via ReadableStream.cancel() without
    // aborting options.abortSignal. Route cancel through an abort so the turn
    // interrupts the server run and the blocked stream reader unblocks — a bare
    // gen.return() would deadlock on a pending socket read and never reach the
    // interrupt, leaking the workspace.
    const cancelController = new AbortController();
    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, cancelController.signal])
      : cancelController.signal;
    const gen = this.#runTurn({ ...options, abortSignal });
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        try {
          const { value, done } = await gen.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          // A consumer-initiated cancel aborts the turn (to interrupt the server
          // and unblock the reader); that surfaces here as the turn's AbortError,
          // but it's an intentional teardown, so end the stream cleanly rather
          // than erroring it. A caller's own abortSignal still errors as usual.
          if (cancelController.signal.aborted) controller.close();
          else controller.error(err);
        }
      },
      async cancel() {
        cancelController.abort();
        await gen.return().catch(() => {});
      },
    });
    return { stream };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const content: LanguageModelV3Content[] = [];
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    let usage: LanguageModelV3Usage = EMPTY_USAGE;
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
      unified: "stop",
      raw: undefined,
    };
    const warnings: LanguageModelV3GenerateResult["warnings"] = [];

    for await (const part of this.#runTurn(options)) {
      switch (part.type) {
        case "stream-start":
          warnings.push(...part.warnings);
          break;
        case "text-start":
          textBuf.set(part.id, "");
          break;
        case "text-delta":
          textBuf.set(part.id, (textBuf.get(part.id) ?? "") + part.delta);
          break;
        case "text-end": {
          const t = textBuf.get(part.id) ?? "";
          if (t.length > 0) content.push({ type: "text", text: t });
          textBuf.delete(part.id);
          break;
        }
        case "reasoning-start":
          reasoningBuf.set(part.id, "");
          break;
        case "reasoning-delta":
          reasoningBuf.set(part.id, (reasoningBuf.get(part.id) ?? "") + part.delta);
          break;
        case "reasoning-end": {
          const t = reasoningBuf.get(part.id) ?? "";
          if (t.length > 0) content.push({ type: "reasoning", text: t });
          reasoningBuf.delete(part.id);
          break;
        }
        case "tool-call":
        case "tool-result":
        case "source":
        case "file":
          content.push(part);
          break;
        case "finish":
          usage = part.usage;
          finishReason = part.finishReason;
          break;
        case "error":
          throw part.error instanceof Error
            ? part.error
            : new CoderChatError({ message: String(part.error) });
        default:
          break;
      }
    }

    return { content, finishReason, usage, warnings };
  }
}
