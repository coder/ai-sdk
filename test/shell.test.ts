import { describe, it, expect } from 'vitest';
import { shellQuote, buildRemoteScript } from '../src/shell.js';

describe('shellQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('abc')).toBe("'abc'");
  });
  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it('handles paths and spaces', () => {
    expect(shellQuote('/home/coder/my dir')).toBe("'/home/coder/my dir'");
  });
});

describe('buildRemoteScript', () => {
  it('passes a bare command through unchanged', () => {
    expect(buildRemoteScript({ command: 'echo hi' })).toBe('echo hi');
  });
  it('prepends a cd for the working directory', () => {
    expect(buildRemoteScript({ command: 'pwd', workingDirectory: '/work' })).toBe(
      "cd '/work' && pwd",
    );
  });
  it('wraps in env + bash -c when env is present', () => {
    expect(buildRemoteScript({ command: 'echo $A', env: { A: '1' } })).toBe(
      "env A='1' bash -c 'echo $A'",
    );
  });
  it('combines working directory and env', () => {
    expect(
      buildRemoteScript({
        command: 'run.sh',
        workingDirectory: '/w',
        env: { A: '1', B: 'two words' },
      }),
    ).toBe("cd '/w' && env A='1' B='two words' bash -c 'run.sh'");
  });
  it('treats an empty working directory as absent', () => {
    expect(buildRemoteScript({ command: 'x', workingDirectory: '' })).toBe('x');
  });
});
