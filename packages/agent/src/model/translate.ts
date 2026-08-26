import type {
  JSONObject,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { CoderChatError } from "../errors.js";
import {
  type ChatErrorPayload,
  type ChatMessage,
  type ChatMessagePart,
  type ChatMessageUsage,
  type ChatStatus,
  type ChatStreamEvent,
  TERMINAL_STATUSES,
} from "../coder/types.js";

/** `a + b` where an undefined operand contributes nothing; undefined only when both are. */
function addDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (b === undefined) return a;
  return (a ?? 0) + b;
}

/**
 * How each known wire usage field aggregates across a segment's steps:
 * counters sum; `context_limit` is a property of the model rather than a
 * counter, so the newest step's value wins. Typed against
 * {@link ChatMessageUsage} so adding a wire field without classifying it
 * fails the build instead of silently vanishing from the totals. Fields this
 * SDK doesn't know yet (newer servers) pass through with newest-wins
 * semantics so `usage.raw` stays the escape hatch for them.
 */
const USAGE_FIELD_KINDS = {
  input_tokens: "sum",
  output_tokens: "sum",
  total_tokens: "sum",
  reasoning_tokens: "sum",
  cache_creation_tokens: "sum",
  cache_read_tokens: "sum",
  total_cost_micros: "sum",
  total_runtime_ms: "sum",
  context_limit: "newest",
} as const satisfies Record<keyof ChatMessageUsage, "sum" | "newest">;

function mapUsage(u: ChatMessageUsage | undefined): LanguageModelV4Usage {
  // chatd normalizes provider usage so `input_tokens` counts only the UNCACHED
  // prompt tokens — cache reads/writes are reported separately (both Anthropic
  // and OpenAI are normalized this way server-side). The V4 `inputTokens.total`
  // is the full prompt size, so the cache components must be added back; with
  // prompt caching active, `input_tokens` alone is near zero.
  return {
    inputTokens: {
      total: addDefined(
        addDefined(u?.input_tokens, u?.cache_read_tokens),
        u?.cache_creation_tokens,
      ),
      noCache: u?.input_tokens,
      cacheRead: u?.cache_read_tokens,
      cacheWrite: u?.cache_creation_tokens,
    },
    outputTokens: {
      total: u?.output_tokens,
      text: undefined,
      reasoning: u?.reasoning_tokens,
    },
    // Preserve the turn's wire usage (snake_case) so callers can reach fields
    // the normalized shape has no slot for (context_limit, cost, runtime, …).
    ...(u ? { raw: u as unknown as JSONObject } : {}),
  };
}

/**
 * Sums per-message wire usage into segment totals. chatd attaches usage to
 * every assistant message it commits — one per internal model step — so the
 * segment's consumption is the sum over all of them, not the last message's
 * (the AI SDK then sums segments into the turn total). Fields stay absent
 * unless at least one message reported them (old servers keep looking
 * unchanged); non-counter and unknown fields take the newest reporting
 * message's value (see {@link USAGE_FIELD_KINDS}).
 */
function accumulateUsage(
  byMessageId: ReadonlyMap<number, ChatMessageUsage>,
): ChatMessageUsage | undefined {
  if (byMessageId.size === 0) return undefined;
  // Wire usage is parsed JSON; newer servers may send fields beyond
  // ChatMessageUsage, so accumulate on the JSON shape and narrow at the end.
  const total: JSONObject = {};
  // Map insertion order is not id order after a revision re-set, so track the
  // reporting message id per newest-wins key explicitly.
  const newestIdByKey = new Map<string, number>();
  for (const [id, u] of byMessageId) {
    for (const [key, value] of Object.entries(u)) {
      if (value === undefined) continue;
      if (USAGE_FIELD_KINDS[key as keyof ChatMessageUsage] === "sum" && typeof value === "number") {
        total[key] = ((total[key] as number | undefined) ?? 0) + value;
      } else if (id > (newestIdByKey.get(key) ?? -1)) {
        // `context_limit`, malformed counters, and any field this SDK doesn't
        // know yet: not summable — the newest reporting message's value wins,
        // which keeps `usage.raw` a forward-compatible escape hatch.
        newestIdByKey.set(key, id);
        total[key] = value;
      }
    }
  }
  return total as ChatMessageUsage;
}

function jsonResult(value: unknown): NonNullable<unknown> {
  // chatd tool results are arbitrary JSON; the V4 tool-result `result` must be
  // a non-null JSON value.
  return (value ?? {}) as NonNullable<unknown>;
}

/** A snapshot's full content of one kind, in wire order. */
function joinContent(content: readonly ChatMessagePart[], kind: "text" | "reasoning"): string {
  let full = "";
  for (const p of content) if (p.type === kind) full += p.text ?? "";
  return full;
}

