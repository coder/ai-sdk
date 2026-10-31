import path from "node:path";
import { shellQuote } from "./shell.js";
import type { CoderTransport } from "./transport.js";

/**
 * File I/O for {@link CoderWorkspaceSession}, implemented over the
 * transport's `exec`. Binary payloads cross the transport boundary as base64 to
 * stay byte-clean regardless of PTY/encoding behavior: reads run
 * `base64 < <file>` remotely and decode on the host; writes pipe host-encoded
 * base64 to a remote `base64 -d > <file>`.
 */
export interface FileIoContext {
  transport: CoderTransport;
  workspace: string;
  /** Base directory that relative paths resolve against. */
  defaultWorkingDirectory: string;
}

/** Exit code the remote uses to signal "file does not exist" (vs. a real error). */
const MISSING_FILE_EXIT = 66;

export interface ReadFileOptions {
  path: string;
  abortSignal?: AbortSignal;
}

export interface ReadTextFileOptions extends ReadFileOptions {
  encoding?: string;
  startLine?: number;
  endLine?: number;
}

export interface WriteFileOptions<CONTENT> {
  path: string;
  content: CONTENT;
  abortSignal?: AbortSignal;
}

export interface WriteTextFileOptions extends WriteFileOptions<string> {
  encoding?: string;
}

/** Resolve a (possibly relative) sandbox path against the default working dir. */
export function resolveRemotePath(ctx: FileIoContext, p: string): string {
  return p.startsWith("/") ? p : path.posix.join(ctx.defaultWorkingDirectory, p);
}

