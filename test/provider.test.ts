import { describe, it, expect } from 'vitest';
import { createCoderSandbox } from '../src/coder-sandbox-provider.js';
import type {
  CoderTransport,
  ExecResult,
  ForwardPortOptions,
  LifecycleOptions,
  PortForward,
  SpawnedProcess,
  TransportExecOptions,
} from '../src/transport.js';

class MockTransport implements CoderTransport {
  startCalls: string[] = [];
  homeDir = '/home/coder';
  async exec(options: TransportExecOptions): Promise<ExecResult> {
    if (options.command.includes('$HOME')) {
      return { exitCode: 0, stdout: this.homeDir, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error('not used');
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    return { localHost: '127.0.0.1', localPort: 1234, close: async () => {} };
  }
  async start(workspace: string, _options?: LifecycleOptions): Promise<void> {
    this.startCalls.push(workspace);
  }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe('createCoderSandbox', () => {
  it('reports the harness-sandbox-v1 spec and a stable provider id', () => {
    const provider = createCoderSandbox({ workspace: 'ws', transport: new MockTransport() });
    expect(provider.specificationVersion).toBe('harness-sandbox-v1');
    expect(provider.providerId).toBe('coder-sandbox');
    expect(provider.bridgePorts).toBeUndefined();
  });

  it('createSession wraps a fixed workspace and uses it as the id', async () => {
    const provider = createCoderSandbox({
      workspace: 'my-ws',
      transport: new MockTransport(),
      defaultWorkingDirectory: '/home/coder',
    });
    const session = await provider.createSession();
    expect(session.id).toBe('my-ws');
    expect(session.defaultWorkingDirectory).toBe('/home/coder');
  });

  it('resolves the workspace from sessionId via a function', async () => {
    const provider = createCoderSandbox({
      workspace: (sessionId) => `ws-${sessionId}`,
      transport: new MockTransport(),
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.createSession!({ sessionId: 'abc' });
    expect(session.id).toBe('ws-abc');
  });

  it('falls back to using the sessionId as the workspace name', async () => {
    const provider = createCoderSandbox({
      transport: new MockTransport(),
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.createSession!({ sessionId: 'session-1' });
    expect(session.id).toBe('session-1');
  });

  it('throws when no workspace and no sessionId are available', async () => {
    const provider = createCoderSandbox({ transport: new MockTransport() });
    await expect(provider.createSession()).rejects.toThrow(/workspace/);
  });

  it('resolves the default working directory from $HOME when not provided', async () => {
    const transport = new MockTransport();
    transport.homeDir = '/home/dev';
    const provider = createCoderSandbox({ workspace: 'ws', transport });
    const session = await provider.createSession();
    expect(session.defaultWorkingDirectory).toBe('/home/dev');
  });

  it('runs coder start when ensureStarted is set', async () => {
    const transport = new MockTransport();
    const provider = createCoderSandbox({
      workspace: 'ws',
      transport,
      ensureStarted: true,
      defaultWorkingDirectory: '/w',
    });
    await provider.createSession();
    expect(transport.startCalls).toEqual(['ws']);
  });

  it('does NOT call onFirstCreate when wrapping an unowned workspace', async () => {
    const provider = createCoderSandbox({
      workspace: 'ws',
      transport: new MockTransport(),
      defaultWorkingDirectory: '/w',
      ownsLifecycle: false,
    });
    let called = false;
    await provider.createSession!({ onFirstCreate: async () => { called = true; } });
    expect(called).toBe(false);
  });

  it('calls onFirstCreate with the restricted session when it owns the lifecycle', async () => {
    const provider = createCoderSandbox({
      workspace: 'ws',
      transport: new MockTransport(),
      defaultWorkingDirectory: '/w',
      ownsLifecycle: true,
    });
    let receivedRun = false;
    await provider.createSession!({
      onFirstCreate: async (session) => {
        receivedRun = typeof session.run === 'function' && !('getPortUrl' in session);
      },
    });
    expect(receivedRun).toBe(true);
  });

  it('resumeSession reattaches by sessionId-derived workspace', async () => {
    const provider = createCoderSandbox({
      workspace: (sessionId) => `ws-${sessionId}`,
      transport: new MockTransport(),
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.resumeSession!({ sessionId: 'xyz' });
    expect(session.id).toBe('ws-xyz');
  });
});
