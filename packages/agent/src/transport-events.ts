import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type { ChatStatus, ChatStreamEvent } from "./coder/types.js";

/**
 * Typed transport observability events (issue #45).
 *
 * A single optional `onTransportEvent` hook — on {@link CoderChatClientOptions},
 * {@link CoderLanguageModelConfig}, and {@link CoderAgentSettings} — receives
 * these events so consumers can build traces and timings from a stable event
 * vocabulary instead of wrapping `fetch`/`webSocketFactory` and re-parsing
 * every stream frame.
 *
 * Contract:
 * - **Isolation** — exceptions thrown by a subscriber are swallowed; they can
 *   never alter transport behavior or a turn's outcome.
 * - **Zero overhead** — without a subscriber, no event objects are allocated
 *   and no extra listeners are registered.
 * - **No secrets** — events carry no headers and no tokens. Authentication
 *   travels exclusively in the `Coder-Session-Token` request header, which is
 *   deliberately excluded; the `path`/`url` fields never contain credentials.
 * - **Observation, not interception** — events are emitted synchronously at
 *   observation time (`timestamp` is `Date.now()`, comparable to server-side
 *   timestamps such as a message's `created_at`); handlers cannot modify what
 *   the transport does. Payloads referenced by an event (`ws:event`'s decoded
 *   stream event) are shared with the pipeline — treat them as read-only.
 */
interface TransportEventBase {
  /** Wall-clock observation time in ms since epoch (`Date.now()`). */
  timestamp: number;
}

// --- HTTP (every REST call made by CoderChatClient) -------------------------

interface HttpTransportEventBase extends TransportEventBase {
  /**
   * Correlates a request with its response/error. Monotonically increasing
   * per client instance.
   */
  id: number;
  /** HTTP method, e.g. `POST`. */
  method: string;
  /**
   * Path + query relative to the client's `baseUrl`, e.g.
   * `/api/experimental/chats/{id}/tool-results`. Never carries credentials.
   */
  path: string;
}

/** A request is about to be sent. */
export interface HttpRequestTransportEvent extends HttpTransportEventBase {
  type: "http:request";
}

/**
 * Response headers arrived (before the body is read). Emitted for every
 * completed exchange, including non-2xx responses (`ok: false`) that the
 * client subsequently surfaces as a `CoderApiError`.
 */
export interface HttpResponseTransportEvent extends HttpTransportEventBase {
  type: "http:response";
  status: number;
  ok: boolean;
  /** Time from request start to response headers, in milliseconds. */
  durationMs: number;
}

/** The fetch itself rejected (network failure, abort) — no response arrived. */
export interface HttpErrorTransportEvent extends HttpTransportEventBase {
  type: "http:error";
  message: string;
  durationMs: number;
}

// --- WebSocket (the per-chat `/stream` reader) -------------------------------

interface StreamTransportEventBase extends TransportEventBase {
  chatId: string;
  /**
   * 1-based connection attempt within one reader (`streamChatEvents` call —
   * with stream retention (#44), one per turn). Increments on every redial.
   */
  attempt: number;
}

/** A connection attempt is starting (socket constructed). */
export interface StreamDialTransportEvent extends StreamTransportEventBase {
  type: "ws:dial";
  /** The `wss://…/stream[?after_id=N]` URL. Never carries credentials. */
  url: string;
}

/** The WebSocket handshake completed. */
export interface StreamOpenTransportEvent extends StreamTransportEventBase {
  type: "ws:open";
}

/**
 * A decoded stream event arrived on the wire. Emitted at arrival time for
 * every event in a frame batch, BEFORE replay dedup — after a redial, chatd's
 * replay of the in-progress episode is visible here even though the reader
 * suppresses the duplicates it forwards. `event` is the decoded object by
 * reference (no copy): do not mutate it.
 */
export interface StreamEventTransportEvent extends StreamTransportEventBase {
  type: "ws:event";
  event: ChatStreamEvent;
}

/**
 * The connection ended. Exactly one per dial: carries `code`/`reason` when
 * the server or network closed the socket; both are absent when the reader
 * tore the connection down itself (turn settled, redial teardown, abort).
 */
