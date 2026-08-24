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
function harness(config?: { hook?: TransportEventHandler; withoutHook?: boolean }) {
  const events: CoderTransportEvent[] = [];
  const onTransportEvent = config?.withoutHook
    ? undefined
    : (config?.hook ?? ((ev: CoderTransportEvent) => void events.push(ev)));
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
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
  const model = new CoderLanguageModel({ client, organizationId: "org-1", onTransportEvent });
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
