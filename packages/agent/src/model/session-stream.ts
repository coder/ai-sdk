import { CoderAgentError } from "../errors.js";
import type { ChatStreamEvent } from "../coder/types.js";

/**
 * A chat event stream retained across turn segments (issue #44).
 *
 * One `doGenerate`/`doStream` call is one *segment* of a chatd turn; a turn
 * that drives client tools spans several segments (each `requires_action`
 * pause hands control back to the AI SDK, which executes the tools and calls
 * the model again with the results). Before this wrapper existed each segment
 * dialed its own WebSocket and closed it on settle — one TLS + upgrade
 * handshake per tool round trip, plus a between-connections window where
 * events had to be recovered via `after_id` catch-up on the next dial.
 *
 * This class owns the turn-lifetime stream instead:
 *
 * - It wraps the self-redialing reader (`streamChatEvents` via
 *   `CoderChatClient.streamEvents`), dialed lazily with the STREAM's own
 *   lifetime signal — never a segment's abort signal, so a segment
 *   abort/timeout cannot tear the socket down.
 * - Reads are memoized: at most one `next()` is outstanding on the underlying
 *   generator, and a read that a detached segment abandoned (it lost a race
 *   against its abort signal, a grace timer, or the REST recovery fetch) is
 *   adopted by the next segment via {@link read} — the event it eventually
 *   resolves with is delivered, never dropped.
 * - Lifecycle is a small state machine: `attached` (a segment is consuming) →
 *   {@link pause} on a healthy `requires_action` settle (reusable by the
 *   resume segment) → {@link attach} or {@link close}. Every other segment
 *   exit closes the stream — an aborted/timed-out segment's stream could
 *   never be reused (its partially consumed in-progress episode cannot be
 *   safely re-read), so it is not kept. Closing is idempotent; the socket
 *   also ends on session teardown (`resetSession()` /
 *   `[Symbol.asyncDispose]()`) or replacement by the next turn's fresh
 *   stream.
 *
 * The redial machinery inside the wrapped reader keeps working while paused:
 * {@link pause} leaves a read outstanding, so a socket drop during tool
 * execution is redialed (from the turn's original cursor) in the background
 * instead of adding reconnect latency to the resume segment.
 */
export class SessionChatStream {
  readonly chatId: string;
  readonly #events: AsyncGenerator<ChatStreamEvent, void, void>;
  readonly #controller = new AbortController();

  #pending: Promise<IteratorResult<ChatStreamEvent, void>> | undefined;
  #attached = true;
  #reusable = false;
  #closePromise: Promise<void> | undefined;

  constructor(opts: {
    chatId: string;
    /** Opens the underlying reader, bound to the stream's lifetime signal. */
    open: (signal: AbortSignal) => AsyncGenerator<ChatStreamEvent, void, void>;
  }) {
    this.chatId = opts.chatId;
    this.#events = opts.open(this.#controller.signal);
  }

  get closed(): boolean {
    return this.#closePromise !== undefined;
  }

  /** Whether a resume segment for `chatId` may {@link attach}. */
  canAttach(chatId: string): boolean {
    return !this.closed && this.#reusable && this.chatId === chatId;
  }

  /**
   * The next event, memoized: repeated calls return the SAME promise until
   * {@link consumed} acknowledges delivery, so a read abandoned by one segment
   * is handed to the next instead of losing its event.
   */
  read(): Promise<IteratorResult<ChatStreamEvent, void>> {
    if (!this.#pending) {
      if (!this.#attached && !this.closed) {
        // Reads belong to segments; only the paused prefetch (issued by
        // pause() itself) may exist between segments.
        throw new CoderAgentError("SessionChatStream.read() without an attached segment");
      }
      this.#pending = this.#events.next();
      // Tag as handled: a rejection can land while no segment is racing this
      // read (detached, or the segment lost a race); the next consumer still
      // observes it by awaiting read().
      this.#pending.catch(() => {});
    }
    return this.#pending;
  }

  /**
   * Acknowledge that the segment received `p`'s result and the next
   * {@link read} should issue a fresh read. A no-op unless `p` is the
   * outstanding read — a raced-out segment never consumes.
   */
  consumed(p: Promise<IteratorResult<ChatStreamEvent, void>>): void {
    if (this.#pending === p) this.#pending = undefined;
  }

  /** Attach the resume segment to a stream paused at `requires_action`. */
  attach(): void {
    if (!this.canAttach(this.chatId) || this.#attached) {
      throw new CoderAgentError("SessionChatStream.attach() on a non-reusable stream");
    }
    this.#attached = true;
    this.#reusable = false;
  }

  /**
   * Segment settled at a healthy `requires_action` pause: keep the stream for
   * the tool-result resume, with a read outstanding so the reader's redial
   * machinery stays live while the client tools execute.
   */
  pause(): void {
    this.#attached = false;
    if (this.closed) return;
    this.#reusable = true;
    if (!this.#pending) {
      this.#pending = this.#events.next();
      this.#pending.catch(() => {});
    }
  }

  /**
   * Close the underlying reader (and socket). Idempotent; safe on a stream
   * whose generator already ended or threw.
   */
  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#attached = false;
      this.#reusable = false;
      this.#controller.abort();
      try {
        await this.#events.return(undefined);
      } catch {
        /* the reader's teardown errors are not the closer's problem */
      }
    })();
    return this.#closePromise;
  }
}
