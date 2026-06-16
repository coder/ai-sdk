import path from 'node:path';
import { shellQuote } from './shell.js';
import type { CoderTransport } from './transport.js';

/**
 * File I/O for {@link CoderWorkspaceSession}, implemented over the
 * transport's `exec`. Binary payloads cross the `coder ssh` boundary as base64
 * to stay byte-clean regardless of PTY/encoding behavior: reads run `base64
 * <file>` remotely and decode on the host; writes pipe host-encoded base64 to a
 * remote `base64 -d > <file>`.
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
  return p.startsWith('/') ? p : path.posix.join(ctx.defaultWorkingDirectory, p);
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
  const base64 = result.stdout.replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(base64, 'base64'));
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
  const base64 = Buffer.from(options.content).toString('base64');
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

/** Slice text to a 1-based inclusive line range; tolerant of out-of-range bounds. */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  const lines = text.split('\n');
  const start = Math.max(1, startLine ?? 1) - 1;
  const end = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
  return lines.slice(start, end).join('\n');
}

/** Map common encoding labels to Node's `BufferEncoding`; defaults to utf-8. */
export function normalizeEncoding(encoding?: string): BufferEncoding {
  if (encoding === undefined) return 'utf8';
  const normalized = encoding.toLowerCase().replace(/[-_]/g, '');
  switch (normalized) {
    case 'utf8':
    case 'utf':
      return 'utf8';
    case 'utf16le':
    case 'ucs2':
      return 'utf16le';
    case 'latin1':
    case 'binary':
    case 'iso88591':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    case 'base64':
      return 'base64';
    case 'hex':
      return 'hex';
    default:
      return 'utf8';
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
