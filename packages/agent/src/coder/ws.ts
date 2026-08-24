import NodeWebSocket from "ws";
import { CoderAgentError, CoderApiError, CoderStreamError } from "../errors.js";
import type { ChatStreamEvent, ChatWatchEvent } from "./types.js";

/**
 * A minimal WebSocket factory abstraction so the stream reader can run on
 * Node (via the `ws` package, with header auth) or in environments that
 * provide a global `WebSocket` (browsers, where auth must go in the query
 * string). Node is the default target.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
  removeEventListener(type: "open", cb: () => void): void;
  removeEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "error", cb: (ev: unknown) => void): void;
  removeEventListener(type: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
}

export type WebSocketFactory = (
  url: string,
  protocols: { headers: Record<string, string> },
) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url, { headers }) => {
  // `ws` accepts custom handshake headers, which lets us authenticate with the
  // `Coder-Session-Token` header instead of leaking the token into the URL.
  return new NodeWebSocket(url, { headers }) as unknown as WebSocketLike;
};

function httpToWs(baseUrl: string): string {
  if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
  if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
  return baseUrl;
}

export interface StreamChatEventsOptions {
  baseUrl: string;
  token: string;
  chatId: string;
  /** Only stream events for messages with id greater than this. */
  afterId?: number;
  signal?: AbortSignal;
  webSocketFactory?: WebSocketFactory;
}

const STREAM_BACKOFF_INITIAL_MS = 1_000;
const STREAM_BACKOFF_CAP_MS = 30_000;
/**
 * Consecutive progress-less connection endings tolerated before a dropped
 * per-chat stream gives up — counting the drop that starts an outage. Only
 * forward progress — a newly committed message or a new (unsuppressed) delta —
 * resets the count; chatd replays a `status` and the in-progress episode on
 * every reconnect, so counting mere receipt would let a half-dead connection
 * (connects, replays, drops) redial forever. With 1s→2s→4s→8s backoff between
 * the five endings this bounds a non-progressing network to ~15s of redialing
 * even without a caller signal or `requestTimeoutMs`.
 */
const STREAM_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Upgrade-rejection statuses that can succeed on a later attempt with the
 * exact same request: request timeout (408), too early (425), and rate
 * limiting (429). These consume the redial budget instead of failing fast;
 * every other 4xx (bad/expired token, deleted chat, …) is terminal.
 */
const TRANSIENT_UPGRADE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Opens the chatd `/stream` WebSocket and yields decoded {@link ChatStreamEvent}s
 * as an async iterable. Each text frame from chatd is a JSON array of events;
 * we flatten them into a single stream.
 *
 * The chat stream is a live subscription that stays open after a turn settles,
 * so callers should `break` out of the loop once they observe a terminal status
 * — that triggers generator cleanup, which closes the socket.
 *
 * Dropped connections are redialed with exponential backoff (like
 * {@link watchChatEvents}), replaying from the turn's ORIGINAL `after_id`. The
 * cursor is deliberately NOT advanced past messages already yielded: chatd's
 * initial sync filters out ids at or below `after_id`, so an advanced cursor
 * would silently lose same-id REVISION snapshots (updated content, tool
 * results, usage) committed while the connection was down. Consumers must
 * dedupe repeated `message` snapshots — the wire contract demands that anyway,
 * since chatd re-sends full snapshots on revision bumps even without a
 * reconnect (TurnTranslator does). On reconnect chatd also replays the
 * in-progress generation attempt's `message_part` deltas from `seq` 1, so
 * parts of an episode
 * (`history_version`, `generation_attempt`) at or below the last yielded `seq`
 * are suppressed here rather than double-yielded. The iteration ends in five
 * ways: `signal` aborting (clean return), a non-transient 4xx upgrade
 * rejection (terminal {@link CoderApiError} — bad/expired token or a deleted
 * chat cannot succeed on retry, while 408/425/429 consume the redial budget),
 * an unparseable frame (terminal {@link CoderAgentError} — a redial would
 * replay the same frame forever), a drop while deltas WITHOUT episode
 * coordinates are outstanding (older chatd; a {@link CoderStreamError},
 * because a delta replay could not be deduped and would double-emit — a NEW
 * committed `message` finalizes them into dedupable snapshots and re-enables
 * redial), or the redial budget running out (also a {@link CoderStreamError}).
 */