/**
 * Canonical JSON of a decoded wire value: object keys sorted recursively, so
 * two decodings of the same server-side content compare equal regardless of
 * property order. Inputs are parsed JSON (plain objects/arrays/primitives —
 * never `undefined`, functions, or cycles), which keeps this total.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The attribution gate for a QUEUED submission (issue #114): the chat was
 * busy, so `createChatMessage` returned only a queue entry — no committed
 * message id — and everything on the stream between the pre-turn cursor and
 * the entry's materialization belongs to the chat's CURRENT (concurrent or
 * dying) run. While the gate is up, {@link TurnTranslator.ingest} attributes
 * NOTHING to this turn; it only scans for the turn's own user-message
 * snapshot, whose id then becomes the effective turn cursor.
 *
 * Correlation protocol (chatd has no wire-level queue-entry ↔ message id
 * link; the queue is strictly FIFO and both the queue entry and the
 * materialized message expose the same server-side content encoding):
 * - a `message` snapshot with role `user`, id past the cursor, and content
 *   structurally equal to the queue entry's becomes the CANDIDATE anchor;
 * - the `queue_update` that chatd emits after every queue change confirms
 *   it: our entry gone from the full queue list ⇒ the candidate is our
 *   materialization (anchor there); our entry still listed ⇒ the candidate
 *   was an EARLIER identical-content entry's materialization (drop it and
 *   keep waiting). Message snapshots that arrive between candidate and
 *   confirmation (a reconnect replays this turn's own commits before the
 *   connect-time `queue_update`) are buffered and replayed on anchor;
 * - without a queue-entry id to confirm against (older wire shapes), the
 *   first matching user message anchors directly.
 *
 * Dead ends fail fast instead of hanging until timeout: chatd does NOT
 * auto-promote the queue after an error settle, so an `error` event while
 * gated means the entry is stuck behind a dead chat; our entry vanishing from
 * `queue_update` without a candidate means it was deleted externally (or its
 * materialized form could not be correlated). Residual ambiguity — identical
 * concurrent submissions promoted within one replay window — needs a wire
 * correlation from chatd and is tracked as a follow-up.
 */
interface QueuedSubmissionGate {
  /** The queue-entry id from the submission response, when the wire sent one. */
  queuedId: number | undefined;
  /** Canonical content of the queue entry; undefined matches any user message. */
  expected: string | undefined;
  /** Latest matching user-message id awaiting `queue_update` confirmation. */
  candidateId: number | undefined;
  /** Message snapshots since the candidate, replayed through ingest on anchor. */
  buffered: ChatMessage[];
  /** Set when the wait can never complete; the model surfaces it as a throw. */
  deadEnd: ChatErrorPayload | undefined;
}

/** Constructor options for {@link TurnTranslator}. */
export interface TurnTranslatorOptions {
  dynamicToolNames: ReadonlySet<string>;
  turnCursor?: number;
  /**
   * Tool-call ids whose results the session already submitted. With the
   * stream retained across segments (and redialed with the turn's original
   * cursor), a reconnect can replay a previous segment's `action_required`
   * snapshot; re-emitting an already-answered call would make the AI SDK
   * execute the tool a second time. A live reference — the set grows as
   * later segments submit results.
   */
  submittedToolCallIds?: ReadonlySet<string>;
  /**
   * Present when the submission was QUEUED (`CreateChatMessageResponse`
   * carried no committed `message`): `turnCursor` is then only the PRE-TURN
   * cursor, and attribution is withheld until the queue entry materializes as
   * this turn's own user message — see {@link QueuedSubmissionGate} for the
   * correlation protocol. `id`/`content` come from the response's
   * `queued_message`; either may be absent on unexpected wire shapes, which
   * degrades matching (no confirmation / match-any) but never widens
   * attribution beyond the first observed user message.
   */
  queuedSubmission?: { id?: number; content?: readonly ChatMessagePart[] };
}

/**
 * Translates one chatd turn's {@link ChatStreamEvent} stream into a sequence of
 * `LanguageModelV4StreamPart`s for the AI SDK.
 *
 * Text/reasoning is reconciled against a per-message emitted-content ledger:
 * `message_part` deltas are emitted as they stream (they carry no message id,
 * so they accumulate as *pending* content), and each assistant `message`
 * snapshot attributes the pending content to its id and emits whatever suffix
 * of the snapshot's full content is still missing. That makes fast
 * snapshot-only messages (everything missing), trailing snapshots after deltas
 * (nothing missing), commit-during-disconnect snapshots (the tail the lost
 * deltas never delivered), and append-revisions of earlier messages (the
 * appended suffix) all the same operation — and a snapshot whose content does
 * not extend what was emitted (a byte-identical replay, or a rewrite that
 * cannot be expressed as deltas) is safely suppressed instead of
 * double-emitted.
 *
 * Client (custom) tool calls are emitted from the reliable `action_required`
 * event and left for the AI SDK to execute. chatd's own server-side tools are
 * surfaced best-effort as `providerExecuted` tool calls/results.
 *
 * A QUEUED submission additionally starts behind an attribution gate: until
 * the queue entry materializes as this turn's own user message, every event
 * belongs to the chat's concurrent run and is withheld (see
 * {@link QueuedSubmissionGate} and {@link TurnTranslatorOptions.queuedSubmission}).
 */
export class TurnTranslator {
  readonly #dynamicToolNames: ReadonlySet<string>;
  readonly #submittedToolCallIds: ReadonlySet<string>;

