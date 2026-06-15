import { describe, it, expect } from 'vitest';
import {
  sliceLines,
  normalizeEncoding,
  resolveRemotePath,
  type FileIoContext,
} from '../src/file-io.js';
import type { CoderTransport } from '../src/transport.js';

const ctx: FileIoContext = {
  transport: {} as CoderTransport,
  workspace: 'ws',
  defaultWorkingDirectory: '/home/coder',
};

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
  it('maps UTF-16LE to utf16le', () =>
    expect(normalizeEncoding('UTF-16LE')).toBe('utf16le'));
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
