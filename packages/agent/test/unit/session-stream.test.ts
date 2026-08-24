import { describe, expect, it } from "vitest";
import { SessionChatStream } from "../../src/model/session-stream.js";
import type { ChatStreamEvent } from "../../src/coder/types.js";

const ev = (n: number): ChatStreamEvent => ({ type: "status", chat_id: `c${n}` });

/**
 * A push-driven stand-in for the real stream reader: yields pushed events,
 * waits while idle, and ends when the lifetime signal aborts (mirroring how
 * `streamChatEvents` settles pending reads on teardown).
 */
function channel() {
  const queue: ChatStreamEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(e: ChatStreamEvent): void {
      queue.push(e);
      wake?.();
      wake = undefined;
    },
    get ended(): boolean {
      return ended;
    },
    open(signal: AbortSignal): AsyncGenerator<ChatStreamEvent, void, void> {
      return (async function* () {
        try {
          while (!signal.aborted) {
            while (queue.length > 0) yield queue.shift() as ChatStreamEvent;
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        } finally {
          ended = true;
        }
      })();
    },
  };
}

function make() {
  const chan = channel();
  const stream = new SessionChatStream({ chatId: "chat-1", open: chan.open });
  return { chan, stream };
}

describe("SessionChatStream", () => {
  it("delivers an event that resolved while nobody was consuming (adopted read)", async () => {
    const { chan, stream } = make();
    const p1 = stream.read();
    chan.push(ev(1)); // resolves the read the "segment" abandoned
    // A later consumer adopts the SAME read and gets the event — not a fresh
    // read that would have skipped it.
    expect(stream.read()).toBe(p1);
    const r1 = await stream.read();
    expect(r1).toEqual({ done: false, value: ev(1) });
    stream.consumed(p1);
    // Only after consumption does read() issue a fresh read.
    const p2 = stream.read();
    expect(p2).not.toBe(p1);
    chan.push(ev(2));
    expect((await p2).value).toEqual(ev(2));
  });

  it("consumed() ignores a promise that is not the outstanding read", async () => {
    const { chan, stream } = make();
    const p1 = stream.read();
    stream.consumed(Promise.resolve({ done: true as const, value: undefined }));
    expect(stream.read()).toBe(p1); // unchanged
    chan.push(ev(1));
    stream.consumed(p1);
    expect(stream.read()).not.toBe(p1);
  });

  it("enforces the attach lifecycle: only a paused stream is reusable", () => {
    const { stream } = make();
    expect(stream.canAttach("chat-1")).toBe(false); // attached, not paused
    expect(() => stream.attach()).toThrow(/non-reusable/);
    stream.pause();
    expect(stream.canAttach("chat-1")).toBe(true);
    expect(stream.canAttach("other-chat")).toBe(false);
    stream.attach();
    expect(stream.canAttach("chat-1")).toBe(false); // attached again
  });

  it("a detached (aborted) stream is never reusable but stays open until close()", async () => {
    const { chan, stream } = make();
    const abandoned = stream.read(); // the aborted segment's raced-out read
    stream.detach();
    expect(stream.canAttach("chat-1")).toBe(false);
    expect(() => stream.attach()).toThrow(/non-reusable/);
    expect(chan.ended).toBe(false); // detach does NOT close the socket
    // The abandoned read survives the detach (memoized, rejection-tagged)…
    expect(stream.read()).toBe(abandoned);
    await stream.close();
    expect(chan.ended).toBe(true);
    expect((await abandoned).done).toBe(true); // …and is settled by the close
  });

  it("rejects a fresh read on a detached stream (reads belong to segments)", () => {
    const { stream } = make();
    stream.detach(); // no read outstanding
    expect(() => stream.read()).toThrow(/without an attached segment/);
  });

  it("pause() leaves a prefetched read outstanding so buffered events survive the gap", async () => {
    const { chan, stream } = make();
    stream.pause();
    chan.push(ev(7)); // arrives between segments (while the tool executes)
    stream.attach();
    const p = stream.read();
    expect((await p).value).toEqual(ev(7));
  });

  it("close() is idempotent, settles reads, and ends the reader", async () => {
    const { chan, stream } = make();
    const pending = stream.read();
    const c1 = stream.close();
    const c2 = stream.close();
    expect(c1).toBe(c2); // memoized
    await c1;
    expect(stream.closed).toBe(true);
    expect(chan.ended).toBe(true);
    expect((await pending).done).toBe(true);
    expect((await stream.read()).done).toBe(true); // reads after close are done
  });
});
