/**
 * A small model of what chatd sends on `GET /api/v2/chats/{chat}/stream`
 * during one turn, for the exactly-once check in `stream-exactly-once.check.ts`.
 *
 * Everything on the client side of the check is the real code. This file is
 * the one hand-written part: the server. It follows coder/coder at commit
 * 3697bb38ce6fa29bf73a82f3494cca3ecf708de6:
 *
 * - `coderd/x/chatd/ARCHITECTURE.md`, sections "Stream loop", "Sync
 *   operation", "Message part buffer", and "Generation goroutine".
 * - `coderd/x/chatd/stream_loop.go`, `applyDBSnapshot` (the order of events in
 *   one sync) and `part` (which preview parts a connection forwards).
 *
 * The model keeps only what the client can observe: committed messages with
 * their latest revision, the chat status, the history version, the
 * generation attempt, and the preview parts of the current attempt.
 */
import type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageUsage,
  ChatStreamEvent,
} from "../../src/coder/types.js";

export const CHAT_ID = "chat-1";

/** One streamed part of an assistant step: one delta, and one content part of its snapshot. */
export interface StepPart {
  kind: "text" | "reasoning";
  text: string;
}

/** One assistant model step: chatd streams its parts, then commits them as one message. */
export interface StepSpec {
  parts: StepPart[];
  /** The message's usage unit: see {@link usageFor}. */
  usage: number;
}

/**
 * The wire usage that a message with usage unit `k` reports. Every counter is
 * a different multiple of `k`, so double counting any one of them shows.
 */
export function usageFor(k: number): ChatMessageUsage {
  return {
    input_tokens: 2 * k,
    output_tokens: k,
    reasoning_tokens: 3 * k,
    cache_read_tokens: 5 * k,
    cache_creation_tokens: 7 * k,
    total_cost_micros: 11 * k,
    total_runtime_ms: 13 * k,
  };
}

/**
 * One server-side transition, in the order chatd applies them.
 *
 * - `part`: the current generation attempt streams the step's next part
 *   (`AddPart`). The first part of an attempt also starts the attempt
 *   (`RecordGenerationAttempt`), which advances `generation_attempt`.
 * - `commit`: the step commits its assistant message (`CommitStep` or
 *   `FinishTurn`). That advances `history_version` and resets the attempt.
 * - `retry`: the attempt fails with a retryable error (`RecordRetryState`).
 *   chatd retires the attempt and the next `part` restarts the step.
 * - `revise`: a committed assistant message gets a new revision. That
 *   advances `history_version`, so the runner cancels an attempt in progress
 *   and the next `part` restarts the step.
 * - `settle`: the turn ends (`FinishTurn`): status `waiting`.
 */
export type WorldEvent =
  | { kind: "part" }
  | { kind: "commit" }
  | { kind: "retry" }
  | { kind: "revise"; step: number; appendText: string; usage: number }
  | { kind: "settle" };

/** How the turn was submitted, which decides the stream's `after_id`. */
export type TurnStart =
  /** `createChat`: the stream dials without `after_id`, the prompt is message 1. */
  | "new-chat"
  /** `createChatMessage` on a chat with history 1-2: the prompt is message 3, `after_id=3`. */
  | "follow-up";

export interface CommittedMessage {
  id: number;
  role: "user" | "assistant";
  content: ChatMessagePart[];
  /** The usage unit of an assistant message: see {@link usageFor}. */
  usage?: number;
  /** Text that later revisions appended to this message, in order. */
  appendedText: string;
}

/** One WebSocket frame that the server has emitted on one connection: a JSON array of events. */
export interface Frame {
  events: ChatStreamEvent[];
  /** A preview part. chatd drops a preview part that it has not sent yet when the attempt ends. */
  preview: boolean;
}

