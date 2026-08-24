import { describe, expect, it, vi } from "vitest";
import { CoderChatClient } from "../../src/coder/client.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import {
  type CoderTransportEvent,
  safeTransportEmitter,
  type TransportEventHandler,
} from "../../src/transport-events.js";
import type { Chat, ChatMessage, ChatMessagePart, ChatStreamEvent } from "../../src/coder/types.js";
import type { WebSocketFactory, WebSocketLike } from "../../src/coder/ws.js";

// --- fixtures (mirroring agent.test.ts) --------------------------------------

const TOKEN = "super-secret-session-token";

function chatStub(id: string, organizationId = "org-1"): Chat {
  return {
    id,
    organization_id: organizationId,
    owner_id: "u",
    title: "t",
    status: "running",
    created_at: "",
    updated_at: "",
    archived: false,
  };
}

function msg(id: number, role: ChatMessage["role"], content: ChatMessagePart[]): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "chat-1",
    message: { id, chat_id: "chat-1", role, created_at: "2026-01-01T00:00:00Z", content },
  };
}
function status(s: string): ChatStreamEvent {
  return { type: "status", chat_id: "chat-1", status: { status: s as never } };
}
const delta = (hv: number, seq: number, text: string): ChatStreamEvent => ({
  type: "message_part",
  chat_id: "chat-1",
  message_part: {
    role: "assistant",
    part: { type: "text", text },
    history_version: hv,
    generation_attempt: 1,
    seq,
  },
});
const streamFrame = (...events: ChatStreamEvent[]) => ({ data: JSON.stringify(events) });

type Listener = (ev?: unknown) => void;

/** A scripted socket that also exposes listener counts (zero-overhead probe). */
class FakeSocket {
  readonly url: string;
  closed = false;
  #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
  }
  send(_data: string): void {}
  close(_code?: number): void {
    this.closed = true;
  }
  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }
  emit(type: "open" | "message" | "error" | "close", ev?: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(ev);
  }
  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

/**
 * A real CoderChatClient + CoderLanguageModel on a scripted fetch and socket
 * factory, with the observability hook collecting into `events` (or a custom
 * handler). The REAL stream reader and turn machinery run.
 */
