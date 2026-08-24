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

/**
 * Translates one chatd turn's {@link ChatStreamEvent} stream into a sequence of
 * `LanguageModelV4StreamPart`s for the AI SDK.
 *
 * Two text/reasoning modes, decided per assistant message from the wire
 * behavior:
 *  - **delta mode** — chatd streamed `message_part` deltas; we emit those and
 *    treat the message's trailing full `message` snapshot as a no-op for
 *    text/reasoning. Deltas carry no message id, so "deltas arrived since the
 *    last assistant snapshot" is what marks a snapshot as trailing.
 *  - **snapshot mode** — fast turns where only full `message` snapshots arrive;
 *    we diff each snapshot's full text against what we've already emitted.
 * Both paths track an emitted-length cursor, so neither double-counts.
 *
 * Client (custom) tool calls are emitted from the reliable `action_required`
 * event and left for the AI SDK to execute. chatd's own server-side tools are
 * surfaced best-effort as `providerExecuted` tool calls/results.
 */
export class TurnTranslator {
  readonly #dynamicToolNames: ReadonlySet<string>;

  #seq = 0;
  #text = { id: undefined as string | undefined, len: 0, sawDelta: false };
  #reasoning = { id: undefined as string | undefined, len: 0, sawDelta: false };
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
  #error: ChatErrorPayload | undefined;
  #terminalStatus: ChatStatus | undefined;
  #maxMessageId = 0;

  /**
   * Messages with an id at or below this cursor belong to earlier turns (or
   * to a segment that already streamed) — they arrive only as replays: the
   * initial sync when resuming a chat, or a mid-turn `history_reset` re-send
   * of the full history. Ingest skips them entirely so a replay can neither
   * re-emit earlier turns' content nor inflate this turn's usage.
   */
  readonly #turnCursor: number;

