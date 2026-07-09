import { describe, expect, it, vi } from "vitest";
import { CoderChatClient } from "../../src/coder/client.js";
import type { WebSocketFactory, WebSocketLike } from "../../src/coder/ws.js";
import { CoderAgentError, CoderApiError } from "../../src/errors.js";

type Init = RequestInit & { headers: Record<string, string> };

/** A fake `fetch` that records calls and returns a scripted `Response`. */
function fakeFetch(handler: () => Response) {
  const calls: { url: string; init: Init }[] = [];
  const fn = ((url: string, init: Init) => {
    calls.push({ url, init });
    return Promise.resolve(handler());
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

function client(fetchFn: typeof globalThis.fetch) {
  return new CoderChatClient({ baseUrl: "https://x", token: "t", fetch: fetchFn });
}

describe("CoderChatClient.uploadChatFile", () => {
  it("uploads bytes to the org-scoped endpoint and returns the id", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: "file-1" }), { status: 201 }),
    );
    const r = await client(fn).uploadChatFile("org-1", {
      content: new Uint8Array([1, 2, 3]),
      mediaType: "application/pdf",
      name: "report.pdf",
    });

    expect(r).toEqual({ id: "file-1", mediaType: "application/pdf", name: "report.pdf" });
    expect(calls[0]?.url).toBe("https://x/api/experimental/chats/files?organization=org-1");
    expect(calls[0]?.init.headers["Content-Type"]).toBe("application/pdf");
    expect(calls[0]?.init.headers["Content-Disposition"]).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
  });

  it("normalizes a parameterized media type for the allowlist check and the header", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: "f" }), { status: 201 }),
    );
    const r = await client(fn).uploadChatFile("o", {
      content: new Uint8Array([1]),
      mediaType: "text/plain; charset=utf-8",
    });

    expect(r.mediaType).toBe("text/plain");
    expect(calls[0]?.init.headers["Content-Type"]).toBe("text/plain");
  });

  it("sanitizes the ASCII filename (escapes quotes, drops CR/LF) and adds filename*", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: "f" }), { status: 201 }),
    );
    await client(fn).uploadChatFile("o", {
      content: new Uint8Array([1]),
      mediaType: "text/plain",
      name: 'he"llo\r\nworld',
    });

    const cd = calls[0]?.init.headers["Content-Disposition"] ?? "";
    // CR/LF → "_" in the ASCII fallback, quote escaped; exact name preserved in filename*.
    expect(cd).toBe(
      'attachment; filename="he\\"llo__world"; filename*=UTF-8\'\'he%22llo%0D%0Aworld',
    );
    expect(cd).not.toMatch(/[\r\n]/);
  });

  it("encodes a non-ASCII filename instead of throwing a ByteString error", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: "f" }), { status: 201 }),
    );
    await client(fn).uploadChatFile("o", {
      content: new Uint8Array([1]),
      mediaType: "application/pdf",
      name: "報告書.pdf",
    });

    const cd = calls[0]?.init.headers["Content-Disposition"] ?? "";
    // Pure ASCII header value (no code point > 0x7f) so fetch can't reject it.
    expect([...cd].every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
    expect(cd).toContain("filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.pdf");
  });

  it("throws when a 2xx response carries no file id (instead of returning an empty id)", async () => {
    const { fn } = fakeFetch(() => new Response("", { status: 201 }));
    await expect(
      client(fn).uploadChatFile("o", { content: new Uint8Array([1]), mediaType: "text/plain" }),
    ).rejects.toThrow(/no file id/);
  });

  it("rejects a non-allowlisted media type before issuing any request", async () => {
    let called = false;
    const { fn } = fakeFetch(() => {
      called = true;
      return new Response("{}", { status: 201 });
    });
    await expect(
      client(fn).uploadChatFile("o", {
        content: new Uint8Array([1]),
        mediaType: "application/zip",
      }),
    ).rejects.toThrow(CoderAgentError);
    expect(called).toBe(false);
  });

  it("surfaces a non-2xx upload as a CoderApiError", async () => {
    const { fn } = fakeFetch(
      () => new Response(JSON.stringify({ message: "too big" }), { status: 413 }),
    );
    await expect(
      client(fn).uploadChatFile("o", { content: new Uint8Array([1]), mediaType: "text/plain" }),
    ).rejects.toThrow(CoderApiError);
  });
});