export interface StreamCloseTransportEvent extends StreamTransportEventBase {
  type: "ws:close";
  code?: number;
  reason?: string;
}

/**
 * An error was observed on the connection: a socket `error` event (including
 * rejected upgrades) or an unparseable frame. The reader's own terminal
 * classification still surfaces through the turn (see `segment:settle`).
 */
export interface StreamErrorTransportEvent extends StreamTransportEventBase {
  type: "ws:error";
  message: string;
}

/**
 * A dropped connection is about to be redialed after `backoffMs`. Carries the
 * redial budget state: the reader gives up (failing the turn) when
 * `consecutiveFailures` — connection endings without forward progress —
 * reaches `maxConsecutiveFailures`; any forward progress resets the count.
 * `attempt` is the connection that just ended; the next dial is `attempt + 1`.
 */
export interface StreamRedialTransportEvent extends StreamTransportEventBase {
  type: "ws:redial";
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  backoffMs: number;
}

// --- Turn segments (one doGenerate/doStream call each) -----------------------

interface SegmentTransportEventBase extends TransportEventBase {
  /** 1-based segment counter per model instance. */
  segment: number;
  /** Undefined on a first turn's start until the chat is created. */
  chatId?: string;
}

/**
 * A segment (one model round-trip: submission plus the server run until it
 * settles or pauses for a client tool) started. A turn that drives client
 * tools spans several segments.
 */
export interface SegmentStartTransportEvent extends SegmentTransportEventBase {
  type: "segment:start";
}

/**
 * The segment ended. Exactly one per start:
 * - settled cleanly → `status` is the turn's terminal chat status and
 *   `finishReason` the unified AI SDK finish reason (`tool-calls` marks a
 *   client-tool pause; the turn continues with a resume segment);
 * - failed (abort, timeout, transport failure, server error) → `error`;
 * - torn down before settling (consumer canceled the stream) → neither.
 */
export interface SegmentSettleTransportEvent extends SegmentTransportEventBase {
  type: "segment:settle";
  status?: ChatStatus;
  finishReason?: LanguageModelV4FinishReason["unified"];
  error?: { name: string; message: string };
  durationMs: number;
}

/** Every transport observability event, discriminated on `type`. */
export type CoderTransportEvent =
  | HttpRequestTransportEvent
  | HttpResponseTransportEvent
  | HttpErrorTransportEvent
  | StreamDialTransportEvent
  | StreamOpenTransportEvent
  | StreamEventTransportEvent
  | StreamCloseTransportEvent
  | StreamErrorTransportEvent
  | StreamRedialTransportEvent
  | SegmentStartTransportEvent
  | SegmentSettleTransportEvent;

/**
 * Subscriber for {@link CoderTransportEvent}s. Exceptions are swallowed —
 * including an `async` handler's rejection (a function returning a promise is
 * assignable to this void-returning signature, and its rejection must not
 * become an unhandled rejection either).
 */
export type TransportEventHandler = (event: CoderTransportEvent) => void;

/**
 * Wraps a subscriber so its exceptions can never reach the transport or a
 * turn. Returns `undefined` when there is no subscriber — emit sites guard on
 * that, so no event objects are allocated without one (internal).
 */
export function safeTransportEmitter(
  handler: TransportEventHandler | undefined,
): TransportEventHandler | undefined {
  if (!handler) return undefined;
  return (event) => {
    try {
      // The signature is void-returning, but TypeScript accepts an `async`
      // handler there — its rejection would land AFTER this try/catch and
      // become an unhandled rejection (killing the process on Node).
      // `Promise.resolve` adopts a returned thenable, so both a rejected
      // async handler and a sync throw (caught below, before the promise
      // wrapping) are silenced the same way. The handler still runs
      // synchronously; only its failure handling is deferred.
      void Promise.resolve(handler(event)).catch(() => {});
    } catch {
      // Observability must never alter turn outcomes: a throwing subscriber
      // is deliberately silenced rather than surfaced into the pipeline.
    }
  };
}
