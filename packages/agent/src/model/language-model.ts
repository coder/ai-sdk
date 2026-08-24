import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { assertSupportedAiVersion } from "../ai-version.js";
import { CoderAgentError, CoderApiError, CoderChatError, CoderStreamError } from "../errors.js";
import { CoderChatClient } from "../coder/client.js";
import type {
  ChatInputPart,
  ChatStatus,
  ChatStreamEvent,
  ChatStreamToolCall,
  CreateChatRequest,
} from "../coder/types.js";
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
import { SessionChatStream } from "./session-stream.js";
import { TurnTranslator } from "./translate.js";
import {
  safeTransportEmitter,
  type SegmentSettleTransportEvent,
  type SegmentStartTransportEvent,
  type TransportEventHandler,
} from "../transport-events.js";

/**
 * How long a segment that has settled into `requires_action` waits for the
 * `action_required` event before recovering the pending tool calls from chat
 * history over REST (see `#recoverRequiresAction`). Long enough that the
 * normal fast path — the event follows the status on the same connection,
 * typically within milliseconds — never fires it; short enough to turn a lost
 * event from a `requestTimeoutMs`-sized hang into a ~2s hiccup.
 */
const ACTION_REQUIRED_GRACE_MS = 2_000;

/** Sentinel resolved by the grace timer, distinguishable from a stream read. */
const GRACE_EXPIRED = Symbol("action-required-grace-expired");

/**
 * Sentinel resolved when the SEGMENT's abort signal fires. Segment reads race
 * this against the shared stream instead of wiring the signal into the stream
 * itself: the stream's fate is a session policy decided at segment exit (a
 * healthy client-tool pause survives its segment; every other exit closes the
 * stream), never a side effect of signal chaining.
 */
const SEGMENT_ABORTED = Symbol("segment-aborted");