function harness(config?: {
  hook?: TransportEventHandler;
  withoutHook?: boolean;
  /** Make the WebSocket factory itself throw synchronously on every dial. */
  throwOnDial?: boolean;
  /** Per-segment time budget passed to the model (settle classification, #73). */
  requestTimeoutMs?: number;
}) {
  const events: CoderTransportEvent[] = [];
  const onTransportEvent = config?.withoutHook
    ? undefined
    : (config?.hook ?? ((ev: CoderTransportEvent) => void events.push(ev)));
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    if (config?.throwOnDial) throw new Error("factory exploded");
    const s = new FakeSocket(url);
    sockets.push(s);
    return s as WebSocketLike;
  };
  const fetchCalls: string[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    fetchCalls.push(`${init.method} ${pathname}${search}`);
    if (init.method === "GET" && pathname.endsWith("/messages")) {
      return Promise.resolve(
        new Response(JSON.stringify({ messages: [], queued_messages: [], has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(chatStub("chat-1")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new CoderChatClient({
    baseUrl: "https://x",
    token: TOKEN,
    fetch: fetchFn,
    webSocketFactory: factory,
    onTransportEvent,
  });
  const model = new CoderLanguageModel({
    client,
    organizationId: "org-1",
    onTransportEvent,
    requestTimeoutMs: config?.requestTimeoutMs,
  });
  return { events, model, client, sockets, fetchCalls };
}

const newTurnOptions = () =>
  ({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }) as never;

const collect = (stream: ReadableStream<unknown>) => {
  const parts: Record<string, unknown>[] = [];
  const done = (async () => {
    const reader = stream.getReader();
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      parts.push(value as Record<string, unknown>);
    }
  })();
  return { parts, done };
};

// --- HTTP events --------------------------------------------------------------

describe("transport events: HTTP", () => {
  it("emits a request/response pair with correlation id, status, and timing", async () => {
    const events: CoderTransportEvent[] = [];
    const client = new CoderChatClient({
      baseUrl: "https://x",
      token: TOKEN,
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify(chatStub("c1")), { status: 200 }),
        )) as unknown as typeof globalThis.fetch,
      onTransportEvent: (ev) => void events.push(ev),
    });

    await client.getChat("c1");

    expect(events.map((e) => e.type)).toEqual(["http:request", "http:response"]);
    const [req, res] = events as [
      Extract<CoderTransportEvent, { type: "http:request" }>,
      Extract<CoderTransportEvent, { type: "http:response" }>,
    ];
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/experimental/chats/c1");
    expect(req.timestamp).toBeTypeOf("number");
    expect(res.id).toBe(req.id);
    expect(res.method).toBe("GET");
    expect(res.path).toBe(req.path);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits an ok:false response for a non-2xx exchange (which still throws)", async () => {
    const events: CoderTransportEvent[] = [];
    const client = new CoderChatClient({
      baseUrl: "https://x",
      token: TOKEN,
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "gone" }), { status: 404 }),
        )) as unknown as typeof globalThis.fetch,
      onTransportEvent: (ev) => void events.push(ev),
    });

    await expect(client.getChat("c1")).rejects.toMatchObject({ status: 404 });
    expect(events.map((e) => e.type)).toEqual(["http:request", "http:response"]);
    expect(events[1]).toMatchObject({ type: "http:response", status: 404, ok: false });
  });

  it("emits http:error when the fetch itself rejects", async () => {
    const events: CoderTransportEvent[] = [];
    const client = new CoderChatClient({
      baseUrl: "https://x",
      token: TOKEN,
      fetch: (() =>
        Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch,
      onTransportEvent: (ev) => void events.push(ev),
    });

    await expect(client.getChat("c1")).rejects.toThrow("fetch failed");
    expect(events.map((e) => e.type)).toEqual(["http:request", "http:error"]);
    expect(events[1]).toMatchObject({ type: "http:error", message: "fetch failed" });
    expect((events[1] as { id: number }).id).toBe((events[0] as { id: number }).id);
  });

  it("increments the correlation id across requests on the same client", async () => {
    const events: CoderTransportEvent[] = [];
    const client = new CoderChatClient({
      baseUrl: "https://x",
      token: TOKEN,
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify(chatStub("c1")), { status: 200 }),
        )) as unknown as typeof globalThis.fetch,
      onTransportEvent: (ev) => void events.push(ev),
    });

    await client.getChat("c1");
    await client.getChat("c2");
    const ids = events
      .filter((e) => e.type === "http:request")
      .map((e) => (e as { id: number }).id);
    expect(ids).toEqual([1, 2]);
  });
});

// --- WS + segment events over a full turn -------------------------------------