  #seq = 0;
  // `pending` accumulates delta content that has been emitted but not yet
  // attributed to a message id (deltas carry none); the next assistant
  // snapshot claims it. It survives block closes — a closed block loses its
  // stream id, never the record of what was emitted.
  #text = { id: undefined as string | undefined, pending: "" };
  #reasoning = { id: undefined as string | undefined, pending: "" };
  #currentAssistantId: number | undefined;
  // Whether text/reasoning deltas arrived since the last assistant `message`
  // snapshot — i.e. the next assistant snapshot is the trailing snapshot of the
  // message those deltas streamed (deltas carry no message id of their own).
  #deltasSinceSnapshot = false;

  #serverToolCalls = new Set<string>();
  #serverToolResults = new Set<string>();
  #clientToolCalls = new Set<string>();
  #clientToolCallSeen = false;
  #sources = new Set<string>();

  // Per-message wire usage, keyed by message id so a re-streamed revision of
  // the same message replaces its earlier entry instead of double-counting
  // (chatd re-sends full snapshots on revision bumps and history resets).
  readonly #usageByMessageId = new Map<number, ChatMessageUsage>();
  // The emitted-content ledger: the text/reasoning this translator has emitted
  // for each processed assistant message id. A redial replays the turn from
  // its original cursor and chatd re-sends full snapshots on revision bumps,
  // so already-processed messages arrive again — the ledger is what lets a
  // byte-identical replay reconcile to a no-op while an APPENDING revision (or
  // a commit-during-disconnect snapshot) yields exactly its missing suffix
  // (see #ingestMessage). `substantive` records whether any processed snapshot
  // of the message carried content (text, reasoning, tools, or sources) —
  // false only for announce-style empty snapshots, whose in-flight deltas are
  // still claimable by a same-id commit.
  readonly #emittedByMessageId = new Map<
    number,
    { text: string; reasoning: string; substantive: boolean }
  >();
  // Same-id revision snapshots (their full wire content) that arrived while
  // the NEXT step's deltas were open (latest wins). chatd sends each revision
  // once on a healthy connection, so the suffix cannot wait for a replay — it
  // is reconciled as soon as the next step's snapshot settles ownership of
  // the pending deltas, or flushed by finish() when the segment ends without
  // one (see #78).
  readonly #deferredRevisions = new Map<number, readonly ChatMessagePart[]>();
  #error: ChatErrorPayload | undefined;
  #terminalStatus: ChatStatus | undefined;
  #maxMessageId = 0;

  /**
   * Messages with an id at or below this cursor belong to earlier turns (or
   * to a segment that already streamed) — they arrive only as replays: the
   * initial sync when resuming a chat, or a mid-turn `history_reset` re-send
   * of the full history. Ingest skips them entirely so a replay can neither
   * re-emit earlier turns' content nor inflate this turn's usage. Mutable for
   * exactly one transition: a QUEUED submission starts at the pre-turn cursor
   * and advances to the materialized user message's id when the gate anchors
   * (see {@link QueuedSubmissionGate}) — replayed pre-anchor tail messages
   * then stay filtered on every redial, which reuses the turn's ORIGINAL
   * `after_id` and therefore re-delivers them.
   */
  #turnCursor: number;

  /** The queued-submission attribution gate; undefined once anchored (#114). */
  #queuedGate: QueuedSubmissionGate | undefined;

