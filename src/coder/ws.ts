import NodeWebSocket from "ws";
import { CoderAgentError } from "../errors.js";
import type { ChatStreamEvent } from "./types.js";

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

export type WebSocketFactory = (url: string, protocols: { headers: Record<string, string> }) => WebSocketLike;

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

/**
 * Opens the chatd `/stream` WebSocket and yields decoded {@link ChatStreamEvent}s
 * as an async iterable. Each text frame from chatd is a JSON array of events;
 * we flatten them into a single stream.
 *
 * The chat stream is a live subscription that stays open after a turn settles,
 * so callers should `break` out of the loop once they observe a terminal status
 * — that triggers generator cleanup, which closes the socket.
 */
export async function* streamChatEvents(
  options: StreamChatEventsOptions,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const { baseUrl, token, chatId, afterId, signal } = options;
  const factory = options.webSocketFactory ?? defaultFactory;

  const wsBase = httpToWs(baseUrl);
  const query = afterId !== undefined ? `?after_id=${afterId}` : "";
  const url = `${wsBase}/api/experimental/chats/${chatId}/stream${query}`;

  const queue: ChatStreamEvent[] = [];
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
    let batch: unknown;
    try {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      batch = JSON.parse(data);
    } catch (err) {
      failure = new CoderAgentError("failed to parse chat stream frame", { cause: err });
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
    failure = new CoderAgentError(message);
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
        yield next;
      }
      if (failure) throw failure;
      if (finished) return;
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
}