export function streamChatEvents(
  options: StreamChatEventsOptions,
): AsyncGenerator<ChatStreamEvent, void, void> {
  // Cancellation plumbing, mirroring watchChatEvents below: async-generator
  // `return()`/`throw()` queue behind a pending `next()`, and with redial a
  // pending read can now span a backoff sleep and a fresh socket — a bare
  // `return()` from a signal-less consumer would otherwise keep redialing
  // instead of tearing down. The wrapper aborts an internal controller first,
  // which wakes the pending read (and the backoff sleep), then delegates.
  const controller = new AbortController();
  const external = options.signal;
  const chain = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) chain();
    else external.addEventListener("abort", chain, { once: true });
  }
  const inner = streamChatEventsLoop({ ...options, signal: controller.signal });
  const detach = (): void => external?.removeEventListener("abort", chain);
  const finish = async (): Promise<void> => {
    controller.abort();
    detach();
    try {
      await inner.return();
    } catch {
      /* the loop's own teardown errors are not the caller's problem */
    }
  };
  return {
    // Detach the signal chain once the loop settles for good (done, or a
    // terminal failure) — the iteration protocol never calls return() on a
    // failed iterator, and the {once} listener would otherwise pile up on a
    // long-lived signal across re-created readers.
    async next(): Promise<IteratorResult<ChatStreamEvent, void>> {
      try {
        const result = await inner.next();
        if (result.done) detach();
        return result;
      } catch (err) {
        detach();
        throw err;
      }
    },
    async return(): Promise<IteratorResult<ChatStreamEvent, void>> {
      await finish();
      return { done: true, value: undefined };
    },
    async throw(err: unknown): Promise<IteratorResult<ChatStreamEvent, void>> {
      await finish();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    // Native async generators are async-disposable; the wrapper must be too.
    async [Symbol.asyncDispose](): Promise<void> {
      await finish();
    },
  } as AsyncGenerator<ChatStreamEvent, void, void>;
}

