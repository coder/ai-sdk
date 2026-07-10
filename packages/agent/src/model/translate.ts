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

function mapUsage(u: ChatMessageUsage | undefined): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: u?.input_tokens,
      noCache: undefined,
      cacheRead: u?.cache_read_tokens,
      cacheWrite: u?.cache_creation_tokens,
    },
    outputTokens: {
      total: u?.output_tokens,
      text: undefined,
      reasoning: u?.reasoning_tokens,
    },
    // Preserve the verbatim wire usage (snake_case) so callers can reach fields
    // the normalized shape has no slot for (context_limit, cost, runtime, …).
    ...(u ? { raw: u as unknown as JSONObject } : {}),
  };
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

  #usage: ChatMessageUsage | undefined;
  #error: ChatErrorPayload | undefined;
  #terminalStatus: ChatStatus | undefined;
  #maxMessageId = 0;

  constructor(opts: { dynamicToolNames: ReadonlySet<string> }) {
    this.#dynamicToolNames = opts.dynamicToolNames;
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
    if (message.usage && (message.role === "assistant" || message.role === "tool")) {
      this.#usage = message.usage;
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

      if (!this.#text.sawDelta) {
        const full = content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
        if (full.length > 0) this.#emitTextUpTo(out, full);
      }
      if (!this.#reasoning.sawDelta) {
        const full = content
          .filter((p) => p.type === "reasoning")
          .map((p) => p.text ?? "")
          .join("");
        if (full.length > 0) this.#emitReasoningUpTo(out, full);
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

    // Surface server-side cost/runtime (sent by newer servers as extra usage
    // fields) verbatim under `providerMetadata.coder`. Omitted entirely when
    // the server sent neither, so old servers look unchanged to callers.
    const coder: JSONObject = {};
    if (this.#usage?.total_cost_micros !== undefined)
      coder.total_cost_micros = this.#usage.total_cost_micros;
    if (this.#usage?.total_runtime_ms !== undefined)
      coder.total_runtime_ms = this.#usage.total_runtime_ms;

    out.push({
      type: "finish",
      usage: mapUsage(this.#usage),
      finishReason: { unified, raw: this.#terminalStatus },
      ...(Object.keys(coder).length > 0 ? { providerMetadata: { coder } } : {}),
    });
    return out;
  }
}
