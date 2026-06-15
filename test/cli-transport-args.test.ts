import { describe, it, expect } from 'vitest';
import {
  buildSshArgs,
  buildLocalForwardArgs,
  sshHostAlias,
  type SshArgsOptions,
} from '../src/cli-transport.js';

const opts = (over: Partial<SshArgsOptions> = {}): SshArgsOptions => ({
  coderBinary: 'coder',
  loginShell: true,
  waitMode: 'no',
  silenceProxyStderr: true,
  ...over,
});

describe('buildSshArgs (OpenSSH via coder --stdio ProxyCommand)', () => {
  it('builds a ProxyCommand-based OpenSSH invocation', () => {
    const args = buildSshArgs('ws', 'echo hi', opts());
    expect(args).toEqual([
      '-o',
      'ProxyCommand=coder ssh --stdio --wait=no ws 2>/dev/null',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-T',
      'coder.ws',
      "bash -lc 'echo hi'",
    ]);
  });

  it('passes the remote command as a single, fully-quoted argument', () => {
    const args = buildSshArgs('ws', 'echo a; echo b', opts());
    expect(args[args.length - 1]).toBe("bash -lc 'echo a; echo b'");
  });

  it('uses bash -c when loginShell is false', () => {
    const args = buildSshArgs('ws', 'x', opts({ loginShell: false }));
    expect(args[args.length - 1]).toBe("bash -c 'x'");
  });

  it('honors waitMode and a custom coder binary', () => {
    const args = buildSshArgs('ws', 'x', opts({ waitMode: 'auto', coderBinary: '/usr/bin/coder' }));
    expect(args[1]).toBe('ProxyCommand=/usr/bin/coder ssh --stdio --wait=auto ws 2>/dev/null');
  });

  it('omits stderr redirection when silenceProxyStderr is false', () => {
    const args = buildSshArgs('ws', 'x', opts({ silenceProxyStderr: false }));
    expect(args[1]).toBe('ProxyCommand=coder ssh --stdio --wait=no ws');
  });
});

describe('sshHostAlias', () => {
  it('prefixes coder. and sanitizes owner/agent separators', () => {
    expect(sshHostAlias('ws')).toBe('coder.ws');
    expect(sshHostAlias('owner/ws.agent')).toBe('coder.owner-ws.agent');
  });
});

describe('buildLocalForwardArgs', () => {
  it('builds an OpenSSH -L forward over a coder --stdio ProxyCommand', () => {
    expect(
      buildLocalForwardArgs('ws', 12345, 4000, {
        coderBinary: 'coder',
        waitMode: 'no',
        silenceProxyStderr: true,
      }),
    ).toEqual([
      '-o',
      'ProxyCommand=coder ssh --stdio --wait=no ws 2>/dev/null',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ExitOnForwardFailure=yes',
      '-N',
      '-L',
      '12345:127.0.0.1:4000',
      'coder.ws',
    ]);
  });
});