  constructor(opts: { dynamicToolNames: ReadonlySet<string>; turnCursor?: number }) {
    this.#dynamicToolNames = opts.dynamicToolNames;
    this.#turnCursor = opts.turnCursor ?? 0;
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

  // --- block helpers --------------------------------------------------------

  #openText(out: LanguageModelV4StreamPart[]): void {
    if (this.#reasoning.id) this.#closeReasoning(out);
    if (!this.#text.id) {
      this.#text.id = `text-${++this.#seq}`;
      this.#text.len = 0;
      out.push({ type: "text-start", id: this.#text.id });
    }
  }
  #closeText(out: LanguageModelV4StreamPart[]): void {
    if (this.#text.id) {
      out.push({ type: "text-end", id: this.#text.id });
      this.#text.id = undefined;
      this.#text.len = 0;
    }
  }
  #openReasoning(out: LanguageModelV4StreamPart[]): void {
    if (this.#text.id) this.#closeText(out);
    if (!this.#reasoning.id) {
      this.#reasoning.id = `reasoning-${++this.#seq}`;
      this.#reasoning.len = 0;
      out.push({ type: "reasoning-start", id: this.#reasoning.id });
    }
  }
  #closeReasoning(out: LanguageModelV4StreamPart[]): void {
    if (this.#reasoning.id) {
      out.push({ type: "reasoning-end", id: this.#reasoning.id });
      this.#reasoning.id = undefined;
      this.#reasoning.len = 0;
    }
  }

  #emitTextUpTo(out: LanguageModelV4StreamPart[], full: string): void {
    if (full.length <= this.#text.len && this.#text.id) return;
    this.#openText(out);
    if (full.length > this.#text.len) {
      out.push({
        type: "text-delta",
        id: this.#text.id as string,
        delta: full.slice(this.#text.len),
      });
      this.#text.len = full.length;
    }
  }
  #emitReasoningUpTo(out: LanguageModelV4StreamPart[], full: string): void {
    if (full.length <= this.#reasoning.len && this.#reasoning.id) return;
    this.#openReasoning(out);
    if (full.length > this.#reasoning.len) {
      out.push({
        type: "reasoning-delta",
        id: this.#reasoning.id as string,
        delta: full.slice(this.#reasoning.len),
      });
      this.#reasoning.len = full.length;
    }
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
          out.push({ type: "error", error: new CoderChatError(ev.error) });
        }
        break;
      case "status":
        if (ev.status && TERMINAL_STATUSES.has(ev.status.status)) {
          this.#terminalStatus = ev.status.status;
        }
        break;
      default:
        break; // retry / queue_update / preview_reset / history_reset
    }
    return out;
  }

  #ingestMessagePart(out: LanguageModelV4StreamPart[], ev: ChatStreamEvent): void {
    const mp = ev.message_part;
    if (!mp || (mp.role !== "assistant" && mp.role !== "tool")) return;
    const part = mp.part;
    switch (part.type) {
      case "text":
        this.#text.sawDelta = true;
        this.#deltasSinceSnapshot = true;
        this.#openText(out);
        if (part.text) {
          out.push({ type: "text-delta", id: this.#text.id as string, delta: part.text });
          this.#text.len += part.text.length;
        }
        break;
      case "reasoning":
        this.#reasoning.sawDelta = true;
        this.#deltasSinceSnapshot = true;
        this.#openReasoning(out);
        if (part.text) {
          out.push({ type: "reasoning-delta", id: this.#reasoning.id as string, delta: part.text });
          this.#reasoning.len += part.text.length;
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
      // New assistant message boundary: close prior blocks and reset cursors.
      // Skipped when deltas arrived since the previous assistant snapshot:
      // deltas carry no message id, so they belong to the message THIS snapshot
      // finalizes (its id differing from the previous snapshot's), and the
      // snapshot must stay a no-op for text/reasoning. The reset is load-bearing
      // for snapshot-only messages, which must still diff-and-emit below. Known
      // tradeoff: a mid-message snapshot followed by more deltas of the SAME
      // message would misclassify the next snapshot — that ordering is outside
      // the trailing-snapshot protocol (see class doc).
      if (
        this.#currentAssistantId !== undefined &&
        this.#currentAssistantId !== message.id &&
        !this.#deltasSinceSnapshot
      ) {
        this.#closeText(out);
        this.#closeReasoning(out);
        this.#text.sawDelta = false;
        this.#reasoning.sawDelta = false;
      }
      this.#currentAssistantId = message.id;

      // Snapshot mode diffs the full text against the emitted length. Delta
      // mode normally treats the trailing snapshot as a no-op — but only while
      // the block is still OPEN can the emitted length vouch for that: a
      // snapshot carrying MORE text than was emitted means deltas this client
      // never received (the message committed while a dropped stream was
      // redialing), so emit the missing suffix instead of losing it. Once the
      // block is closed the length cursor is gone, and the snapshot must be
      // skipped as before. The currently open block reconciles FIRST: opening
      // the other kind closes it (resetting its length cursor), which would
      // silently drop its gap suffix.
      const emitSnapshotText = (): void => {
        if (!this.#text.sawDelta || this.#text.id) {
          const full = content
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
          if (full.length > 0) this.#emitTextUpTo(out, full);
        }
      };
      const emitSnapshotReasoning = (): void => {
        if (!this.#reasoning.sawDelta || this.#reasoning.id) {
          const full = content
            .filter((p) => p.type === "reasoning")
            .map((p) => p.text ?? "")
            .join("");
          if (full.length > 0) this.#emitReasoningUpTo(out, full);
        }
      };
      if (this.#reasoning.id) {
        emitSnapshotReasoning();
        emitSnapshotText();
      } else {
        emitSnapshotText();
        emitSnapshotReasoning();
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
      this.#deltasSinceSnapshot = false;
    } else if (message.role === "tool") {
      for (const part of content) {
        if (part.type === "tool-result" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolResult(out, part);
        else if (part.type === "source") this.#emitSource(out, part);
      }
    }
  }

  // --- finish ---------------------------------------------------------------

  finish(): LanguageModelV4StreamPart[] {
    const out: LanguageModelV4StreamPart[] = [];
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