async function* streamChatEventsLoop(
  options: StreamChatEventsOptions,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const { baseUrl, token, chatId, signal } = options;
  const factory = options.webSocketFactory ?? defaultFactory;

  const wsBase = httpToWs(baseUrl);
  const path = `/api/experimental/chats/${chatId}/stream`;
  // The turn's original cursor, reused verbatim on every redial — see the doc
  // comment above for why it must not advance past yielded messages.
  const query = options.afterId !== undefined ? `?after_id=${options.afterId}` : "";
  const url = `${wsBase}${path}${query}`;

  // Highest committed message id yielded, for progress accounting only.
  let maxCommittedId = options.afterId;
  // Last yielded delta position, for suppressing chatd's from-the-start replay
  // of the in-progress episode after a redial.
  let lastHistoryVersion: number | undefined;
  let lastGenerationAttempt: number | undefined;
  let lastSeq: number | undefined;
  // Deltas missing those coordinates (older servers) cannot be deduped on
  // replay: while any are outstanding, a drop is terminal instead of redialed
  // — the pre-redial behavior — because a replay would double-emit them. A
  // NEW committed `message` finalizes them (their content then arrives only as
  // snapshots, which consumers dedupe), making redial safe again.
  let sawUntrackableDelta = false;

  let backoffMs = STREAM_BACKOFF_INITIAL_MS;
  let failures = 0;
  let lastFailure: Error | undefined;

  while (!signal?.aborted) {
    // One connection attempt per iteration; the queue/wake plumbing mirrors
    // watchChatEventsLoop below.
    const queue: ChatStreamEvent[] = [];
    let resolveNext: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    let parseFailure = false;

    const wake = () => {
      resolveNext?.();
      resolveNext = undefined;
    };

    const ws = factory(url, { headers: { "Coder-Session-Token": token } });

    const onAbort = () => {
      finished = true;
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
      wake();
    };
    let abortListenerAdded = false;
    if (signal) {
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        abortListenerAdded = true;
      }
    }

    const onMessage = (ev: { data: unknown }): void => {
      if (finished) return;
      let batch: unknown;
      try {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data);
        batch = JSON.parse(data);
      } catch (err) {
        failure = new CoderAgentError("failed to parse chat stream frame", { cause: err });
        parseFailure = true;
        finished = true;
        wake();
        return;
      }
      if (Array.isArray(batch)) {
        for (const e of batch) queue.push(e as ChatStreamEvent);
      } else if (batch && typeof batch === "object") {
        queue.push(batch as ChatStreamEvent);
      }
      wake();
    };
    const onError = (ev: unknown): void => {
      if (finished) return;
      const message =
        ev && typeof ev === "object" && "message" in ev
          ? String((ev as { message: unknown }).message)
          : "chat stream socket error";
      const status = upgradeStatus(message);
      failure =
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        !TRANSIENT_UPGRADE_STATUSES.has(status)
          ? new CoderApiError({ status, method: "GET", path, message })
          : new CoderAgentError(message);
      finished = true;
      wake();
    };
    const onClose = (): void => {
      finished = true;
      wake();
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    try {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift() as ChatStreamEvent;
          // Only forward progress resets the redial budget: a new delta or a
          // newly committed message. Replays (chatd re-sends a `status` and the
          // in-progress episode on every reconnect) don't count — otherwise a
          // half-dead connection that connects, replays, and drops would reset
          // the budget each round and redial forever.
          let progress = false;
          if (next.type === "message_part") {
            const mp = next.message_part;
            const hv = mp?.history_version;
            const ga = mp?.generation_attempt;
            const seq = mp?.seq;
            if (hv !== undefined && ga !== undefined && seq !== undefined) {
              if (
                hv === lastHistoryVersion &&
                ga === lastGenerationAttempt &&
                lastSeq !== undefined &&
                seq <= lastSeq
              ) {
                continue; // an already-yielded delta, replayed after a redial
              }
              lastHistoryVersion = hv;
              lastGenerationAttempt = ga;
              lastSeq = seq;
              progress = true;
            } else {
              // No episode coordinates: cannot be deduped on replay, so it
              // must not count as progress and disables redial (see below).
              sawUntrackableDelta = true;
            }
          } else if (next.type === "message" && next.message) {
            if (maxCommittedId === undefined || next.message.id > maxCommittedId) {
              maxCommittedId = next.message.id;
              progress = true;
              // This commit finalizes the in-progress deltas: their content
              // now lives in committed snapshots, which consumers dedupe, so
              // a replay can no longer duplicate coordinate-less deltas.
              sawUntrackableDelta = false;
            }
          }
          if (progress) {
            failures = 0;
            backoffMs = STREAM_BACKOFF_INITIAL_MS;
          }
          yield next;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      finished = true;
      if (signal && abortListenerAdded) signal.removeEventListener("abort", onAbort);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }

    if (signal?.aborted) return;
    // A rejected upgrade (non-transient 4xx) is terminal: retrying with the
    // same credentials against the same (possibly deleted) chat cannot
    // succeed. An unparseable frame is terminal too: the cursor cannot advance
    // past an event we cannot decode, so a redial would replay the exact same
    // frame forever.
    if (failure instanceof CoderApiError) throw failure;
    if (parseFailure && failure) throw failure;
    if (sawUntrackableDelta) {
      // A CoderStreamError (not a bare CoderAgentError) so the model layer
      // applies its retry-safety gates — otherwise the generic stream_closed
      // wrap would advertise a same-chat retry that could duplicate the turn.
      throw new CoderStreamError({
        message:
          "chat stream dropped mid-turn and cannot be resumed: this server does not stamp deltas with history_version/generation_attempt/seq, so a redial would replay them",
        url,
        cause: failure,
      });
    }
    if (failure) lastFailure = failure;
    // EVERY ended connection counts toward the budget — including the one
    // whose drop started this outage — so the give-up bound stays ~15s of
    // backoff on all paths; forward progress above resets the count.
    failures += 1;
    if (failures >= STREAM_MAX_CONSECUTIVE_FAILURES) {
      throw new CoderStreamError({
        message: `Coder chat stream ${path} could not be (re-)established after ${failures} consecutive connection failures without progress`,
        url,
        cause: lastFailure,
      });
    }
    await sleep(backoffMs, signal);
    if (signal?.aborted) return;
    backoffMs = Math.min(backoffMs * 2, STREAM_BACKOFF_CAP_MS);
  }
}

