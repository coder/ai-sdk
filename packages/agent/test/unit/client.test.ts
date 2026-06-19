import { describe, expect, it } from "vitest";
import { CoderChatClient } from "../../src/coder/client.js";
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