export class ChatdWorld {
  readonly #steps: readonly StepSpec[];
  readonly #messages: CommittedMessage[] = [];
  #historyVersion = 1;
  #generationAttempt = 0;
  #attemptParts = 0;
  #attemptRetired = false;
  #retryPending = false;
  #step = 0;
  #status: "running" | "waiting" = "running";
  #nextId: number;
  /** The id of this turn's own user message (the prompt). */
  readonly promptId: number;

  constructor(start: TurnStart, steps: readonly StepSpec[]) {
    if (steps.length === 0) throw new Error("ChatdWorld: a turn needs at least one step");
    this.#steps = steps;
    if (start === "follow-up") {
      this.#messages.push({
        id: 1,
        role: "user",
        content: [{ type: "text", text: "earlier" }],
        appendedText: "",
      });
      this.#messages.push({
        id: 2,
        role: "assistant",
        content: [{ type: "text", text: "EARLIER" }],
        usage: 1000,
        appendedText: "",
      });
    }
    this.promptId = this.#messages.length + 1;
    this.#messages.push({
      id: this.promptId,
      role: "user",
      content: [{ type: "text", text: "hi" }],
      appendedText: "",
    });
    this.#nextId = this.promptId + 1;
    // The prompt insert advanced history_version once more.
    this.#historyVersion += 1;
  }

  get settled(): boolean {
    return this.#status === "waiting";
  }

  /** Whether `ev` ends the current attempt, so chatd stops forwarding its unsent preview parts. */
  endsAttempt(ev: WorldEvent): boolean {
    return ev.kind === "commit" || ev.kind === "retry" || ev.kind === "revise";
  }

  /** The assistant messages of this turn, as committed now (latest revision). */
  turnMessages(): CommittedMessage[] {
    return this.#messages.filter((m) => m.id > this.promptId);
  }

  /**
   * Applies one transition and returns the events that a connected stream
   * emits for it, in `applyDBSnapshot` order (messages, status, retry,
   * preview_reset), followed by a forwarded preview part.
   */
  apply(ev: WorldEvent): Frame[] {
    if (this.settled) throw new Error(`ChatdWorld: ${ev.kind} after the turn settled`);
    const out: Frame[] = [];
    switch (ev.kind) {
      case "part": {
        const step = this.#currentStep();
        if (this.#attemptParts === 0) {
          // RecordGenerationAttempt: a new attempt (a new episode). The
          // stream sees a changed, non-zero generation_attempt and resets
          // its preview. The trigger clears any pending retry state.
          this.#generationAttempt += 1;
          this.#attemptRetired = false;
          this.#retryPending = false;
          out.push(control({ type: "preview_reset", chat_id: CHAT_ID }));
        }
        const part = step.parts[this.#attemptParts];
        if (!part)
          throw new Error(`ChatdWorld: step ${this.#step} has no part ${this.#attemptParts}`);
        this.#attemptParts += 1;
        out.push(this.#previewFrame(this.#attemptParts, part));
        break;
      }
      case "commit": {
        const step = this.#currentStep();
        if (this.#attemptParts !== step.parts.length) {
          throw new Error(
            `ChatdWorld: commit of step ${this.#step} after ${this.#attemptParts}/${step.parts.length} parts`,
          );
        }
        const message: CommittedMessage = {
          id: this.#nextId,
          role: "assistant",
          content: step.parts.map((p) => ({ type: p.kind, text: p.text })),
          usage: step.usage,
          appendedText: "",
        };
        this.#nextId += 1;
        this.#messages.push(message);
        this.#step += 1;
        this.#historyChanged();
        out.push(control(messageEvent(message)));
        out.push(control({ type: "preview_reset", chat_id: CHAT_ID }));
        break;
      }
      case "retry": {
        if (this.#attemptParts === 0) throw new Error("ChatdWorld: retry without an attempt");
        // RecordRetryState: the attempt failed. Its later parts are never
        // forwarded, and the next attempt streams the step from its start.
        this.#attemptRetired = true;
        this.#retryPending = true;
        this.#attemptParts = 0;
        out.push(control(retryEvent()));
        break;
      }
      case "revise": {
        const target = this.turnMessages()[ev.step];
        if (!target) throw new Error(`ChatdWorld: no committed step ${ev.step} to revise`);
        target.content = [...target.content, { type: "text", text: ev.appendText }];
        target.appendedText += ev.appendText;
        target.usage = ev.usage;
        // A history change cancels an attempt in progress (ARCHITECTURE.md,
        // "Event processing", case 2); the step restarts from its start.
        this.#historyChanged();
        out.push(control(messageEvent(target)));
        out.push(control({ type: "preview_reset", chat_id: CHAT_ID }));
        break;
      }
      case "settle": {
        if (this.#step !== this.#steps.length) {
          throw new Error(`ChatdWorld: settle after ${this.#step}/${this.#steps.length} steps`);
        }
        this.#status = "waiting";
        out.push(control(statusEvent("waiting")));
        break;
      }
    }
    return out;
  }

  /**
   * The events a new connection gets: the initial sync from the null local
   * state (`applyDBSnapshot`: messages past `after_id`, status, retry,
   * preview_reset) as ONE frame, then the relay's replay of the current
   * attempt's parts from seq 1, one frame each.
   */
  connect(afterId: number | undefined): Frame[] {
    const initial: ChatStreamEvent[] = [];
    for (const m of this.#messages) {
      if (afterId === undefined || m.id > afterId) initial.push(messageEvent(m));
    }
    initial.push(statusEvent(this.#status));
    if (this.#retryPending && this.#status === "running") initial.push(retryEvent());
    initial.push({ type: "preview_reset", chat_id: CHAT_ID });
    const frames: Frame[] = [{ events: initial, preview: false }];
    if (this.#generationAttempt > 0 && !this.#attemptRetired) {
      const step = this.#currentStep();
      for (let seq = 1; seq <= this.#attemptParts; seq++) {
        const part = step.parts[seq - 1];
        if (!part) throw new Error(`ChatdWorld: replay past step ${this.#step} parts`);
        frames.push(this.#previewFrame(seq, part));
      }
    }
    return frames;
  }

  #currentStep(): StepSpec {
    const step = this.#steps[this.#step];
    if (!step) throw new Error(`ChatdWorld: no step ${this.#step} left to stream`);
    return step;
  }

  #historyChanged(): void {
    this.#historyVersion += 1;
    this.#generationAttempt = 0;
    this.#attemptParts = 0;
    this.#attemptRetired = false;
    this.#retryPending = false;
  }

  #previewFrame(seq: number, part: StepPart): Frame {
    const event: ChatStreamEvent = {
      type: "message_part",
      chat_id: CHAT_ID,
      message_part: {
        role: "assistant",
        part: { type: part.kind, text: part.text },
        history_version: this.#historyVersion,
        generation_attempt: this.#generationAttempt,
        seq,
      },
    };
    return { events: [event], preview: true };
  }
}

/** The JSON text of one WebSocket frame. */
export function frameData(frame: Frame): string {
  return JSON.stringify(frame.events);
}

function control(event: ChatStreamEvent): Frame {
  return { events: [event], preview: false };
}

function messageEvent(m: CommittedMessage): ChatStreamEvent {
  const message: ChatMessage = {
    id: m.id,
    chat_id: CHAT_ID,
    role: m.role,
    created_at: "",
    content: m.content.map((p) => ({ ...p })),
  };
  if (m.usage !== undefined) message.usage = usageFor(m.usage);
  return { type: "message", chat_id: CHAT_ID, message };
}

function statusEvent(status: "running" | "waiting"): ChatStreamEvent {
  return { type: "status", chat_id: CHAT_ID, status: { status } };
}

function retryEvent(): ChatStreamEvent {
  return {
    type: "retry",
    chat_id: CHAT_ID,
    retry: { attempt: 1, delay_ms: 1000, error: "overloaded", retrying_at: "" },
  };
}