const WATCH_PATH = "/api/experimental/chats/watch";
const WATCH_BACKOFF_INITIAL_MS = 1_000;
const WATCH_BACKOFF_CAP_MS = 30_000;

/** Abort-aware sleep; resolves early (without throwing) when the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // The timer stays ref'd on purpose: an actively consumed watch loop must
    // keep the process alive through a reconnect delay (abort clears it).
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Extract the HTTP status from a rejected WebSocket upgrade. The `ws` package
 * reports handshake failures as an error event whose message is
 * `Unexpected server response: <status>`; other factories that follow the
 * same convention are recognized too.
 */
function upgradeStatus(message: string): number | undefined {
  const match = /unexpected server response: (\d{3})$/i.exec(message.trim());
  return match ? Number(match[1]) : undefined;
}

export interface WatchChatEventsOptions {
  baseUrl: string;
  token: string;
  signal?: AbortSignal;
  webSocketFactory?: WebSocketFactory;
}

/**
 * Opens the chatd `/watch` WebSocket — lifecycle events for every chat visible
 * to the authenticated user — and yields decoded {@link ChatWatchEvent}s as an
 * async iterable.
 *
 * Unlike the per-chat `/stream`, this is a long-lived subscription, so dropped
 * connections are redialed automatically with exponential backoff (1s doubling
 * to a 30s cap, reset once an event arrives). It ends in exactly three ways:
 * `signal` aborting, the consumer ending iteration (`break` from `for await`,
 * `iterator.return()`) — both tear the socket down promptly even while a read
 * is pending — or the server rejecting the upgrade with a 4xx — bad/expired
 * token, or an older Coder server without the endpoint (404) — which throws a
 * terminal {@link CoderApiError} instead of retrying forever.
 */
export function watchChatEvents(
  options: WatchChatEventsOptions,
): AsyncGenerator<ChatWatchEvent, void, void> {
  // Cancellation plumbing: async-generator `return()`/`throw()` queue behind a
  // pending `next()`, and on this rarely-eventing stream a pending read is the
  // steady state — a bare `return()` would otherwise hang (socket open) until
  // the next server event. The wrapper aborts an internal controller first,
  // which wakes the pending read, then delegates.
  const controller = new AbortController();
  const external = options.signal;
  const chain = (): void => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) chain();
    else external.addEventListener("abort", chain, { once: true });
  }
  const inner = watchChatEventsLoop({ ...options, signal: controller.signal });
  const detach = (): void => external?.removeEventListener("abort", chain);
  const finish = async (): Promise<void> => {
    controller.abort();
    detach();
    try {
      await inner.return();
    } catch {
      /* the loop's own teardown errors are not the caller's problem */
    }
  };
  return {
    // Detach the signal chain once the loop settles for good (done, or the
    // terminal 4xx rejection) — the iteration protocol never calls return()
    // on a failed iterator, and the {once} listener would otherwise pile up
    // on a long-lived signal across re-created watchers.
    async next(): Promise<IteratorResult<ChatWatchEvent, void>> {
      try {
        const result = await inner.next();
        if (result.done) detach();
        return result;
      } catch (err) {
        detach();
        throw err;
      }
    },
    async return(): Promise<IteratorResult<ChatWatchEvent, void>> {
      await finish();
      return { done: true, value: undefined };
    },
    async throw(err: unknown): Promise<IteratorResult<ChatWatchEvent, void>> {
      await finish();
      throw err;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    // Native async generators are async-disposable; the wrapper must be too,
    // so `await using events = client.watchChats(…)` keeps tearing down.
    async [Symbol.asyncDispose](): Promise<void> {
      await finish();
    },
  } as AsyncGenerator<ChatWatchEvent, void, void>;
}

