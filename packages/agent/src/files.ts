import type { LanguageModelV3DataContent } from "@ai-sdk/provider";
import { CoderAgentError } from "./errors.js";

/**
 * Bytes to upload, in any convenient shape.
 *
 * `Blob`/`File` is the recommended form: it is lazy (not forced fully into
 * memory), carries its own size (so the 10 MiB chat cap can fail fast and a
 * `Content-Length` can be sent), is re-readable (so a failed upload can be
 * retried), and works both in Node (`fs.openAsBlob("./x.pdf")`) and the browser
 * (an `<input type=file>` yields a `File`). A `ReadableStream` is accepted for
 * genuinely unbounded sources, but its size is unknown up front — the chat size
 * cap can then only be enforced server-side.
 */
export type FileContent = Blob | ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer;

/** A {@link FileContent} normalized for upload: a fetch-ready body plus derived metadata. */
export interface ResolvedFile {
  /**
   * Body to hand to `fetch`. Raw bytes are wrapped in a `Blob` so the body is
   * always a clean `BodyInit` (and bytes get a `Content-Length` for free).
   */
  body: Blob | ReadableStream<Uint8Array>;
  /** Resolved IANA media type. */
  mediaType: string;
  /** Original filename, if known. */
  name: string | undefined;
  /** Byte length, if known up front (undefined for streams). */
  size: number | undefined;
}

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== "undefined" && v instanceof Blob;
}
function isReadableStream(v: unknown): v is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && v instanceof ReadableStream;
}

/**
 * Normalize {@link FileContent} into a fetch-ready body and derive its media
 * type, name, and (when known) size. `Blob`/`File` supply their own
 * `type`/`name`/`size`; for raw bytes or a stream, `mediaType` must be provided
 * by the caller. Explicit `opts.mediaType`/`opts.name` always win.
 */
export function resolveFileContent(
  content: FileContent,
  opts?: { mediaType?: string; name?: string },
): ResolvedFile {
  let mediaType = opts?.mediaType;
  let name = opts?.name;
  let body: ResolvedFile["body"];
  let size: number | undefined;

  if (isBlob(content)) {
    body = content;
    size = content.size;
    if (!mediaType && content.type) mediaType = content.type;
    // `File` extends `Blob` with a `name`; read it structurally so we don't
    // depend on the `File` global type existing.
    const maybeName = (content as { name?: unknown }).name;
    if (!name && typeof maybeName === "string") name = maybeName;
  } else if (isReadableStream(content)) {
    body = content;
    size = undefined;
  } else if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
    size = content.byteLength;
    body = new Blob([content as BlobPart]);
  } else {
    throw new CoderAgentError(
      "Unsupported file content: expected a Blob/File, ReadableStream, Uint8Array, or ArrayBuffer.",
    );
  }

  if (!mediaType) {
    throw new CoderAgentError(
      "Could not determine the file's media type. Pass `mediaType`, or provide a Blob/File that carries its own `type`.",
    );
  }

  return { body, mediaType, name, size };
}

/** Decode a base64 string to bytes (Node `Buffer` or browser `atob`). */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Convert an AI SDK file-part `data` value into {@link FileContent} for upload.
 * The provider receives bytes or a base64 string (and, rarely, a URL). URLs are
 * not expected: this model declares no `supportedUrls`, so the SDK downloads
 * them to bytes before calling us — a URL here is therefore an error.
 */
export function dataContentToFileContent(data: LanguageModelV3DataContent): FileContent {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return base64ToBytes(data);
  throw new CoderAgentError(
    "File parts referencing a URL are not supported; provide the file bytes instead.",
  );
}
