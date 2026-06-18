import { describe, expect, it } from 'vitest';
import {
  type FileIoContext,
  normalizeEncoding,
  readBinaryFile,
  readTextFile,
  resolveRemotePath,
  sliceLines,
  writeBinaryFile,
  writeTextFile,
} from '../src/file-io.js';
import type {
  CoderTransport,
  ExecResult,
  ForwardPortOptions,
  LifecycleOptions,
  PortForward,
  PresetInfo,
  SpawnedProcess,
  TransportExecOptions,
  WorkspaceStatus,
} from '../src/transport.js';

const ctx: FileIoContext = {
  transport: {} as CoderTransport,
  workspace: 'ws',
  defaultWorkingDirectory: '/home/coder',
};

/** A transport whose `exec` returns a fixed, scripted result. */
class StubTransport implements CoderTransport {
  lastExec?: TransportExecOptions;
  constructor(private readonly result: ExecResult) {}
  async exec(options: TransportExecOptions): Promise<ExecResult> {
    this.lastExec = options;
    return this.result;
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error('not used');
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    throw new Error('not used');
  }
  async start(_workspace: string, _options?: LifecycleOptions): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async status(): Promise<WorkspaceStatus | null> {
    return null;
  }
  async create(): Promise<void> {}
  async listPresets(): Promise<PresetInfo[]> {
    return [];
  }
}

function ctxWith(result: ExecResult): FileIoContext {
  return {
    transport: new StubTransport(result),
    workspace: 'ws',
    defaultWorkingDirectory: '/home/coder',
  };
}

describe('sliceLines', () => {
  const text = 'a\nb\nc\nd';
  it('applies a 1-based inclusive range', () => {
    expect(sliceLines(text, 2, 3)).toBe('b\nc');
  });
  it('supports a start line only', () => {
    expect(sliceLines(text, 3)).toBe('c\nd');
  });
  it('tolerates an end line past EOF', () => {
    expect(sliceLines(text, 1, 99)).toBe(text);
  });
  it('returns the whole text with no bounds', () => {
    expect(sliceLines(text)).toBe(text);
  });
  it('clamps a start line below 1', () => {
    expect(sliceLines(text, 0)).toBe(text);
  });
});

describe('normalizeEncoding', () => {
  it('maps utf-8 to utf8', () => expect(normalizeEncoding('utf-8')).toBe('utf8'));
  it('defaults undefined to utf8', () => expect(normalizeEncoding()).toBe('utf8'));
  it('maps UTF-16LE to utf16le', () => expect(normalizeEncoding('UTF-16LE')).toBe('utf16le'));
  it('falls back to utf8 for unknown encodings', () =>
    expect(normalizeEncoding('shift-jis')).toBe('utf8'));
});

describe('resolveRemotePath', () => {
  it('keeps absolute paths', () => {
    expect(resolveRemotePath(ctx, '/etc/hosts')).toBe('/etc/hosts');
  });
  it('joins relative paths under the default working directory', () => {
    expect(resolveRemotePath(ctx, 'sub/file.txt')).toBe('/home/coder/sub/file.txt');
  });
});

describe('readBinaryFile error paths', () => {
  it('returns null when the remote signals a missing file (exit 66)', async () => {
    const read = await readBinaryFile(ctxWith({ exitCode: 66, stdout: '', stderr: '' }), {
      path: '/etc/missing',
    });
    expect(read).toBeNull();
  });

  it('throws on a non-zero, non-66 exit code', async () => {
    await expect(
      readBinaryFile(ctxWith({ exitCode: 1, stdout: '', stderr: 'permission denied' }), {
        path: '/etc/shadow',
      }),
    ).rejects.toThrow(/failed to read .*\(exit 1\): permission denied/);
  });

  it('readTextFile also returns null on exit 66', async () => {
    const read = await readTextFile(ctxWith({ exitCode: 66, stdout: '', stderr: '' }), {
      path: '/etc/missing',
    });
    expect(read).toBeNull();
  });

  it('readTextFile surfaces a non-zero exit as a read failure', async () => {
    await expect(
      readTextFile(ctxWith({ exitCode: 2, stdout: '', stderr: 'boom' }), { path: '/x' }),
    ).rejects.toThrow(/failed to read .*\(exit 2\)/);
  });
});

describe('writeBinaryFile error paths', () => {
  it('throws on a non-zero exit code', async () => {
    await expect(
      writeBinaryFile(ctxWith({ exitCode: 1, stdout: '', stderr: 'no space left' }), {
        path: '/full/disk',
        content: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/failed to write .*\(exit 1\): no space left/);
  });

  it('writeTextFile surfaces a non-zero exit as a write failure', async () => {
    await expect(
      writeTextFile(ctxWith({ exitCode: 13, stdout: '', stderr: 'denied' }), {
        path: '/ro/file',
        content: 'hi',
      }),
    ).rejects.toThrow(/failed to write .*\(exit 13\)/);
  });

  it('resolves on a zero exit code', async () => {
    await expect(
      writeBinaryFile(ctxWith({ exitCode: 0, stdout: '', stderr: '' }), {
        path: '/ok',
        content: new Uint8Array([1]),
      }),
    ).resolves.toBeUndefined();
  });
});