async function* watchChatEventsLoop(
  options: WatchChatEventsOptions,
): AsyncGenerator<ChatWatchEvent, void, void> {
  const { baseUrl, token, signal } = options;
  const factory = options.webSocketFactory ?? defaultFactory;
  const url = `${httpToWs(baseUrl)}${WATCH_PATH}`;

  let backoffMs = WATCH_BACKOFF_INITIAL_MS;
  while (!signal?.aborted) {
    // One connection attempt per iteration; the queue/wake plumbing mirrors
    // streamChatEvents above.
    const queue: ChatWatchEvent[] = [];
    let resolveNext: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;

    const wake = () => {
      resolveNext?.();
      resolveNext = undefined;
    };

    const ws = factory(url, { headers: { "Coder-Session-Token": token } });

    const onAbort = () => {
      finished = true;
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
      wake();
    };
    let abortListenerAdded = false;
    if (signal) {
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        abortListenerAdded = true;
      }
    }

    const onMessage = (ev: { data: unknown }): void => {
      if (finished) return;
      let payload: unknown;
      try {
        const data = typeof ev.data === "string" ? ev.data : String(ev.data);
        payload = JSON.parse(data);
      } catch (err) {
        // A malformed frame means this connection is unusable; redial it.
        failure = new CoderAgentError("failed to parse chat watch frame", { cause: err });
        finished = true;
        wake();
        return;
      }
      // chatd sends one event object per frame (wsjson); tolerate batches too.
      if (Array.isArray(payload)) {
        for (const e of payload) queue.push(e as ChatWatchEvent);
      } else if (payload && typeof payload === "object") {
        queue.push(payload as ChatWatchEvent);
      }
      wake();
    };
    const onError = (ev: unknown): void => {
      if (finished) return;
      const message =
        ev && typeof ev === "object" && "message" in ev
          ? String((ev as { message: unknown }).message)
          : "chat watch socket error";
      const status = upgradeStatus(message);
      failure =
        status !== undefined && status >= 400 && status < 500
          ? new CoderApiError({ status, method: "GET", path: WATCH_PATH, message })
          : new CoderAgentError(message);
      finished = true;
      wake();
    };
    const onClose = (): void => {
      finished = true;
      wake();
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    try {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift() as ChatWatchEvent;
          // Receiving an event proves the connection works — reset the backoff.
          backoffMs = WATCH_BACKOFF_INITIAL_MS;
          yield next;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      finished = true;
      if (signal && abortListenerAdded) signal.removeEventListener("abort", onAbort);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      try {
        ws.close(1000);
      } catch {
        /* ignore */
      }
    }

    if (signal?.aborted) return;
    // A rejected upgrade (4xx) is terminal: retrying with the same credentials
    // against the same server cannot succeed.
    if (failure instanceof CoderApiError) throw failure;
    await sleep(backoffMs, signal);
    if (signal?.aborted) return;
    backoffMs = Math.min(backoffMs * 2, WATCH_BACKOFF_CAP_MS);
  }
}
