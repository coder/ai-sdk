import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
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

function mapUsage(u: ChatMessageUsage | undefined): LanguageModelV3Usage {
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
  };
}

function jsonResult(value: unknown): NonNullable<unknown> {
  // chatd tool results are arbitrary JSON; the V3 tool-result `result` must be
  // a non-null JSON value.
  return (value ?? {}) as NonNullable<unknown>;
}

/**
 * Translates one chatd turn's {@link ChatStreamEvent} stream into a sequence of
 * `LanguageModelV3StreamPart`s for the AI SDK.
 *
 * Two text/reasoning modes, decided per turn from the wire behavior:
 *  - **delta mode** — chatd streamed `message_part` deltas; we emit those and
 *    treat the trailing full `message` snapshot as a no-op for text/reasoning.
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

  #serverToolCalls = new Set<string>();
  #serverToolResults = new Set<string>();
  #clientToolCalls = new Set<string>();
  #clientToolCallSeen = false;

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

  #openText(out: LanguageModelV3StreamPart[]): void {
    if (this.#reasoning.id) this.#closeReasoning(out);
    if (!this.#text.id) {
      this.#text.id = `text-${++this.#seq}`;
      this.#text.len = 0;
      out.push({ type: "text-start", id: this.#text.id });
    }
  }
  #closeText(out: LanguageModelV3StreamPart[]): void {
    if (this.#text.id) {
      out.push({ type: "text-end", id: this.#text.id });
      this.#text.id = undefined;
      this.#text.len = 0;
    }
  }
  #openReasoning(out: LanguageModelV3StreamPart[]): void {
    if (this.#text.id) this.#closeText(out);
    if (!this.#reasoning.id) {
      this.#reasoning.id = `reasoning-${++this.#seq}`;
      this.#reasoning.len = 0;
      out.push({ type: "reasoning-start", id: this.#reasoning.id });
    }
  }
  #closeReasoning(out: LanguageModelV3StreamPart[]): void {
    if (this.#reasoning.id) {
      out.push({ type: "reasoning-end", id: this.#reasoning.id });
      this.#reasoning.id = undefined;
      this.#reasoning.len = 0;
    }
  }

  #emitTextUpTo(out: LanguageModelV3StreamPart[], full: string): void {
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
  #emitReasoningUpTo(out: LanguageModelV3StreamPart[], full: string): void {
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

  #emitServerToolCall(out: LanguageModelV3StreamPart[], part: ChatMessagePart): void {
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

  #emitServerToolResult(out: LanguageModelV3StreamPart[], part: ChatMessagePart): void {
    const id = part.tool_call_id;
    const name = part.tool_name;
    if (!id || !name) return;
    if (part.result === undefined) return;
    if (this.#serverToolResults.has(id)) return;
    this.#serverToolResults.add(id);
    out.push({
      type: "tool-result",
      toolCallId: id,
      toolName: name,
      result: jsonResult(part.result),
      isError: part.is_error ?? false,
    });
  }

  // --- ingest ---------------------------------------------------------------

  ingest(ev: ChatStreamEvent): LanguageModelV3StreamPart[] {
    const out: LanguageModelV3StreamPart[] = [];
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

  #ingestMessagePart(out: LanguageModelV3StreamPart[], ev: ChatStreamEvent): void {
    const mp = ev.message_part;
    if (!mp || (mp.role !== "assistant" && mp.role !== "tool")) return;
    const part = mp.part;
    switch (part.type) {
      case "text":
        this.#text.sawDelta = true;
        this.#openText(out);
        if (part.text) {
          out.push({ type: "text-delta", id: this.#text.id as string, delta: part.text });
          this.#text.len += part.text.length;
        }
        break;
      case "reasoning":
        this.#reasoning.sawDelta = true;
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
      default:
        break;
    }
  }

  #ingestMessage(out: LanguageModelV3StreamPart[], message: ChatMessage): void {
    if (message.id > this.#maxMessageId) this.#maxMessageId = message.id;
    if (message.usage && (message.role === "assistant" || message.role === "tool")) {
      this.#usage = message.usage;
    }
    const content = message.content ?? [];

    if (message.role === "assistant") {
      // New assistant message boundary: close prior blocks and reset cursors.
      if (this.#currentAssistantId !== undefined && this.#currentAssistantId !== message.id) {
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
      for (const part of content) {
        if (part.type === "tool-call" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolCall(out, part);
        else if (part.type === "tool-result" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolResult(out, part);
      }
    } else if (message.role === "tool") {
      for (const part of content) {
        if (part.type === "tool-result" && !this.#isClientTool(part.tool_name))
          this.#emitServerToolResult(out, part);
      }
    }
  }

  // --- finish ---------------------------------------------------------------

  finish(): LanguageModelV3StreamPart[] {
    const out: LanguageModelV3StreamPart[] = [];
    this.#closeText(out);
    this.#closeReasoning(out);

    let unified: LanguageModelV3FinishReason["unified"];
    if (this.#error || this.#terminalStatus === "error") unified = "error";
    else if (this.#clientToolCallSeen || this.#terminalStatus === "requires_action")
      unified = "tool-calls";
    else unified = "stop";

    out.push({
      type: "finish",
      usage: mapUsage(this.#usage),
      finishReason: { unified, raw: this.#terminalStatus },
    });
    return out;
  }
}