export async function readBinaryFile(
  ctx: FileIoContext,
  options: ReadFileOptions,
): Promise<Uint8Array | null> {
  const abs = resolveRemotePath(ctx, options.path);
  const quoted = shellQuote(abs);
  // `base64 < file` (stdin redirect) is portable across GNU and BSD coreutils;
  // a positional filename arg is rejected by BSD base64.
  const command = `if [ -f ${quoted} ]; then base64 < ${quoted}; else exit ${MISSING_FILE_EXIT}; fi`;
  const result = await ctx.transport.exec({
    workspace: ctx.workspace,
    command,
    abortSignal: options.abortSignal,
  });
  if (result.exitCode === MISSING_FILE_EXIT) return null;
  if (result.exitCode !== 0) {
    throw new Error(`failed to read ${abs} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  const base64 = result.stdout.replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export async function readFile(
  ctx: FileIoContext,
  options: ReadFileOptions,
): Promise<ReadableStream<Uint8Array> | null> {
  const bytes = await readBinaryFile(ctx, options);
  if (bytes === null) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function readTextFile(
  ctx: FileIoContext,
  options: ReadTextFileOptions,
): Promise<string | null> {
  const bytes = await readBinaryFile(ctx, {
    path: options.path,
    abortSignal: options.abortSignal,
  });
  if (bytes === null) return null;
  const text = Buffer.from(bytes).toString(normalizeEncoding(options.encoding));
  if (options.startLine === undefined && options.endLine === undefined) {
    return text;
  }
  return sliceLines(text, options.startLine, options.endLine);
}

export async function writeBinaryFile(
  ctx: FileIoContext,
  options: WriteFileOptions<Uint8Array>,
): Promise<void> {
  const abs = resolveRemotePath(ctx, options.path);
  const dir = path.posix.dirname(abs);
  const command = `mkdir -p ${shellQuote(dir)} && base64 -d > ${shellQuote(abs)}`;
  const base64 = Buffer.from(options.content).toString("base64");
  const result = await ctx.transport.exec({
    workspace: ctx.workspace,
    command,
    stdin: base64,
    abortSignal: options.abortSignal,
  });
  if (result.exitCode !== 0) {
    throw new Error(`failed to write ${abs} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

export async function writeFile(
  ctx: FileIoContext,
  options: WriteFileOptions<ReadableStream<Uint8Array>>,
): Promise<void> {
  const bytes = await collectStream(options.content);
  await writeBinaryFile(ctx, {
    path: options.path,
    content: bytes,
    abortSignal: options.abortSignal,
  });
}

export async function writeTextFile(
  ctx: FileIoContext,
  options: WriteTextFileOptions,
): Promise<void> {
  const bytes = new Uint8Array(Buffer.from(options.content, normalizeEncoding(options.encoding)));
  await writeBinaryFile(ctx, {
    path: options.path,
    content: bytes,
    abortSignal: options.abortSignal,
  });
}

export interface FileStat {
  type: "file" | "directory" | "other";
  size: number;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

/** Exit code the remote uses to signal "is a directory" (delete) or "not a directory" (list). */
const WRONG_TYPE_EXIT = 67;

/**
 * Stat a path, following symbolic links. Resolves to `null` when the path does
 * not exist (a dangling symlink counts as missing). Only regular files report
 * a byte size; directories and other types report 0.
 */
export async function stat(ctx: FileIoContext, options: ReadFileOptions): Promise<FileStat | null> {
  const abs = resolveRemotePath(ctx, options.path);
  const quoted = shellQuote(abs);
  const command =
    `if [ -f ${quoted} ]; then printf 'file '; wc -c < ${quoted}; ` +
    `elif [ -d ${quoted} ]; then echo 'directory 0'; ` +
    `elif [ -e ${quoted} ]; then echo 'other 0'; ` +
    `else exit ${MISSING_FILE_EXIT}; fi`;
  const result = await ctx.transport.exec({
    workspace: ctx.workspace,
    command,
    abortSignal: options.abortSignal,
  });
  if (result.exitCode === MISSING_FILE_EXIT) return null;
  if (result.exitCode !== 0) {
    throw new Error(`failed to stat ${abs} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  const match = /^(file|directory|other) +(\d+)\s*$/.exec(result.stdout.trim());
  if (match === null) {
    throw new Error(`failed to stat ${abs}: unexpected output ${JSON.stringify(result.stdout)}`);
  }
  const type = parseEntryType(match[1]);
  if (type === undefined || type === "symlink") {
    throw new Error(`failed to stat ${abs}: unexpected type ${JSON.stringify(match[1])}`);
  }
  return { type, size: Number(match[2]) };
}

function parseEntryType(value: string | undefined): DirectoryEntry["type"] | undefined {
  switch (value) {
    case "file":
    case "directory":
    case "symlink":
    case "other":
      return value;
    default:
      return undefined;
  }
}

/**
 * List one directory without descending. Resolves to `null` when the path
 * does not exist and rejects when it is not a directory. Entry names cross the
 * transport as NUL-separated base64, so newlines and spaces in names survive.
 */
export async function listDirectory(
  ctx: FileIoContext,
  options: ReadFileOptions,
): Promise<DirectoryEntry[] | null> {
  const abs = resolveRemotePath(ctx, options.path);
  const quoted = shellQuote(abs);
  // `-L` comes first so symlinks are reported as such and not followed.
  const listing =
    `for e in * .*; do ` +
    `[ "$e" = . ] || [ "$e" = .. ] && continue; ` +
    `if [ -L "$e" ]; then t=symlink; elif [ -d "$e" ]; then t=directory; ` +
    `elif [ -f "$e" ]; then t=file; elif [ -e "$e" ]; then t=other; else continue; fi; ` +
    `printf '%s\\0%s\\0' "$t" "$e"; done`;
  const command =
    `if [ -d ${quoted} ]; then cd ${quoted} && { ${listing}; } | base64; ` +
    `elif [ -e ${quoted} ]; then exit ${WRONG_TYPE_EXIT}; ` +
    `else exit ${MISSING_FILE_EXIT}; fi`;
  const result = await ctx.transport.exec({
    workspace: ctx.workspace,
    command,
    abortSignal: options.abortSignal,
  });
  if (result.exitCode === MISSING_FILE_EXIT) return null;
  if (result.exitCode === WRONG_TYPE_EXIT) {
    throw new Error(`failed to list ${abs}: not a directory`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`failed to list ${abs} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  const fields = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64")
    .toString("utf8")
    .split("\0");
  // The listing ends with a NUL, so a well-formed split has an odd length.
  if (fields.pop() !== "" || fields.length % 2 !== 0) {
    throw new Error(`failed to list ${abs}: malformed listing`);
  }
  const entries: DirectoryEntry[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const type = parseEntryType(fields[i]);
    const name = fields[i + 1];
    if (type === undefined || name === undefined || name === "") {
      throw new Error(`failed to list ${abs}: malformed listing`);
    }
    entries.push({ name, type });
  }
  return entries;
}

/**
 * Delete one file. A symbolic link is deleted itself, not its target. Resolves
 * to `false` when nothing exists at the path and rejects for a directory.
 */
export async function deleteFile(ctx: FileIoContext, options: ReadFileOptions): Promise<boolean> {
  const abs = resolveRemotePath(ctx, options.path);
  const quoted = shellQuote(abs);
  const command =
    `if [ -L ${quoted} ]; then rm -f -- ${quoted}; ` +
    `elif [ -d ${quoted} ]; then exit ${WRONG_TYPE_EXIT}; ` +
    `elif [ -e ${quoted} ]; then rm -f -- ${quoted}; ` +
    `else exit ${MISSING_FILE_EXIT}; fi`;
  const result = await ctx.transport.exec({
    workspace: ctx.workspace,
    command,
    abortSignal: options.abortSignal,
  });
  if (result.exitCode === MISSING_FILE_EXIT) return false;
  if (result.exitCode === WRONG_TYPE_EXIT) {
    throw new Error(`failed to delete ${abs}: is a directory`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`failed to delete ${abs} (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return true;
}

/** Slice text to a 1-based inclusive line range; tolerant of out-of-range bounds. */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, startLine ?? 1) - 1;
  const end = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
  return lines.slice(start, end).join("\n");
}

/** Map common encoding labels to Node's `BufferEncoding`; defaults to utf-8. */
export function normalizeEncoding(encoding?: string): BufferEncoding {
  if (encoding === undefined) return "utf8";
  const normalized = encoding.toLowerCase().replace(/[-_]/g, "");
  switch (normalized) {
    case "utf8":
    case "utf":
      return "utf8";
    case "utf16le":
    case "ucs2":
      return "utf16le";
    case "latin1":
    case "binary":
    case "iso88591":
      return "latin1";
    case "ascii":
      return "ascii";
    case "base64":
      return "base64";
    case "hex":
      return "hex";
    default:
      return "utf8";
  }
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