describe("CoderChatClient.resolveModelConfigId", () => {
  const HAIKU = {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    enabled: true,
  };
  const GPT = {
    id: "22222222-2222-4222-8222-222222222222",
    provider: "openai",
    model: "gpt-5",
    display_name: "GPT-5",
    enabled: true,
  };

  /** A client whose `/model-configs` endpoint returns `body` (undefined → empty body). */
  function resolver(body: unknown) {
    const { fn, calls } = fakeFetch(
      () => new Response(body === undefined ? "" : JSON.stringify(body), { status: 200 }),
    );
    return { client: client(fn), calls };
  }

  it("returns a UUID hint as-is without fetching configs", async () => {
    const { client: c, calls } = resolver([]);
    const uuid = "33333333-3333-4333-8333-333333333333";
    await expect(c.resolveModelConfigId(uuid)).resolves.toBe(uuid);
    expect(calls).toHaveLength(0);
  });

  it("matches provider:model, bare model, display-name and model substrings", async () => {
    const { client: c } = resolver([GPT, HAIKU]);
    await expect(c.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(HAIKU.id);
    await expect(c.resolveModelConfigId("claude-haiku-4-5")).resolves.toBe(HAIKU.id);
    await expect(c.resolveModelConfigId("Haiku")).resolves.toBe(HAIKU.id);
    await expect(c.resolveModelConfigId("haiku-4")).resolves.toBe(HAIKU.id);
  });

  it("prefers enabled configs, falls back to disabled-only listings, and returns undefined on no match", async () => {
    const { client: c } = resolver([{ ...GPT, enabled: false }, HAIKU]);
    // GPT is disabled and an enabled config exists, so it is out of the pool.
    await expect(c.resolveModelConfigId("gpt-5")).resolves.toBeUndefined();
    await expect(c.resolveModelConfigId("no-such-model")).resolves.toBeUndefined();

    const { client: allDisabled } = resolver([{ ...HAIKU, enabled: false }]);
    await expect(allDisabled.resolveModelConfigId("claude-haiku-4-5")).resolves.toBe(HAIKU.id);
  });

  it("resolves an entry missing `provider` by its model id on a provider:model hint", async () => {
    const { client: c } = resolver([
      { id: HAIKU.id, model: "claude-haiku-4-5", display_name: "Haiku (BYOK)" },
    ]);
    await expect(c.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(HAIKU.id);
  });

  it("keeps matching entries with an empty-string provider", async () => {
    const { client: c } = resolver([{ ...HAIKU, provider: "" }]);
    await expect(c.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(HAIKU.id);
  });

  it("tolerates provider: null", async () => {
    const { client: c } = resolver([{ ...HAIKU, provider: null }]);
    await expect(c.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(HAIKU.id);
  });

  it("tolerates an entry missing `display_name` when scanning for a display match", async () => {
    const { client: c } = resolver([{ id: "no-display", provider: "x", model: "m1" }, GPT]);
    await expect(c.resolveModelConfigId("gpt")).resolves.toBe(GPT.id);
  });

  it("never matches an entry missing `model` by model, but still by display name", async () => {
    const { client: c } = resolver([
      { id: HAIKU.id, provider: "anthropic", display_name: "Claude Haiku 4.5" },
    ]);
    await expect(c.resolveModelConfigId("claude-haiku-4-5")).resolves.toBeUndefined();
    await expect(c.resolveModelConfigId("haiku")).resolves.toBe(HAIKU.id);
  });

  it("skips null entries in the listing", async () => {
    const { client: c } = resolver([null, HAIKU]);
    await expect(c.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(HAIKU.id);
  });

  it("returns undefined for an empty response body", async () => {
    const { client: c } = resolver(undefined);
    await expect(c.resolveModelConfigId("claude-haiku-4-5")).resolves.toBeUndefined();
  });

  it("returns undefined for a non-array JSON body", async () => {
    const { client: c } = resolver({});
    await expect(c.resolveModelConfigId("claude-haiku-4-5")).resolves.toBeUndefined();
  });

  it("resolves a healthy exact match regardless of a malformed neighbor's position", async () => {
    const malformed = { id: "bad" };
    const { client: healthyFirst } = resolver([HAIKU, malformed]);
    await expect(healthyFirst.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(
      HAIKU.id,
    );
    const { client: malformedFirst } = resolver([malformed, HAIKU]);
    await expect(malformedFirst.resolveModelConfigId("anthropic:claude-haiku-4-5")).resolves.toBe(
      HAIKU.id,
    );
  });
});

describe("CoderChatClient.interruptChat", () => {
  const chatJson = () => JSON.stringify({ id: "c1", status: "interrupting" });

  it("POSTs without a query by default", async () => {
    const { fn, calls } = fakeFetch(() => new Response(chatJson(), { status: 200 }));
    await client(fn).interruptChat("c1");
    expect(calls[0]?.url).toBe("https://x/api/experimental/chats/c1/interrupt");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("adds ?wait=true when wait is requested", async () => {
    const { fn, calls } = fakeFetch(() => new Response(chatJson(), { status: 200 }));
    await client(fn).interruptChat("c1", { wait: true });
    expect(calls[0]?.url).toBe("https://x/api/experimental/chats/c1/interrupt?wait=true");
  });

  it("omits the query for wait: false", async () => {
    const { fn, calls } = fakeFetch(() => new Response(chatJson(), { status: 200 }));
    await client(fn).interruptChat("c1", { wait: false });
    expect(calls[0]?.url).toBe("https://x/api/experimental/chats/c1/interrupt");
  });

  it("still accepts a positional AbortSignal (back-compat)", async () => {
    const ac = new AbortController();
    const { fn, calls } = fakeFetch(() => new Response(chatJson(), { status: 200 }));
    await client(fn).interruptChat("c1", ac.signal);
    expect(calls[0]?.url).toBe("https://x/api/experimental/chats/c1/interrupt");
    expect(calls[0]?.init.signal).toBe(ac.signal);
  });

  it("forwards the signal from the options form alongside wait", async () => {
    const ac = new AbortController();
    const { fn, calls } = fakeFetch(() => new Response(chatJson(), { status: 200 }));
    await client(fn).interruptChat("c1", { wait: true, signal: ac.signal });
    expect(calls[0]?.url).toMatch(/\?wait=true$/);
    expect(calls[0]?.init.signal).toBe(ac.signal);
  });
});

type WatchListener = (ev: unknown) => void;

/** A scripted WebSocket: tests emit server events; client-initiated closes are recorded. */
class FakeWatchSocket {
  readonly url: string;
  readonly headers: Record<string, string>;
  closedWith: number[] = [];
  #listeners = new Map<string, Set<WatchListener>>();

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  send(_data: string): void {}
  close(code?: number): void {
    this.closedWith.push(code ?? 0);
  }
  addEventListener(type: string, cb: WatchListener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: WatchListener): void {
    this.#listeners.get(type)?.delete(cb);
  }
  emit(type: "message" | "error" | "close", ev?: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(ev);
  }
}

describe("CoderChatClient.watchChats", () => {
  function watchClient() {
    const sockets: FakeWatchSocket[] = [];
    const factory: WebSocketFactory = (url, { headers }) => {
      const s = new FakeWatchSocket(url, headers);
      sockets.push(s);
      return s as WebSocketLike;
    };
    const c = new CoderChatClient({ baseUrl: "https://x", token: "t", webSocketFactory: factory });
    return { c, sockets };
  }

  const chat = (id: string) => ({
    id,
    organization_id: "o",
    owner_id: "u",
    title: "t",
    status: "waiting",
    created_at: "",
    updated_at: "",
    archived: false,
  });
  const frame = (kind: string, chatId: string) => ({
    data: JSON.stringify({ kind, chat: chat(chatId) }),
  });

  /** Let the generator run to its next suspension point (real timers). */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("dials /chats/watch with header auth and yields decoded events", async () => {
    const { c, sockets } = watchClient();
    const iter = c.watchChats();
    const p1 = iter.next();
    await tick();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://x/api/experimental/chats/watch");
    expect(sockets[0]?.headers["Coder-Session-Token"]).toBe("t");

    sockets[0]?.emit("message", frame("created", "c1"));
    expect((await p1).value).toMatchObject({ kind: "created", chat: { id: "c1" } });

    // Batched frames (defensive) are flattened in order.
    sockets[0]?.emit("message", {
      data: JSON.stringify([
        { kind: "status_change", chat: chat("c1") },
        { kind: "deleted", chat: chat("c2") },
      ]),
    });
    expect((await iter.next()).value).toMatchObject({ kind: "status_change" });
    expect((await iter.next()).value).toMatchObject({ kind: "deleted", chat: { id: "c2" } });

    await iter.return(undefined);
    expect(sockets[0]?.closedWith).toContain(1000);
  });

  it("reconnects after drops with exponential backoff, reset once an event arrives", async () => {
    vi.useFakeTimers();
    try {
      const { c, sockets } = watchClient();
      const ac = new AbortController();
      const iter = c.watchChats({ signal: ac.signal });

      const p1 = iter.next();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]?.emit("message", frame("created", "c1"));
      expect((await p1).value).toMatchObject({ kind: "created" });

      const p2 = iter.next();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("close", { code: 1006 });
      // First redial after the initial 1s delay…
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      // …and after a drop with no event in between, the delay doubles to 2s.
      sockets[1]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);

      // An event resets the backoff to 1s for the next drop.
      sockets[2]?.emit("message", frame("title_change", "c1"));
      expect((await p2).value).toMatchObject({ kind: "title_change" });
      const p3 = iter.next();
      await vi.advanceTimersByTimeAsync(0);
      sockets[2]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(4);

      ac.abort();
      expect((await p3).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops promptly when aborted mid-connection", async () => {
    const { c, sockets } = watchClient();
    const ac = new AbortController();
    const iter = c.watchChats({ signal: ac.signal });
    const p = iter.next();
    await tick();

    ac.abort();
    expect((await p).done).toBe(true);
    expect(sockets[0]?.closedWith).toContain(1000);
  });

  it("stops during the reconnect delay without redialing", async () => {
    vi.useFakeTimers();
    try {
      const { c, sockets } = watchClient();
      const ac = new AbortController();
      const iter = c.watchChats({ signal: ac.signal });
      const p = iter.next();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(0); // the generator is now sleeping before a redial
      ac.abort();
      // Must resolve without advancing timers — the sleep honors the abort.
      expect((await p).done).toBe(true);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dial at all on an already-aborted signal", async () => {
    const { c, sockets } = watchClient();
    const ac = new AbortController();
    ac.abort();
    expect((await c.watchChats({ signal: ac.signal }).next()).done).toBe(true);
    expect(sockets).toHaveLength(0);
  });

  it("throws a terminal CoderApiError on a 401 upgrade rejection instead of retrying", async () => {
    const { c, sockets } = watchClient();
    const iter = c.watchChats();
    const p = iter.next();
    await tick();

    sockets[0]?.emit("error", { message: "Unexpected server response: 401" });
    await expect(p).rejects.toMatchObject({
      name: "CoderApiError",
      status: 401,
      path: "/api/experimental/chats/watch",
    });
    expect(sockets).toHaveLength(1); // no reconnect after a terminal failure
  });

  it("treats a 5xx upgrade rejection as transient and redials", async () => {
    vi.useFakeTimers();
    try {
      const { c, sockets } = watchClient();
      const ac = new AbortController();
      const iter = c.watchChats({ signal: ac.signal });
      const p = iter.next();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("error", { message: "Unexpected server response: 502" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      ac.abort();
      expect((await p).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
