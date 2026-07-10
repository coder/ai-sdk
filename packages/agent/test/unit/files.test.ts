import { describe, expect, it } from "vitest";
import { CoderAgentError } from "../../src/errors.js";
import { dataContentToFileContent, resolveFileContent } from "../../src/files.js";

describe("resolveFileContent", () => {
  it("derives mediaType, name, and size from a File", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "report.pdf", { type: "application/pdf" });
    const r = resolveFileContent(file);
    expect(r.mediaType).toBe("application/pdf");
    expect(r.name).toBe("report.pdf");
    expect(r.size).toBe(3);
    expect(r.body).toBeInstanceOf(Blob);
  });

  it("derives mediaType and size from a Blob (no name)", () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const r = resolveFileContent(blob);
    expect(r.mediaType).toBe("text/plain");
    expect(r.name).toBeUndefined();
    expect(r.size).toBe(5);
  });

  it("lets explicit mediaType/name override a Blob's own", () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    const r = resolveFileContent(file, { mediaType: "text/markdown", name: "b.md" });
    expect(r.mediaType).toBe("text/markdown");
    expect(r.name).toBe("b.md");
  });

  it("wraps Uint8Array bytes in a Blob and records size", () => {
    const r = resolveFileContent(new Uint8Array([1, 2, 3, 4]), { mediaType: "application/pdf" });
    expect(r.body).toBeInstanceOf(Blob);
    expect(r.size).toBe(4);
    expect(r.mediaType).toBe("application/pdf");
  });

  it("leaves a ReadableStream as the body with unknown size", () => {
    const stream = new ReadableStream<Uint8Array>();
    const r = resolveFileContent(stream, { mediaType: "application/pdf" });
    expect(r.body).toBe(stream);
    expect(r.size).toBeUndefined();
  });

  it("requires a mediaType for raw bytes (which carry none)", () => {
    expect(() => resolveFileContent(new Uint8Array([1]))).toThrow(CoderAgentError);
  });
});

describe("dataContentToFileContent", () => {
  it("passes Uint8Array data through unchanged", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(dataContentToFileContent({ type: "data", data: bytes })).toBe(bytes);
  });

  it("decodes a base64 string to bytes", () => {
    // "hi" → base64 "aGk="
    const out = dataContentToFileContent({ type: "data", data: "aGk=" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out as Uint8Array).toString()).toBe("hi");
  });

  it("encodes inline text to UTF-8 bytes", () => {
    const out = dataContentToFileContent({ type: "text", text: "hi" });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(out as Uint8Array).toString()).toBe("hi");
  });

  it("rejects URL data (the SDK should have downloaded it first)", () => {
    expect(() =>
      dataContentToFileContent({ type: "url", url: new URL("https://example.com/x.pdf") }),
    ).toThrow(CoderAgentError);
  });

  it("rejects provider-reference data (no provider file store to resolve it)", () => {
    expect(() =>
      dataContentToFileContent({ type: "reference", reference: { openai: "file-1" } }),
    ).toThrow(CoderAgentError);
  });
});