describe("transport events: turn lifecycle (real reader)", () => {
  it("emits the full ordered sequence for a simple turn", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("open");
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(1, 1, "Hello"),
          msg(2, "assistant", [{ type: "text", text: "Hello" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done;

      expect(events.map((e) => e.type)).toEqual([
        "segment:start",
        "http:request", // POST /chats (create)
        "http:response",
        "ws:dial",
        "ws:open",
        "ws:event", // status running
        "ws:event", // delta
        "ws:event", // message snapshot
        "ws:event", // status waiting
        "ws:close",
        "segment:settle",
      ]);

      const dial = events.find((e) => e.type === "ws:dial") as Extract<
        CoderTransportEvent,
        { type: "ws:dial" }
      >;
      expect(dial.url).toBe("wss://x/api/experimental/chats/chat-1/stream");
      expect(dial.chatId).toBe("chat-1");
      expect(dial.attempt).toBe(1);

      const wsEvents = events.filter((e) => e.type === "ws:event") as Extract<
        CoderTransportEvent,
        { type: "ws:event" }
      >[];
      expect(wsEvents.map((e) => e.event.type)).toEqual([
        "status",
        "message_part",
        "message",
        "status",
      ]);
      // Decoded payloads are carried by reference: id + created_at reachable.
      expect(wsEvents[2]?.event.message?.id).toBe(2);
      expect(wsEvents[2]?.event.message?.created_at).toBe("2026-01-01T00:00:00Z");

      // Locally closed at settle: no close code.
      const close = events.find((e) => e.type === "ws:close") as { code?: number };
      expect(close.code).toBeUndefined();

      const start = events[0] as Extract<CoderTransportEvent, { type: "segment:start" }>;
      expect(start.segment).toBe(1);
      expect(start.chatId).toBeUndefined(); // not created yet at segment start

      const settle = events.at(-1) as Extract<CoderTransportEvent, { type: "segment:settle" }>;
      expect(settle.segment).toBe(1);
      expect(settle.chatId).toBe("chat-1");
      expect(settle.status).toBe("waiting");
      expect(settle.finishReason).toBe("stop");
      expect(settle.error).toBeUndefined();
      expect(settle.durationMs).toBeGreaterThanOrEqual(0);

      // Redaction: no event ever carries the session token (or any headers).
      expect(JSON.stringify(events)).not.toContain(TOKEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits dial/close/redial matching the #55 budget semantics, then an error settle", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      // Handler attached up-front: the rejection lands while timers advance.
      const err = s.done.then(
        () => undefined,
        (e: unknown) => e,
      );
      // 5 consecutive progress-less connection endings exhaust the budget,
      // with 1s → 2s → 4s → 8s backoff between them.
      for (const backoff of [1000, 2000, 4000, 8000]) {
        await vi.advanceTimersByTimeAsync(0);
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(backoff);
      }
      await vi.advanceTimersByTimeAsync(0);
      sockets.at(-1)?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(0);
      expect(String(await err)).toMatch(/consecutive connection failures/);

      const dials = events.filter((e) => e.type === "ws:dial") as { attempt: number }[];
      expect(dials.map((d) => d.attempt)).toEqual([1, 2, 3, 4, 5]);
      const closes = events.filter((e) => e.type === "ws:close") as { code?: number }[];
      expect(closes.map((c) => c.code)).toEqual([1006, 1006, 1006, 1006, 1006]);
      const redials = events.filter((e) => e.type === "ws:redial") as Extract<
        CoderTransportEvent,
        { type: "ws:redial" }
      >[];
      expect(
        redials.map((r) => ({
          attempt: r.attempt,
          failures: r.consecutiveFailures,
          max: r.maxConsecutiveFailures,
          backoffMs: r.backoffMs,
        })),
      ).toEqual([
        { attempt: 1, failures: 1, max: 5, backoffMs: 1000 },
        { attempt: 2, failures: 2, max: 5, backoffMs: 2000 },
        { attempt: 3, failures: 3, max: 5, backoffMs: 4000 },
        { attempt: 4, failures: 4, max: 5, backoffMs: 8000 },
      ]);
      // The 5th ending exhausts the budget: no redial follows, the turn fails.
      const settle = events.at(-1) as Extract<CoderTransportEvent, { type: "segment:settle" }>;
      expect(settle.type).toBe("segment:settle");
      expect(settle.error?.name).toBe("CoderStreamError");
      expect(settle.status).toBeUndefined();
      // The failure discarded the freshly created session (resetSession), but
      // the settle still names the chat the ws:*/http:* events identified.
      expect(settle.chatId).toBe("chat-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("replayed events after a redial are observable at arrival (pre-dedup)", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), delta(1, 1, "Hel")));
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      // The redial replays the in-progress episode from seq 1.
      sockets[1]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(1, 1, "Hel"),
          delta(1, 2, "lo"),
          msg(2, "assistant", [{ type: "text", text: "Hello" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done;

      // The reader suppressed the replayed seq-1 delta from the turn, but the
      // hook observed it on attempt 2 (arrival-time observation).
      const attempt2Deltas = events.filter(
        (e) =>
          e.type === "ws:event" &&
          e.attempt === 2 &&
          e.event.type === "message_part" &&
          e.event.message_part?.seq === 1,
      );
      expect(attempt2Deltas).toHaveLength(1);
      // The turn itself emitted "Hello" exactly once.
      const text = s.parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits ws:error for socket error events", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      // Handler attached up-front: the rejection lands while timers advance.
      const err = s.done.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("error", { message: "unexpected server response: 401" });
      await vi.advanceTimersByTimeAsync(0);
      expect(String(await err)).toMatch(/401/);

      expect(events.filter((e) => e.type === "ws:error")).toEqual([
        expect.objectContaining({
          type: "ws:error",
          chatId: "chat-1",
          attempt: 1,
          message: "unexpected server response: 401",
        }),
      ]);
      // The failed connection still gets its close event.
      expect(events.filter((e) => e.type === "ws:close")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spans one ws across a multi-segment client-tool turn", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets, fetchCalls } = harness();
      const tools = [
        { type: "function", name: "getWeather", description: "w", inputSchema: { type: "object" } },
      ];
      // Segment 1: new turn → requires_action pause.
      const s1 = collect(
        (
          await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
            tools,
          } as never)
        ).stream,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(1, 1, "Checking."),
          msg(3, "assistant", [
            { type: "text", text: "Checking." },
            {
              type: "tool-call",
              tool_call_id: "c1",
              tool_name: "getWeather",
              args: { city: "Paris" },
            },
          ]),
          status("requires_action"),
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;

      // Segment 2: tool-result resume on the SAME socket.
      const s2 = collect(
        (
          await model.doStream({
            prompt: [
              { role: "user", content: [{ type: "text", text: "weather?" }] },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "c1",
                    toolName: "getWeather",
                    input: { city: "Paris" },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "c1",
                    toolName: "getWeather",
                    output: { type: "json", value: { temp: 21 } },
                  },
                ],
              },
            ],
            tools,
          } as never)
        ).stream,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(2, 1, "It is 21C."),
          msg(5, "assistant", [{ type: "text", text: "It is 21C." }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;

      // ONE dial, ONE close — the stream spanned both segments (#44).
      expect(sockets).toHaveLength(1);
      expect(events.filter((e) => e.type === "ws:dial")).toHaveLength(1);
      expect(events.filter((e) => e.type === "ws:close")).toHaveLength(1);

      const segments = events.filter(
        (e) => e.type === "segment:start" || e.type === "segment:settle",
      ) as Extract<CoderTransportEvent, { type: "segment:start" | "segment:settle" }>[];
      expect(
        segments.map((e) =>
          e.type === "segment:start"
            ? { type: e.type, segment: e.segment }
            : { type: e.type, segment: e.segment, status: e.status, finishReason: e.finishReason },
        ),
      ).toEqual([
        { type: "segment:start", segment: 1 },
        {
          type: "segment:settle",
          segment: 1,
          status: "requires_action",
          finishReason: "tool-calls",
        },
        { type: "segment:start", segment: 2 },
        { type: "segment:settle", segment: 2, status: "waiting", finishReason: "stop" },
      ]);
      // The close happened after segment 2 started (the pause retained it).
      expect(events.findIndex((e) => e.type === "ws:close")).toBeGreaterThan(
        events.findIndex((e) => e.type === "segment:start" && e.segment === 2),
      );
      // The resume segment posted tool results — visible as HTTP events.
      expect(
        events.some((e) => e.type === "http:request" && e.path.endsWith("/tool-results")),
      ).toBe(true);
      expect(fetchCalls.filter((c) => c.includes("/tool-results"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- isolation & zero overhead -------------------------------------------------

describe("transport events: isolation and overhead", () => {
  it("a throwing subscriber does not affect the turn outcome", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { model, sockets } = harness({
        hook: () => {
          calls += 1;
          throw new Error("subscriber boom");
        },
      });
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(1, 1, "Hello"),
          msg(2, "assistant", [{ type: "text", text: "Hello" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done; // resolves — the turn is unaffected

      expect(calls).toBeGreaterThan(0); // the subscriber DID run (and threw)
      const text = s.parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Hello");
      expect(s.parts.at(-1)).toMatchObject({
        type: "finish",
        finishReason: { unified: "stop" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an async subscriber whose promise rejects does not affect the turn (no unhandled rejection)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { model, sockets } = harness({
        // An async handler is assignable to the void-returning signature; its
        // rejection must be silenced like a sync throw (vitest fails this test
        // on any unhandled rejection).
        hook: (async () => {
          calls += 1;
          throw new Error("async subscriber boom");
        }) as unknown as TransportEventHandler,
      });
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          delta(1, 1, "Hello"),
          msg(2, "assistant", [{ type: "text", text: "Hello" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done; // resolves — the turn is unaffected

      expect(calls).toBeGreaterThan(0);
      const text = s.parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a synchronously-throwing socket factory still gets ws:error and exactly one ws:close", async () => {
    vi.useFakeTimers();
    try {
      const { events, model } = harness({ throwOnDial: true });
      const s = collect((await model.doStream(newTurnOptions())).stream);
      const err = s.done.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(String(await err)).toMatch(/factory exploded/);

      // The dial is matched by an error and exactly one close, then the
      // segment settles with the failure — no unmatched dial.
      expect(events.filter((e) => e.type === "ws:dial")).toHaveLength(1);
      expect(events.filter((e) => e.type === "ws:error")).toEqual([
        expect.objectContaining({ type: "ws:error", attempt: 1, message: "factory exploded" }),
      ]);
      expect(events.filter((e) => e.type === "ws:close")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "segment:settle",
        error: { message: "factory exploded" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers no observability listeners and allocates no events without a subscriber", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = harness({ withoutHook: true });
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      // The reader itself never listens for "open"; that listener exists only
      // for the observability hook — its absence proves the unobserved path.
      expect(sockets[0]?.listenerCount("open")).toBe(0);
      expect(sockets[0]?.listenerCount("message")).toBe(1);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(2, "assistant", [{ type: "text", text: "ok" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the open listener only when subscribed", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[0]?.listenerCount("open")).toBe(1);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(2, "assistant", [{ type: "text", text: "ok" }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("safeTransportEmitter is undefined without a handler (nothing to allocate for)", () => {
    expect(safeTransportEmitter(undefined)).toBeUndefined();
  });

  it("a streamed server error settles with error AND the frame-batched terminal status via doGenerate", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const done = model
        .doGenerate(newTurnOptions())
        .then(() => undefined)
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      // doGenerate throws on the error part and closes the generator without
      // another pull — the settle must still record the server failure.
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          { type: "error", chat_id: "chat-1", error: { message: "provider exploded" } },
          status("error"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const err = await done;
      expect(String(err)).toMatch(/provider exploded/);

      const settle = events.find((e) => e.type === "segment:settle") as Extract<
        CoderTransportEvent,
        { type: "segment:settle" }
      >;
      expect(settle).toBeDefined();
      expect(settle.error).toMatchObject({
        name: "CoderChatError",
        message: "provider exploded",
      });
      expect(settle.chatId).toBe("chat-1");
      // #72: the terminal `status: "error"` shared the WS frame with the
      // error event — the settle must carry it even though the finish part
      // never reached the consumer.
      expect(settle.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a streamed server error settles with error AND terminal status via doStream", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const s = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          { type: "error", chat_id: "chat-1", error: { message: "provider exploded" } },
          status("error"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s.done; // error surfaces as parts; the stream itself ends cleanly

      // The consumer saw the error part and the finish part…
      expect(s.parts.some((p) => p.type === "error")).toBe(true);
      expect(s.parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "error" } });
      // …and the settle records the failure plus the terminal status.
      const settle = events.at(-1) as Extract<CoderTransportEvent, { type: "segment:settle" }>;
      expect(settle.type).toBe("segment:settle");
      expect(settle.error).toMatchObject({ name: "CoderChatError", message: "provider exploded" });
      expect(settle.status).toBe("error");
      expect(settle.finishReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a consumer cancel settles the segment as a teardown (no status, no error)", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const { stream } = await model.doStream(newTurnOptions());
      const reader = (stream as ReadableStream<unknown>).getReader();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), delta(1, 1, "Hel")));
      await vi.advanceTimersByTimeAsync(0);
      // Consume what's buffered, then cancel while the next read is blocked
      // on the socket — the documented consumer-teardown path.
      await reader.read(); // stream-start
      const cancelled = reader.cancel();
      await vi.advanceTimersByTimeAsync(0);
      await cancelled;

      const settle = events.find((e) => e.type === "segment:settle") as Extract<
        CoderTransportEvent,
        { type: "segment:settle" }
      >;
      expect(settle).toBeDefined();
      expect(settle.error).toBeUndefined();
      expect(settle.status).toBeUndefined();
      expect(settle.finishReason).toBeUndefined();
      expect(settle.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller abort followed by a consumer cancel still settles as a failure", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const controller = new AbortController();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        abortSignal: controller.signal,
      } as never);
      const reader = (stream as ReadableStream<unknown>).getReader();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      await reader.read(); // stream-start
      const pending = reader.read().then(
        () => undefined,
        (e: unknown) => e,
      );
      // The CALLER aborts first; the consumer then cancels its reader before
      // the rejection propagates — the settle must keep the abort failure,
      // not be reclassified as a teardown.
      controller.abort();
      const cancelled = reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      await cancelled;

      const settle = events.find((e) => e.type === "segment:settle") as Extract<
        CoderTransportEvent,
        { type: "segment:settle" }
      >;
      expect(settle).toBeDefined();
      expect(settle.error?.name).toBe("AbortError");
      expect(settle.status).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller abort on a suspended generator (cancel with no pending pull) settles as a failure", async () => {
    vi.useFakeTimers();
    try {
      const { events, model } = harness();
      const controller = new AbortController();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        abortSignal: controller.signal,
      } as never);
      const reader = (stream as ReadableStream<unknown>).getReader();
      await vi.advanceTimersByTimeAsync(0);
      // The generator sits suspended at a yielded part (stream-start was
      // pulled into the queue; no read is pending). The caller aborts, then
      // the consumer cancels — cancel() runs gen.return(), which executes
      // the wrapper's finally WITHOUT any catch. The settle must still be
      // failure-shaped: the abort initiated the termination.
      controller.abort();
      await reader.cancel();
      await vi.advanceTimersByTimeAsync(0);

      const settle = events.find((e) => e.type === "segment:settle") as Extract<
        CoderTransportEvent,
        { type: "segment:settle" }
      >;
      expect(settle).toBeDefined();
      expect(settle.error?.name).toBe("AbortError");
      expect(settle.status).toBeUndefined();
      expect(settle.finishReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestTimeoutMs expiry on a suspended generator (cancel with no pending pull) settles as a timeout", async () => {
    // Real timers: AbortSignal.timeout is not under vitest's fake-timer control.
    const { events, model, sockets, fetchCalls } = harness({ requestTimeoutMs: 100 });
    const { stream } = await model.doStream(newTurnOptions());
    const reader = (stream as ReadableStream<unknown>).getReader();
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await reader.read(); // stream-start
    const second = reader.read(); // drives the REST phase, the dial, and the first stream read
    await tick();
    sockets[0]?.emit("message", streamFrame(status("running"), delta(1, 1, "Hel")));
    // text-start arrives; the generator now sits suspended yielding text-delta.
    expect(await second).toMatchObject({ value: { type: "text-start" } });
    // The internal requestTimeoutMs budget expires with NO pull pending: it
    // interrupts the server run, but no read observes the rejection.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(fetchCalls.some((c) => c.includes("/interrupt"))).toBe(true);
    // The consumer then cancels — gen.return() runs the wrapper's finally
    // without any catch. The settle must name the TIMEOUT as the termination
    // source (issue #73), not pass as a consumer teardown.
    await reader.cancel();
    const settle = events.find((e) => e.type === "segment:settle") as Extract<
      CoderTransportEvent,
      { type: "segment:settle" }
    >;
    expect(settle).toBeDefined();
    expect(settle.error).toMatchObject({
      name: "CoderChatError",
      message: expect.stringContaining("requestTimeoutMs") as unknown,
    });
    expect(settle.status).toBeUndefined();
    expect(settle.finishReason).toBeUndefined();
  });

  it("an aborted segment settles with the abort error", async () => {
    vi.useFakeTimers();
    try {
      const { events, model, sockets } = harness();
      const controller = new AbortController();
      const s = collect(
        (
          await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            abortSignal: controller.signal,
          } as never)
        ).stream,
      );
      // Handler attached up-front: the rejection lands while timers advance.
      const err = s.done.then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await err).toMatchObject({ name: "AbortError" });

      const settle = events.find((e) => e.type === "segment:settle") as Extract<
        CoderTransportEvent,
        { type: "segment:settle" }
      >;
      expect(settle.error).toBeDefined();
      expect(settle.status).toBeUndefined();
      // The aborted segment closed the shared stream: its dial got a close.
      expect(events.filter((e) => e.type === "ws:close")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