function startGraceTimer(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof GRACE_EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(GRACE_EXPIRED), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

const EMPTY_USAGE: LanguageModelV4Usage = {
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
  /**
   * Observability hook: receives this model's `segment:*` transport events
   * (turn-segment start/settle with terminal status and timing). HTTP and
   * WebSocket events are emitted by the {@link CoderChatClient} — pass the
   * hook to its options too (CoderAgent wires both from one setting).
   * Exceptions it throws are swallowed; without it, no event objects are
   * allocated. See {@link CoderTransportEvent}.
   */
  onTransportEvent?: TransportEventHandler;
}

/**
 * A {@link LanguageModelV4} that is backed by a remote Coder `chatd` agent
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
 *
 * The session retains ONE event stream per turn (issue #44): a segment that
 * pauses for client tools leaves the WebSocket open, and the tool-result
 * resume segment keeps reading it — no re-dial per tool round trip. The
 * socket closes when its segment ends any other way (terminal settle, error,
 * abort, timeout), when the next turn replaces it, or on session teardown
 * (`resetSession()` / `[Symbol.asyncDispose]()`). A turn that pauses for
 * client tools but never resumes leaves the socket open until teardown, so
 * dispose or reset sessions you abandon mid-turn.
 */
export class CoderLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
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
  /** The turn-lifetime event stream, retained across client-tool pauses. */
  #retainedStream: SessionChatStream | undefined;
  /** Exception-isolated observability emitter for `segment:*` events. */
  readonly #emitTransportEvent: TransportEventHandler | undefined;
  #segmentSeq = 0;

  constructor(config: CoderLanguageModelConfig) {
    // Fail fast on an incompatible AI SDK major (see peer dependency `ai@^7`).
    assertSupportedAiVersion();
    this.#config = config;
    this.modelId = config.model ?? "chatd";
    this.#chatId = config.chatId;
    this.#emitTransportEvent = safeTransportEmitter(config.onTransportEvent);
  }

  get chatId(): string | undefined {
    return this.#chatId;
  }

  /**
   * Drops the current session so the next turn creates a fresh chat. Also
   * closes the retained event stream, if any (fire-and-forget — a sync reset
   * must not wait on socket teardown, and `close()` never rejects).
   */
  resetSession(): void {
    this.#chatId = undefined;
    this.#lastSeenMessageId = 0;
    this.#submittedToolCallIds.clear();
    const stream = this.#retainedStream;
    this.#retainedStream = undefined;
    if (stream) void stream.close();
  }

  /**
   * Closes the retained event stream, if any. The stream otherwise closes
   * when its turn settles or fails, or when the next turn replaces it — but a
   * turn that pauses for client tools and never resumes (e.g. the caller
   * stopped the tool loop, or aborted between segments) leaves the socket
   * open, so dispose (`await using`) or {@link resetSession} sessions you
   * abandon mid-turn.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    const stream = this.#retainedStream;
    this.#retainedStream = undefined;
    if (stream) await stream.close();
  }

  /**
   * Closes a stream retained by a client-tool pause. Called on explicit
   * interrupts ({@link CoderAgent.interrupt}): an interrupted pause is dead —
   * its buffer would otherwise collect the interrupt's own settle events,
   * which a later tool-result resume would consume as if they were the
   * resumed generation's (truncating the turn), and if the tool loop never
   * resumes the socket would outlive the explicit interrupt. A stream a
   * segment is actively reading is left alone: that segment observes the
   * settle the interrupt produces and closes the stream itself.
   */
  async closePausedStream(): Promise<void> {
    const stream = this.#retainedStream;
    if (!stream || stream.attached) return;
    this.#retainedStream = undefined;
    await stream.close();
  }

  /**
   * The stream a segment reads: a resume segment re-attaches to the stream
   * its predecessor left paused at `requires_action` (the whole point of
   * retention — no re-dial per tool round trip); everything else — a new
   * turn, or a pause the caller abandoned — replaces it with a fresh dial,
   * because a stale buffer from a settle this client never observed must not
   * leak into the new turn.
   */
  #acquireStream(resume: boolean, chatId: string, afterId: number | undefined): SessionChatStream {
    const retained = this.#retainedStream;
    if (resume && retained?.canAttach(chatId)) {
      retained.attach();
      return retained;
    }
    this.#retainedStream = undefined;
    if (retained) void retained.close();
    const created = new SessionChatStream({
      chatId,
      open: (streamSignal) =>
        this.#config.client.streamEvents(chatId, { afterId, signal: streamSignal }),
    });
    this.#retainedStream = created;
    return created;
  }

  /** Close `stream` and drop the retention slot if it still holds it. */
  async #closeStream(stream: SessionChatStream): Promise<void> {
    if (this.#retainedStream === stream) this.#retainedStream = undefined;
    await stream.close();
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
  #buildContent(
    content: UserContent,
    signal?: AbortSignal,
    onUpload?: () => void,
  ): Promise<ChatInputPart[]> {
    const uploadFile: FilePartUploader = async (f) => {
      const uploaded = await this.#config.client.uploadChatFile(
        this.#config.organizationId,
        { content: dataContentToFileContent(f.data), mediaType: f.mediaType, name: f.filename },
        signal,
      );
      onUpload?.();
      return uploaded.id;
    };
    return userContentToInputParts(content, uploadFile);
  }

  /**
   * REST fallback for a `requires_action` segment whose `action_required`
   * event never arrived: recover the turn's pending client tool calls from
   * committed chat history (`GET /chats/{id}/messages`) — the same history
   * chatd itself derives `action_required` from server-side. Returns synthetic
   * stream events for the translator: the turn's message snapshots first (so
   * text, usage, and the message cursor stay consistent even if the stream
   * also missed a commit — the translator's id-keyed dedup makes re-ingesting
   * already-delivered ones a no-op), then one `action_required` event carrying
   * the unresolved dynamic tool calls. Returns `[]` when history shows no
   * pending calls — nothing to recover, the caller keeps waiting on the
   * stream, bounded by `requestTimeoutMs`/abort.
   */
  async #recoverRequiresAction(
    chatId: string,
    dynamicNames: ReadonlySet<string>,
    afterId: number | undefined,
    signal?: AbortSignal,
  ): Promise<ChatStreamEvent[]> {
    // Fetch WITHOUT an `after_id` cursor: cursored reads page ASCENDING
    // (oldest first), so a long turn would truncate away the newest messages
    // — exactly where the pending call lives. A cursor-less read pages
    // newest-first, which guarantees the last assistant message and
    // everything after it (the inputs of the derivation below) are on the
    // FIRST page; `has_more` then only refers to older history we don't
    // need. The turn filter is applied client-side instead.
    const { messages } = await this.#config.client.getMessages(chatId, { limit: 200 }, signal);
    // Restrict to this turn's messages (the translator would skip older ids
    // anyway, but the derivation must not see earlier turns), in id order.
    const turnMessages = messages.filter((m) => m.id > (afterId ?? 0)).sort((a, b) => a.id - b.id);
    // Mirror chatd's own derivation (`actionRequiredFromHistory` →
    // `unresolvedToolCallsFromHistory`): the pending calls are the LAST
    // assistant message's non-provider-executed dynamic tool-call parts,
    // minus ids already handled by later messages' tool results.
    const lastAssistant = turnMessages.findLast((m) => m.role === "assistant");
    if (!lastAssistant) return [];
    const handled = new Set<string>();
    for (const message of turnMessages) {
      if (message.id <= lastAssistant.id) continue;
      for (const part of message.content ?? []) {
        if (part.type === "tool-result" && part.tool_call_id) handled.add(part.tool_call_id);
      }
    }
    const toolCalls: ChatStreamToolCall[] = [];
    for (const part of lastAssistant.content ?? []) {
      if (part.type !== "tool-call" || part.provider_executed) continue;
      if (!part.tool_call_id || !part.tool_name) continue;
      if (!dynamicNames.has(part.tool_name)) continue;
      if (handled.has(part.tool_call_id)) continue;
      // A call whose result this instance already submitted must not be
      // re-emitted — the AI SDK would execute the tool a second time.
      if (this.#submittedToolCallIds.has(part.tool_call_id)) continue;
      toolCalls.push({
        tool_call_id: part.tool_call_id,
        tool_name: part.tool_name,
        // `action_required` carries args as their raw JSON text (chatd sends
        // `string(part.Args)` of the history part's json.RawMessage);
        // re-encoding the snapshot's parsed JSON value reconstructs it. A
        // JSON `null` is a legitimate argument value and must survive; only
        // an ABSENT args field falls back to empty-object args.
        args: JSON.stringify(part.args === undefined ? {} : part.args),
      });
    }
    if (toolCalls.length === 0) return [];
    const events: ChatStreamEvent[] = turnMessages.map((message) => ({
      type: "message",
      chat_id: chatId,
      message,
    }));
    events.push({
      type: "action_required",
      chat_id: chatId,
      action_required: { tool_calls: toolCalls },
    });
    return events;
  }

  /**
   * Wraps {@link #runTurnInner} with `segment:start`/`segment:settle`
   * observability events. A pure pass-through without a subscriber — no
   * counters, clocks, or event objects on the unobserved path. The settle
   * event is emitted in a `finally`, so every started segment settles exactly
   * once: cleanly (with the terminal status carried by the `finish` part that
   * streamed through), with an `error` summary, or — when the consumer tears
   * the stream down mid-segment — with neither. Consumer teardown has two
   * shapes: a plain generator return (no catch runs), and a
   * `ReadableStream.cancel()` that {@link doStream} routes through an abort to
   * unblock a pending socket read — the latter surfaces here as an abort
   * throw, so `isConsumerCancel` (supplied by `doStream`) reclassifies it as
   * teardown rather than a failed segment.
   */
  async *#runTurn(
    options: LanguageModelV4CallOptions,
    isConsumerCancel?: () => boolean,
  ): AsyncGenerator<LanguageModelV4StreamPart, void, void> {
    const emit = this.#emitTransportEvent;
    if (!emit) {
      yield* this.#runTurnInner(options);
      return;
    }
    const segment = ++this.#segmentSeq;
    const startedAt = performance.now();
    const startEvent: SegmentStartTransportEvent = {
      type: "segment:start",
      segment,
      timestamp: Date.now(),
    };
    if (this.#chatId !== undefined) startEvent.chatId = this.#chatId;
    emit(startEvent);
    let finishReason: LanguageModelV4GenerateResult["finishReason"] | undefined;
    let failure: unknown;
    let failed = false;
    try {
      for await (const part of this.#runTurnInner(options)) {
        if (part.type === "finish") finishReason = part.finishReason;
        yield part;
      }
    } catch (err) {
      // An intentional consumer cancel is a teardown, not a failed segment —
      // even though it reaches the turn as an abort (see the doc comment).
      if (!isConsumerCancel?.()) {
        failure = err;
        failed = true;
      }
      throw err;
    } finally {
      const settleEvent: SegmentSettleTransportEvent = {
        type: "segment:settle",
        segment,
        durationMs: performance.now() - startedAt,
        timestamp: Date.now(),
      };
      if (this.#chatId !== undefined) settleEvent.chatId = this.#chatId;
      if (failed) {
        settleEvent.error = {
          name: failure instanceof Error ? failure.name : "Error",
          message: failure instanceof Error ? failure.message : String(failure),
        };
      } else if (finishReason !== undefined) {
        // finishReason.raw is the translator's terminal chat status.
        if (finishReason.raw !== undefined) settleEvent.status = finishReason.raw as ChatStatus;
        settleEvent.finishReason = finishReason.unified;
      }
      emit(settleEvent);
    }
  }

  async *#runTurnInner(
    options: LanguageModelV4CallOptions,
  ): AsyncGenerator<LanguageModelV4StreamPart, void, void> {
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

    // Declared here so `finally` can read whether the turn settled; constructed
    // only once the turn's starting message id is known (see `turnCursor`).
    let translator: TurnTranslator | undefined;

    // Whether this call took ownership of the session stream (#acquireStream
    // ran). Until then, a stream retained by the PREDECESSOR segment's pause
    // has no owner watching it — a REST-phase failure below must close it
    // (see the outer finally) rather than leave it retained: the turn is dead
    // (and the run interrupted), so a caller retry attaching to its buffer
    // would read interrupt-era events and end before the resumed generation.
    let streamAcquired = false;

    // Set when a stream failure kills a chat that THIS call created: the
    // `finally` then drops the session (after interrupting the dead run) so an
    // automatic whole-call retry replays the turn on a fresh chat.
    let discardSession = false;

    // Interrupting the *server* run (not just closing the WebSocket) is what frees
    // the chat's workspace/resources. Fire it at most once — on abort/timeout, and
    // on teardown of an unsettled turn (see `finally`), which also covers stream
    // `cancel()` and premature close, neither of which aborts the signal. A chat
    // whose id we never received (createChat aborted mid-flight) can't be reached.
    let interruptSent = false;
    // The turn's own chat id, captured once known: the interrupt must reach
    // THIS turn's run even after a concurrent resetSession() cleared the
    // session id mid-segment (which also closes the attached stream and fails
    // the segment — whose teardown then still stops the orphaned server run).
    let turnChatId: string | undefined;
    const interrupt = (): void => {
      const id = turnChatId ?? this.#chatId;
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
      const warnings: SharedV4Warning[] = [];
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
      // Whether THIS call created the chat — the one case where an automatic
      // whole-call retry after a stream failure is safe (see the
      // CoderStreamError handling below).
      let turnCreatedChat = false;
      // Whether this call uploaded inline file attachments — an external
      // effect a whole-call retry would repeat, creating redundant file
      // records (pre-uploaded `fileId` references don't set this).
      let uploadedAttachment = false;
      // Whether the chat ended up bound to a workspace — configured OR
      // assigned server-side by the deployment (createChat's response says).
      // Either way its tools can have non-idempotent effects a replay would
      // repeat.
      let chatHasWorkspace = Boolean(this.#config.workspaceId);

      // A fresh instance resuming an existing chat (config.chatId) has no
      // message cursor yet. Without one, a queued submission or a tool-result
      // resume falls back to afterId 0: the server replays the chat's FULL
      // history and this turn would absorb every earlier turn's content and
      // usage. Seed the cursor from the chat's newest message instead (the
      // messages endpoint pages newest-first; an empty chat has nothing to
      // replay, so 0 stays correct there).
      if (this.#chatId && this.#lastSeenMessageId === 0) {
        const { messages } = await this.#config.client.getMessages(
          this.#chatId,
          { limit: 1 },
          signal,
        );
        this.#lastSeenMessageId = messages[0]?.id ?? 0;
      }

      if (action.kind === "new-turn") {
        // Resolve the model config and upload any file parts concurrently — they
        // are independent round-trips. (Uploads run before the chat exists and
        // resolve file parts to `file` input parts referencing their uploaded ids.)
        const [modelConfigId, content] = await Promise.all([
          this.#resolveModelConfigId(signal),
          this.#buildContent(action.content, signal, () => {
            uploadedAttachment = true;
          }),
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
          turnCreatedChat = true;
          if (chat.workspace_id) chatHasWorkspace = true;
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
      turnChatId = chatId;
      // Only messages past the turn's starting cursor belong to this turn —
      // resuming a chat replays earlier turns' messages (usage included), and
      // a mid-turn history reset re-sends them again. Constructing the
      // translator with the cursor makes it impossible to ingest before the
      // boundary is known.
      const dynamicNames = dynamicToolNames(options.tools);
      translator = new TurnTranslator({
        dynamicToolNames: dynamicNames,
        turnCursor: afterId ?? 0,
        // The retained stream redials with the TURN's original cursor, so a
        // reconnect can replay an earlier segment's `action_required`
        // snapshot; calls this session already answered must not run again.
        submittedToolCallIds: this.#submittedToolCallIds,
      });
      // chatd emits the `requires_action` status BEFORE the `action_required`
      // event that carries the pending tool calls, so for that status we keep
      // reading until the client tool calls have actually been emitted (bounded
      // by a safety counter, since the stream is a live subscription). The
      // event can also never arrive at all — consumed by a previous connection
      // across a reconnect race, or a server-side hiccup between the status
      // flip and the history-derived event — and on a quiet socket the read
      // would then block until requestTimeoutMs (minutes) and fail a turn
      // whose tool calls have been sitting fully committed in chat history
      // the whole time. So once `requires_action` settles without a client
      // tool call, a grace timer races the pending read; if it expires, the
      // tool calls are recovered from history over REST instead
      // (#recoverRequiresAction) — one shot per segment, never on the fast
      // path, still bounded by requestTimeoutMs/abort.
      let sinceRequiresAction = 0;
      let grace: ReturnType<typeof startGraceTimer> | undefined;
      // The in-flight recovery fetch. It races the pending stream read rather
      // than being awaited serially: a slow or hanging REST request must not
      // block a late stream event from completing the segment (with
      // requestTimeoutMs unset, a serial await could hang the turn on the
      // fetch indefinitely — the very failure mode this fallback removes).
      // Failures resolve to [] (best-effort): the segment then keeps waiting
      // on the stream, bounded by requestTimeoutMs/abort as before.
      let recovery: Promise<ChatStreamEvent[]> | undefined;
      let recoveryAbort: AbortController | undefined;
      let recoveryAttempted = false;
      // One stream per TURN, not per segment: a resume segment re-attaches to
      // the stream its predecessor left paused at `requires_action`; anything
      // else dials fresh (see #acquireStream). The stream is bound to its OWN
      // lifetime signal — the segment signal instead races reads below, so an
      // abort/timeout detaches this segment without killing the shared socket.
      const stream = this.#acquireStream(action.kind === "resume", chatId, afterId);
      streamAcquired = true;
      let onSegmentAbort: (() => void) | undefined;
      const segmentAborted: Promise<typeof SEGMENT_ABORTED> | undefined = signal
        ? new Promise((resolve) => {
            onSegmentAbort = () => resolve(SEGMENT_ABORTED);
            if (signal.aborted) onSegmentAbort();
            else signal.addEventListener("abort", onSegmentAbort, { once: true });
          })
        : undefined;
      const raceSegment = <T>(p: Promise<T>): Promise<T | typeof SEGMENT_ABORTED> =>
        segmentAborted ? Promise.race([p, segmentAborted]) : p;
      // Whether the segment settled at a healthy client-tool pause — the one
      // exit that keeps the stream for the next segment (see the finally).
      let retainStream = false;
      try {
        for (;;) {
          // The stream memoizes its pending read: this either starts a fresh
          // read or adopts one an earlier iteration (or segment) raced out —
          // an event resolved while nobody was consuming is delivered here,
          // never dropped.
          const next = stream.read();
          const awaitingActionRequired =
            translator.terminalStatus === "requires_action" && !translator.clientToolCallSeen;
          if (!awaitingActionRequired && (grace !== undefined || recoveryAttempted)) {
            // The requires_action that armed this wait state was stale — a
            // replayed connect-time snapshot from a redial, cleared by a later
            // non-terminal transition (the chat is generating again). Re-arm
            // the one-shot fallback so a REAL pause later in this segment
            // gets its own grace timer and recovery fetch.
            grace?.cancel();
            grace = undefined;
            recoveryAbort?.abort();
            recoveryAbort = undefined;
            recovery = undefined;
            recoveryAttempted = false;
            sinceRequiresAction = 0;
          }
          let raced:
            | IteratorResult<ChatStreamEvent, void>
            | ChatStreamEvent[]
            | typeof GRACE_EXPIRED
            | typeof SEGMENT_ABORTED;
          if (awaitingActionRequired && !recoveryAttempted) {
            // One timer for the whole wait (not per event), so a server that
            // keeps sending unrelated events cannot postpone the fallback.
            grace ??= startGraceTimer(ACTION_REQUIRED_GRACE_MS);
            raced = await raceSegment(Promise.race([next, grace.expired]));
            if (raced === GRACE_EXPIRED) {
              recoveryAttempted = true;
              // Defensive: if the grace timer beat a concurrent abort,
              // classify before fetching.
              throwIfAborted();
              // A recovery-specific controller (chained to the turn signal)
              // so the losing fetch is canceled when the stream wins or the
              // turn tears down — a hung request must not outlive the
              // segment and leak its connection.
              recoveryAbort = new AbortController();
              recovery = this.#recoverRequiresAction(
                chatId,
                dynamicNames,
                afterId,
                signal ? AbortSignal.any([signal, recoveryAbort.signal]) : recoveryAbort.signal,
              ).catch(() => []);
              continue;
            }
          } else if (awaitingActionRequired && recovery) {
            raced = await raceSegment(Promise.race([next, recovery]));
            if (Array.isArray(raced)) {
              recovery = undefined;
              // An aborted fetch resolves [] through the catch above —
              // classify instead of silently waiting out the timeout.
              throwIfAborted();
              for (const ev of raced) for (const part of translator.ingest(ev)) yield part;
              // The losing read stays memoized on the stream — the resume
              // segment adopts it (read() is rejection-tagged, so a late
              // failure while paused cannot surface as unhandled).
              if (translator.clientToolCallSeen) break;
              continue; // nothing recovered — keep waiting on the stream
            }
          } else {
            raced = await raceSegment(next);
          }
          if (raced === SEGMENT_ABORTED) {
            throwIfAborted();
            // Unreachable: the sentinel only resolves once `signal` aborted.
            throw new CoderAgentError("segment abort sentinel resolved without an abort");
          }
          stream.consumed(next);
          if (raced.done) break;
          for (const part of translator.ingest(raced.value)) yield part;
          const status = translator.terminalStatus;
          if (status) {
            if (status !== "requires_action") break;
            if (translator.clientToolCallSeen) break;
            if (++sinceRequiresAction > 200) break;
          }
        }
        // A healthy pause — the turn continues with a tool-result resume, so
        // the stream is retained (the finally pauses it). Every other exit
        // (terminal settle, error settle, premature end) closes it. Never
        // retain past an error settle (the SDK ends the turn there), and
        // never past an abort — one can land while the generator is suspended
        // yielding the settle's tool-call parts, after which this segment
        // still rejects (post-loop throwIfAborted): its pause was never
        // delivered, so a retry must redial fresh and recover the pause from
        // the connect-time snapshot instead of attaching to a socket whose
        // already-consumed requires_action events will not be re-sent.
        retainStream =
          !signal?.aborted &&
          translator.terminalStatus === "requires_action" &&
          translator.clientToolCallSeen &&
          !translator.error;
      } catch (err) {
        // Abort surfaces here only if the reader threw instead of closing cleanly;
        // prefer the abort/timeout classification.
        throwIfAborted();
        // The reader redials dropped connections internally (with `after_id`
        // catch-up), so what escapes it is terminal: a CoderApiError (4xx
        // upgrade rejection, re-thrown as-is), a CoderStreamError (redial
        // budget exhausted, or undedupable old-server deltas; handled below),
        // or a bare CoderAgentError (unparseable frame). Surface the latter as
        // a retryable stream failure so a caller's `CoderChatError &&
        // retryable` retry path catches it instead of seeing a bare,
        // non-retryable error.
        //
        // An AI-SDK `maxRetries` retry re-invokes this model with the SAME
        // prompt, and `#runTurn` would submit it AGAIN as a new user turn.
        // That is only safe when BOTH hold: this very call created the chat
        // (discarding the dead session — its run is being interrupted anyway —
        // lets the retry replay the whole turn on a FRESH chat), and the chat
        // has no server-side effectful tooling (a bound workspace or MCP
        // servers), whose tools may have executed before the stream died and
        // would run AGAIN on a replay; the async interrupt cannot undo, or
        // even reliably outrace, such external effects. Client tools are the
        // SDK's own tool loop, which restarts cleanly with the fresh chat. A
        // chat with prior state — resumed sessions, later turns, tool-result
        // segments — would be corrupted by any re-submission. In the unsafe
        // cases the error is downgraded to non-retryable and the caller owns
        // the retry/resume decision.
        if (err instanceof CoderStreamError) {
          if (turnCreatedChat) {
            // Nothing worth keeping: the chat's only content is this failed,
            // interrupted turn, and a later manual generate() on this instance
            // must not attach to it either.
            discardSession = true;
          }
          const effectful =
            chatHasWorkspace || Boolean(this.#config.mcpServerIds?.length) || uploadedAttachment;
          if (turnCreatedChat && !effectful) throw err;
          throw new CoderStreamError({
            message: `${err.message}; automatic retry is disabled because ${
              turnCreatedChat
                ? "the turn has server-side effects a replay would repeat (workspace/MCP tools that may have executed, or freshly uploaded attachments)"
                : "the chat has prior state (a retry would resubmit this turn's prompt as a new user turn)"
            }`,
            url: err.url,
            cause: err,
            isRetryable: false,
          });
        }
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
      } finally {
        grace?.cancel();
        // Cancel a still-pending (losing) recovery fetch: the segment's exit
        // must not leave its HTTP request alive. (Settled/consumed recovery
        // makes this a no-op; the fetch rejection resolves to [] above.)
        recoveryAbort?.abort();
        if (signal && onSegmentAbort) signal.removeEventListener("abort", onSegmentAbort);
        // The stream's fate, by exit kind: a healthy client-tool pause
        // retains it (paused) for the resume segment, with a read outstanding
        // so a drop during tool execution redials in the background; every
        // other exit — terminal settle, error settle, fatal stream error,
        // premature end, consumer teardown mid-loop, abort/timeout — closes
        // it. An aborted segment's stream could never be reused anyway (its
        // half-consumed in-progress episode cannot be re-read), so leaving it
        // open would only leak the socket until session teardown. Note the
        // close is still a policy decision made HERE, not signal-chaining:
        // the segment's signal never reaches the shared stream, which is what
        // lets the healthy pause outlive its segment.
        if (retainStream && !signal?.aborted && !stream.closed) {
          stream.pause();
        } else {
          await this.#closeStream(stream);
        }
      }

      // An abort can slip past the loop (e.g. it settled a race the segment
      // never awaited again); classify before treating the end as normal.
      throwIfAborted();

      // No terminal status: the stream ended before the turn settled — with
      // the reader redialing drops internally, a clean `done` means the
      // session stream was closed underneath this segment (resetSession or
      // dispose mid-turn). If an `error` event arrived (without a trailing
      // `status: error`), fall through to finish() so the real error surfaces
      // (unified:"error" + the error part), consistent with the
      // `status: error` path; otherwise surface the premature close rather
      // than a clean (truncated) `stop`.
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
      if (translator && translator.maxMessageId > this.#lastSeenMessageId)
        this.#lastSeenMessageId = translator.maxMessageId;
      signal?.removeEventListener("abort", interrupt);
      // Teardown of an unsettled turn — stream cancel(), premature close, or an
      // abort the listener didn't cover — interrupt the server so it stops.
      // (A turn that failed before streaming has no translator and never
      // settled, so it interrupts too.) A transient transport drop never gets
      // here: the reader redials internally, so an unsettled exit means abort,
      // timeout, a terminal stream failure (4xx / redial budget exhausted /
      // unparseable frame), or a REST-phase error — all cases where the healthy
      // server run must not keep burning tokens on an audience of zero.
      if (!translator?.terminalStatus) interrupt();
      // A failure before the stream section ran (REST phase: tool-result
      // submission, uploads, chat creation, cursor seeding) leaves the
      // predecessor segment's paused stream ownerless while its turn is now
      // dead — and the interrupt above pushes interrupt-era events into its
      // buffer. Close it: an abandoned call must not leak the socket, and a
      // caller retry must dial fresh instead of attaching to that buffer.
      if (!streamAcquired && this.#retainedStream) {
        const stale = this.#retainedStream;
        this.#retainedStream = undefined;
        void stale.close();
      }
      // Ordered after the interrupt (which needs the chat id) and after the
      // cursor advance above (which the reset zeroes out again).
      if (discardSession) this.resetSession();
      this.#inFlight = false;
    }
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    // A consumer can tear the stream down via ReadableStream.cancel() without
    // aborting options.abortSignal. Route cancel through an abort so the turn
    // interrupts the server run and the blocked stream reader unblocks — a bare
    // gen.return() would deadlock on a pending socket read and never reach the
    // interrupt, leaking the workspace.
    const cancelController = new AbortController();
    const abortSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, cancelController.signal])
      : cancelController.signal;
    const gen = this.#runTurn({ ...options, abortSignal }, () => cancelController.signal.aborted);
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
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

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const content: LanguageModelV4Content[] = [];
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    let usage: LanguageModelV4Usage = EMPTY_USAGE;
    let finishReason: LanguageModelV4GenerateResult["finishReason"] = {
      unified: "stop",
      raw: undefined,
    };
    let providerMetadata: LanguageModelV4GenerateResult["providerMetadata"];
    const warnings: LanguageModelV4GenerateResult["warnings"] = [];

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
          providerMetadata = part.providerMetadata;
          break;
        case "error":
          throw part.error instanceof Error
            ? part.error
            : new CoderChatError({ message: String(part.error) });
        default:
          break;
      }
    }

    return {
      content,
      finishReason,
      usage,
      warnings,
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }
}