  constructor(opts: TurnTranslatorOptions) {
    this.#dynamicToolNames = opts.dynamicToolNames;
    this.#turnCursor = opts.turnCursor ?? 0;
    this.#submittedToolCallIds = opts.submittedToolCallIds ?? new Set();
    const queued = opts.queuedSubmission;
    if (queued) {
      this.#queuedGate = {
        queuedId: queued.id,
        expected: queued.content !== undefined ? canonicalJson(queued.content) : undefined,
        candidateId: undefined,
        buffered: [],
        deadEnd: undefined,
      };
    }
  }

  get terminalStatus(): ChatStatus | undefined {
    return this.#terminalStatus;
  }
  /** Whether a client (custom) tool call has been emitted this turn. */
  get clientToolCallSeen(): boolean {
    return this.#clientToolCallSeen;
  }
  get maxMessageId(): number {
    return this.#maxMessageId;
  }
  get error(): ChatErrorPayload | undefined {
    return this.#error;
  }
  /**
   * The turn's EFFECTIVE attribution cursor: the constructor's `turnCursor`
   * until a queued submission anchors, the materialized user message's id
   * after. Distinct from the stream's redial cursor, which deliberately stays
   * the turn's original `after_id` (see `streamChatEvents`).
   */
  get turnCursor(): number {
    return this.#turnCursor;
  }
  /**
   * Whether a queued submission is still awaiting its own user-message
   * snapshot (#114). While true, nothing is attributed to this turn — no
   * content, usage, tool calls, or settle statuses — because the stream
   * window still belongs to the chat's concurrent run.
   */
  get awaitingQueuedSubmission(): boolean {
    return this.#queuedGate !== undefined;
  }
  /**
   * Set when a queued submission's wait can never complete (see
   * {@link QueuedSubmissionGate}); the model layer throws it so the turn
   * fails fast instead of hanging until timeout/abort.
   */
  get queuedSubmissionDeadEnd(): ChatErrorPayload | undefined {
    return this.#queuedGate?.deadEnd;
  }

  // --- block helpers --------------------------------------------------------

  #openText(out: LanguageModelV4StreamPart[]): void {
    if (this.#reasoning.id) this.#closeReasoning(out);
    if (!this.#text.id) {
      this.#text.id = `text-${++this.#seq}`;
      out.push({ type: "text-start", id: this.#text.id });
    }
  }
  #closeText(out: LanguageModelV4StreamPart[]): void {
    if (this.#text.id) {
      out.push({ type: "text-end", id: this.#text.id });
      this.#text.id = undefined;
    }
  }
  #openReasoning(out: LanguageModelV4StreamPart[]): void {
    if (this.#text.id) this.#closeText(out);
    if (!this.#reasoning.id) {
      this.#reasoning.id = `reasoning-${++this.#seq}`;
      out.push({ type: "reasoning-start", id: this.#reasoning.id });
    }
  }
  #closeReasoning(out: LanguageModelV4StreamPart[]): void {
    if (this.#reasoning.id) {
      out.push({ type: "reasoning-end", id: this.#reasoning.id });
      this.#reasoning.id = undefined;
    }
  }

  #emitTextDelta(out: LanguageModelV4StreamPart[], delta: string): void {
    this.#openText(out);
    out.push({ type: "text-delta", id: this.#text.id as string, delta });
  }
  #emitReasoningDelta(out: LanguageModelV4StreamPart[], delta: string): void {
    this.#openReasoning(out);
    out.push({ type: "reasoning-delta", id: this.#reasoning.id as string, delta });
  }

  /**
   * Reconciles a replayed/revised snapshot of an EARLIER (non-current)
   * assistant message against its ledger entry: an APPENDING revision emits
   * its suffix, anything else is a no-op. The suffix is bracketed in its own
   * block(s) — an open block belongs to the CURRENT step, and splicing another
   * message's content into it would corrupt both — and the interrupted step's
   * next delta simply opens a fresh block (its pending content is tracked
   * independently of blocks).
   */
  #reconcileRevision(
    out: LanguageModelV4StreamPart[],
    rec: { text: string; reasoning: string },
    content: readonly ChatMessagePart[],
  ): void {
    const fullText = joinContent(content, "text");
    const fullReasoning = joinContent(content, "reasoning");
    // Per-kind extension gates: a kind's suffix emits only when the revision
    // strictly extends what the ledger already emitted for it.
    const textOk = fullText.length > rec.text.length && fullText.startsWith(rec.text);
    const reasoningOk =
      fullReasoning.length > rec.reasoning.length && fullReasoning.startsWith(rec.reasoning);
    if (!textOk && !reasoningOk) return;
    this.#closeText(out);
    this.#closeReasoning(out);
    // Emit each kind's missing sub-span walking the snapshot in WIRE order —
    // the same walk as first-sight reconciliation (see #ingestMessage) — so a
    // revision appending both kinds surfaces its suffixes the way the model
    // produced them, not reasoning-first (#79).
    let seenText = 0;
    let seenReasoning = 0;
    for (const p of content) {
      if (p.type === "text") {
        const end = seenText + (p.text ?? "").length;
        const from = Math.max(seenText, rec.text.length);
        if (textOk && end > from) this.#emitTextDelta(out, fullText.slice(from, end));
        seenText = end;
      } else if (p.type === "reasoning") {
        const end = seenReasoning + (p.text ?? "").length;
        const from = Math.max(seenReasoning, rec.reasoning.length);
        if (reasoningOk && end > from)
          this.#emitReasoningDelta(out, fullReasoning.slice(from, end));
        seenReasoning = end;
      }
    }
    if (textOk) rec.text = fullText;
    if (reasoningOk) rec.reasoning = fullReasoning;
    this.#closeText(out);
    this.#closeReasoning(out);
  }

  // --- tool helpers ---------------------------------------------------------

  #isClientTool(name: string | undefined): boolean {
    return name !== undefined && this.#dynamicToolNames.has(name);
  }

  #emitServerToolCall(out: LanguageModelV4StreamPart[], part: ChatMessagePart): void {
    const id = part.tool_call_id;
    const name = part.tool_name;
    if (!id || !name) return;
    if (part.args === undefined) return; // wait for complete args (snapshot)
    if (this.#serverToolCalls.has(id)) return;
    this.#serverToolCalls.add(id);
    // `dynamic: true` is load-bearing: server tools are not in the client ToolSet, and
    // the AI SDK only tolerates unknown tool names on `providerExecuted && dynamic`
    // calls. Without it every server tool call is marked `invalid`, which injects a
    // phantom tool-error output and halts the tool loop on that step — stranding the
    // turn whenever a client tool call is pending in the same segment.
    out.push({
      type: "tool-input-start",
      id,
      toolName: name,
      providerExecuted: true,
      dynamic: true,
    });
    out.push({ type: "tool-input-end", id });
    out.push({
      type: "tool-call",
      toolCallId: id,
      toolName: name,
      input: typeof part.args === "string" ? part.args : JSON.stringify(part.args),
      providerExecuted: true,
      dynamic: true,
    });
  }

  #emitServerToolResult(out: LanguageModelV4StreamPart[], part: ChatMessagePart): void {
    const id = part.tool_call_id;
    const name = part.tool_name;
    if (!id || !name) return;
    if (part.result === undefined) return;
    if (this.#serverToolResults.has(id)) return;
    // Only pair with a call emitted in THIS segment. A result whose call streamed in
    // an earlier segment (chatd paused for a client tool in between, and the resume
    // segment starts past the assistant message) would reach the AI SDK call-less,
    // and generateText throws "Tool call <id> not found." Drop the orphan — the
    // server-side transcript still has it.
    if (!this.#serverToolCalls.has(id)) return;
    this.#serverToolResults.add(id);
    out.push({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: jsonResult(part.result),
      isError: part.is_error ?? false,
      // Mirror the call's `dynamic: true` so call and result land in the same
      // bucket (steps[*].dynamicToolCalls / dynamicToolResults, UI streams).
      dynamic: true,
    });
  }

  /**
   * Emits a chatd `source` part as a standalone V4 url source (no text-block
   * bracketing needed). Deduped by the emitted id so a part streamed as a
   * `message_part` isn't re-emitted by its trailing `message` snapshot, while
   * snapshot-only turns still emit theirs.
   */
  #emitSource(out: LanguageModelV4StreamPart[], part: ChatMessagePart): void {
    const url = part.url;
    if (!url) return; // the V4 source part requires both id and url
    const id = part.source_id || url;
    if (this.#sources.has(id)) return;
    this.#sources.add(id);
    out.push({
      type: "source",
      sourceType: "url",
      id,
      url,
      ...(part.title !== undefined ? { title: part.title } : {}),
    });
  }

  // --- ingest ---------------------------------------------------------------

  ingest(ev: ChatStreamEvent): LanguageModelV4StreamPart[] {
    const gate = this.#queuedGate;
    if (gate) return this.#ingestGated(gate, ev);
    const out: LanguageModelV4StreamPart[] = [];
    switch (ev.type) {
      case "message_part":
        this.#ingestMessagePart(out, ev);
        break;
      case "message":
        if (ev.message) this.#ingestMessage(out, ev.message);
        break;
      case "action_required":
        for (const tc of ev.action_required?.tool_calls ?? []) {
          if (this.#clientToolCalls.has(tc.tool_call_id)) continue;
          // A replayed pause snapshot for a call this session already
          // answered (see the constructor doc) — not this segment's work.
          if (this.#submittedToolCallIds.has(tc.tool_call_id)) continue;
          // A pause can follow a deferred revision without a settling
          // assistant snapshot; the revision arrived first, so its suffix
          // must precede the tool call to keep the stream's content order
          // (as the error branch already does). Replayed/answered calls
          // above skip this — a replay must stay a no-op.
          this.#flushDeferredRevisions(out);
          this.#closeText(out);
          this.#closeReasoning(out);
          this.#clientToolCalls.add(tc.tool_call_id);
          this.#clientToolCallSeen = true;
          out.push({ type: "tool-input-start", id: tc.tool_call_id, toolName: tc.tool_name });
          out.push({ type: "tool-input-end", id: tc.tool_call_id });
          out.push({
            type: "tool-call",
            toolCallId: tc.tool_call_id,
            toolName: tc.tool_name,
            input: tc.args,
          });
        }
        break;
      case "error":
        if (ev.error) {
          this.#error = ev.error;
          // doGenerate() throws on the error part and closes the generator
          // before finish() can run (issue #72) — parts yielded after it are
          // never pulled, so the deferred-revision flush must precede it.
          this.#flushDeferredRevisions(out);
          out.push({ type: "error", error: new CoderChatError(ev.error) });
        }
        break;
      case "status":
        if (ev.status) {
          if (TERMINAL_STATUSES.has(ev.status.status)) {
            this.#terminalStatus = ev.status.status;
          } else {
            // A non-terminal transition means the chat is generating again:
            // any previously recorded settle is stale. This matters for a
            // stream that outlives its segment — a redial during the
            // tool-result resume replays the connect-time status snapshot,
            // which can still say `requires_action` from the previous
            // segment's pause; without the clear, the segment loop would
            // treat every later event as post-settle and truncate the
            // resumed generation via its safety valve. Real terminal
            // statuses are unaffected: the segment breaks on them
            // immediately, before any transition could arrive.
            this.#terminalStatus = undefined;
          }
        }
        break;
      default:
        break; // retry / queue_update / preview_reset / history_reset
    }
    return out;
  }

  /**
   * Ingest while the queued-submission gate is up (#114): the stream window
   * still belongs to the chat's concurrent run, so nothing is attributed —
   * this only advances cursor bookkeeping, runs the anchor correlation
   * protocol (see {@link QueuedSubmissionGate}), and detects dead ends.
   * Returns parts only at the anchoring transition, when buffered snapshots
   * of this turn's own already-committed messages are replayed through the
   * normal path.
   */
  #ingestGated(gate: QueuedSubmissionGate, ev: ChatStreamEvent): LanguageModelV4StreamPart[] {
    switch (ev.type) {
      case "message": {
        const message = ev.message;
        if (!message) break;
        // Cursor bookkeeping stays live while gated: these are committed
        // messages the session has observed, and the NEXT turn's boundary
        // must advance past them whether or not this turn ever anchors.
        if (message.id > this.#maxMessageId) this.#maxMessageId = message.id;
        if (message.id <= this.#turnCursor) break; // pre-turn replay
        if (message.role === "user" && this.#matchesQueuedContent(gate, message)) {
          // Without a queue-entry id there is nothing to confirm against
          // (older wire shapes): anchor on the first match directly.
          if (gate.queuedId === undefined) return this.#anchorQueuedTurn(message.id);
          // Candidate — the LATEST match before confirmation wins: on a
          // reconnect replay, an identical-content entry queued AHEAD of
          // ours materialized first, and its user message replays before
          // ours does. Messages buffered for a superseded candidate belonged
          // to that earlier entry's run; drop them with it.
          gate.candidateId = message.id;
          gate.buffered = [];
        } else if (gate.candidateId !== undefined) {
          // Between candidate and confirmation only message snapshots can
          // arrive (chatd flushes commits before the queue update): they are
          // this turn's own already-committed messages when the candidate is
          // right, and the superseded run's when it is not — buffer them and
          // let the confirmation decide.
          gate.buffered.push(message);
        }
        break;
      }
      case "queue_update": {
        if (gate.queuedId === undefined) break;
        // A `queue_update` always carries the FULL queue, but the wire field
        // is `omitempty`: an EMPTY queue arrives with `queued_messages`
        // absent — the very shape the common single-entry promotion produces.
        // Absent therefore means empty, not "no information".
        const queue = ev.queued_messages ?? [];
        if (queue.some((entry) => entry.id === gate.queuedId)) {
          // Our entry is still queued, so any candidate materialized from an
          // EARLIER identical-content entry — not ours. Keep waiting.
          gate.candidateId = undefined;
          gate.buffered = [];
          break;
        }
        if (gate.candidateId !== undefined) {
          const buffered = gate.buffered;
          const out = this.#anchorQueuedTurn(gate.candidateId);
          for (const message of buffered) this.#ingestMessage(out, message);
          return out;
        }
        // Gone from the queue, yet no user message matched: deleted
        // externally, or the materialized form could not be correlated.
        // Either way this turn's window will never open — fail fast.
        gate.deadEnd = {
          message:
            "The queued submission left the chat's queue without materializing as this turn's user message (deleted externally, or its materialized form could not be correlated); this turn never started.",
          kind: "queued_submission_lost",
          retryable: false,
        };
        break;
      }
      case "error": {
        if (!ev.error) break;
        // The chat's CURRENT run failed while our entry sat in the queue.
        // chatd does not auto-promote the queue after an error settle — the
        // entry is stuck until an explicit user action — so waiting on the
        // stream can never complete. Fail fast, attributing the failure to
        // the wait rather than absorbing the other run's error as this
        // turn's own settle. Non-retryable: a resubmission to the errored
        // chat would promote the stuck entry AND queue a duplicate.
        gate.deadEnd = {
          message:
            "The chat's active run failed while this turn's submission was queued behind it; the queued message never materialized, so this turn never started.",
          detail: ev.error.detail ? `${ev.error.message}: ${ev.error.detail}` : ev.error.message,
          kind: "queued_submission_lost",
          retryable: false,
        };
        break;
      }
      default:
        // Deltas, statuses (chatd promotes the queue atomically with the
        // previous run's finish, so no terminal status separates the runs),
        // action_required (the PREVIOUS turn's pending calls — attributing
        // them would make the AI SDK execute another turn's tools), retries:
        // all the concurrent run's, all withheld.
        break;
    }
    return [];
  }

  /** Whether a user-message snapshot's content matches the queued entry's. */
  #matchesQueuedContent(gate: QueuedSubmissionGate, message: ChatMessage): boolean {
    if (gate.expected === undefined) return true;
    return canonicalJson(message.content ?? []) === gate.expected;
  }

  /**
   * Opens the turn's attribution window at `anchorId` — this turn's own user
   * message — and drops the gate. Replays of the pre-anchor tail (redials
   * reuse the turn's ORIGINAL cursor) stay filtered by the advanced cursor.
   */
  #anchorQueuedTurn(anchorId: number): LanguageModelV4StreamPart[] {
    this.#turnCursor = anchorId;
    this.#queuedGate = undefined;
    return [];
  }

  #ingestMessagePart(out: LanguageModelV4StreamPart[], ev: ChatStreamEvent): void {
    const mp = ev.message_part;
    if (!mp || (mp.role !== "assistant" && mp.role !== "tool")) return;
    const part = mp.part;
    switch (part.type) {
      case "text":
        this.#deltasSinceSnapshot = true;
        this.#openText(out);
        if (part.text) {
          out.push({ type: "text-delta", id: this.#text.id as string, delta: part.text });
          this.#text.pending += part.text;
        }
        break;
      case "reasoning":
        this.#deltasSinceSnapshot = true;
        this.#openReasoning(out);
        if (part.text) {
          out.push({ type: "reasoning-delta", id: this.#reasoning.id as string, delta: part.text });
          this.#reasoning.pending += part.text;
        }
        break;
      case "tool-call":
        this.#closeText(out);
        this.#closeReasoning(out);
        if (!this.#isClientTool(part.tool_name)) this.#emitServerToolCall(out, part);
        break;
      case "tool-result":
        if (!this.#isClientTool(part.tool_name)) this.#emitServerToolResult(out, part);
        break;
      case "source":
        this.#emitSource(out, part);
        break;
      default:
        break;
    }
  }

  #ingestMessage(out: LanguageModelV4StreamPart[], message: ChatMessage): void {
    if (message.id > this.#maxMessageId) this.#maxMessageId = message.id;
    // Replay of an earlier turn (or an already-streamed segment): skip it
    // entirely — see #turnCursor. In the normal path the server-side
    // `after_id` filter means such ids never arrive, so this only bites on
    // replays, where processing them would re-emit old content as this
    // turn's output and double-count its usage.
    if (message.id <= this.#turnCursor) return;
    // chatd attaches usage to the assistant messages it commits (one per
    // internal model step); tool messages never carry usage, and under
    // summing, accepting a hypothetical mirrored copy would double-count.
    if (message.usage && message.role === "assistant") {
      this.#usageByMessageId.set(message.id, message.usage);
    }
    const content = message.content ?? [];

    if (message.role === "assistant") {
      const fullText = joinContent(content, "text");
      const fullReasoning = joinContent(content, "reasoning");
      const known = this.#emittedByMessageId.get(message.id);

      if (known && message.id !== this.#currentAssistantId) {
        // A replay or revision bump of an EARLIER message (a redial replays
        // the turn from its original cursor; chatd re-sends full snapshots on
        // revision bumps). Reconcile against the ledger: a byte-identical
        // replay is a no-op, an APPENDING revision yields its suffix, and a
        // rewrite stays suppressed (already-emitted text cannot be retracted
        // in a delta stream — suppression is the safe side). NOT taken for
        // the current message: deltas carry no message id, so while the next
        // step streams, #currentAssistantId still names the last committed
        // one and its pending deltas must join the reconciliation below.
        this.#reconcileRevision(out, known, content);
      } else if (known && this.#deltasSinceSnapshot && known.substantive) {
        // A same-id snapshot racing the NEXT step's open deltas. A message
        // whose earlier snapshot already carried content — text, reasoning,
        // or only tools/sources — never streams more deltas (content changes
        // to committed messages arrive only as revision snapshots), so the
        // pending deltas belong to the next, still-uncommitted message —
        // they must NOT be claimed here, even when the revised content
        // happens to share their prefix. Emit nothing and claim nothing yet:
        // the snapshot is DEFERRED and reconciled once the next step's
        // snapshot settles ownership of the pending deltas (see below).
        // Announce-style commits (the earlier snapshot was EMPTY) stay on
        // the attribution path below — their deltas ARE this message's
        // content.
        this.#deferredRevisions.set(message.id, content);
      } else {
        // First sight of this message, or a re-snapshot of the CURRENT one —
        // progressive snapshot-mode growth, or an announce-style commit
        // filling in content that (partially) streamed as deltas.
        //
        // New assistant message boundary: close the previous message's
        // blocks. Skipped when deltas arrived since the previous assistant
        // snapshot: deltas carry no message id, so they belong to the message
        // THIS snapshot finalizes, and their block is this message's block.
        if (
          this.#currentAssistantId !== undefined &&
          this.#currentAssistantId !== message.id &&
          !this.#deltasSinceSnapshot
        ) {
          this.#closeText(out);
          this.#closeReasoning(out);
        }
        this.#currentAssistantId = message.id;

        // What this snapshot's content must extend: everything already
        // attributed to this message id, plus the pending deltas it is about
        // to claim. The suffix beyond that is exactly the content this client
        // never received — nothing for a byte-identical trailing snapshot,
        // everything for a snapshot-only message, and the missing tail when
        // the message committed while a dropped stream was redialing (even if
        // the block already closed: the ledger, unlike a block cursor,
        // survives closes). A snapshot that does NOT extend it — a replay
        // racing the next step's open deltas, or a rewrite — attributes
        // nothing and emits nothing: the pending deltas may belong to the
        // next, still-uncommitted message, and a later snapshot naming them
        // settles the attribution instead.
        const rec = known ?? { text: "", reasoning: "", substantive: false };
        // Per-kind gates: a kind reconciles only when the snapshot's full
        // content extends what was already attributed + pending for it.
        const textAttributed = rec.text + this.#text.pending;
        const reasoningAttributed = rec.reasoning + this.#reasoning.pending;
        const textOk = fullText.startsWith(textAttributed);
        const reasoningOk = fullReasoning.startsWith(reasoningAttributed);
        // Emit each part's missing sub-span walking the snapshot in WIRE
        // order, so recovered blocks interleave the way the model produced
        // them (text→reasoning→text stays that way even when the drop left
        // the text block open) — opening a kind closes the other, and the
        // ledger, unlike a block cursor, loses nothing to the close.
        let seenText = 0;
        let seenReasoning = 0;
        for (const p of content) {
          if (p.type === "text") {
            const end = seenText + (p.text ?? "").length;
            const from = Math.max(seenText, textAttributed.length);
            if (textOk && end > from) this.#emitTextDelta(out, fullText.slice(from, end));
            seenText = end;
          } else if (p.type === "reasoning") {
            const end = seenReasoning + (p.text ?? "").length;
            const from = Math.max(seenReasoning, reasoningAttributed.length);
            if (reasoningOk && end > from)
              this.#emitReasoningDelta(out, fullReasoning.slice(from, end));
            seenReasoning = end;
          }
        }
        if (textOk) rec.text = fullText;
        if (reasoningOk) rec.reasoning = fullReasoning;
        // Reaching this path means THIS snapshot owns the pending deltas (the
        // race guard above intercepts the one ambiguous ordering), so they
        // are settled even when reconciliation failed: a rewrite-on-commit
        // stays suppressed, but its stale pending must not poison every later
        // message's reconciliation.
        this.#text.pending = "";
        this.#reasoning.pending = "";
        rec.substantive ||= content.some((p) =>
          p.type === "text" || p.type === "reasoning" ? (p.text ?? "").length > 0 : true,
        );
        this.#emittedByMessageId.set(message.id, rec);
        this.#deltasSinceSnapshot = false;
        // Delta ownership is settled: reconcile revisions that were deferred
        // while the race was open. They are now revisions of an EARLIER
        // message and get the same bracketed suffix-or-suppress treatment.
        for (const [id, deferred] of this.#deferredRevisions) {
          if (id === message.id) continue;
          const deferredRec = this.#emittedByMessageId.get(id);
          if (deferredRec) this.#reconcileRevision(out, deferredRec, deferred);
          this.#deferredRevisions.delete(id);
        }
      }
      // Tool calls/results and sources are id-deduped, so snapshots process them
      // unconditionally (even when the snapshot is a text/reasoning no-op).
      for (const part of content) {
        if (part.type === "tool-call" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolCall(out, part);
        else if (part.type === "tool-result" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolResult(out, part);
        else if (part.type === "source") this.#emitSource(out, part);
      }
    } else if (message.role === "tool") {
      for (const part of content) {
        if (part.type === "tool-result" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolResult(out, part);
        else if (part.type === "source") this.#emitSource(out, part);
      }
    }
  }

  // --- finish ---------------------------------------------------------------

  /**
   * Flushes revisions still deferred behind a delta-ownership race that never
   * settled — the racing step ended terminally without committing a snapshot,
   * so the drain in #ingestMessage never ran. chatd sent each revision once;
   * this is the segment's last chance to emit its suffix (#78). Attribution
   * care: the pending deltas' owner never committed, so they attribute to no
   * one — reconciliation is against the ledger alone, and only
   * ledger-extension suffixes may emit. Runs at finish() and, because
   * doGenerate() throws on a streamed error part and closes the generator
   * before finish() (issue #72), ahead of the error part in ingest().
   */
  #flushDeferredRevisions(out: LanguageModelV4StreamPart[]): void {
    for (const [id, deferred] of this.#deferredRevisions) {
      const rec = this.#emittedByMessageId.get(id);
      if (rec) this.#reconcileRevision(out, rec, deferred);
    }
    this.#deferredRevisions.clear();
  }

  finish(): LanguageModelV4StreamPart[] {
    const out: LanguageModelV4StreamPart[] = [];
    this.#flushDeferredRevisions(out);
    this.#closeText(out);
    this.#closeReasoning(out);

    let unified: LanguageModelV4FinishReason["unified"];
    if (this.#error || this.#terminalStatus === "error") unified = "error";
    else if (this.#clientToolCallSeen || this.#terminalStatus === "requires_action")
      unified = "tool-calls";
    else unified = "stop";

    const usage = accumulateUsage(this.#usageByMessageId);

    // Surface server-side cost/runtime (sent by newer servers as extra usage
    // fields), summed over the segment's steps, under `providerMetadata.coder`.
    // Omitted entirely when the server sent neither, so old servers look
    // unchanged. NOTE: the AI SDK propagates only the FINAL segment's
    // providerMetadata to `result.providerMetadata` — whole-turn cost for a
    // client-tool turn is the sum over `result.steps[*].providerMetadata`.
    const coder: JSONObject = {};
    if (usage?.total_cost_micros !== undefined) coder.total_cost_micros = usage.total_cost_micros;
    if (usage?.total_runtime_ms !== undefined) coder.total_runtime_ms = usage.total_runtime_ms;

    out.push({
      type: "finish",
      usage: mapUsage(usage),
      finishReason: { unified, raw: this.#terminalStatus },
      ...(Object.keys(coder).length > 0 ? { providerMetadata: { coder } } : {}),
    });
    return out;
  }
}
