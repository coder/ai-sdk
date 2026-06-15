import { describe, it, expect } from 'vitest';
import { CoderNetworkSandboxSession } from '../src/coder-network-sandbox-session.js';
import type {
  CoderTransport,
  ExecResult,
  ForwardPortOptions,
  PortForward,
  SpawnedProcess,
  TransportExecOptions,
} from '../src/transport.js';

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

class MockTransport implements CoderTransport {
  execCalls: TransportExecOptions[] = [];
  forwardCalls: ForwardPortOptions[] = [];
  closedForwards = 0;
  startCalls = 0;
  stopCalls = 0;
  destroyCalls = 0;
  execResult: ExecResult = { exitCode: 0, stdout: '', stderr: '' };

  async exec(options: TransportExecOptions): Promise<ExecResult> {
    this.execCalls.push(options);
    return this.execResult;
  }

  spawn(_options: TransportExecOptions): SpawnedProcess {
    return {
      pid: 4321,
      stdout: emptyStream(),
      stderr: emptyStream(),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    };
  }

  async forwardPort(options: ForwardPortOptions): Promise<PortForward> {
    this.forwardCalls.push(options);
    const localPort = 20_000 + this.forwardCalls.length;
    return {
      localHost: '127.0.0.1',
      localPort,
      close: async () => {
        this.closedForwards += 1;
      },
    };
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }
}

function makeSession(
  overrides: Partial<{ ports: number[]; ownsLifecycle: boolean }> = {},
): { session: CoderNetworkSandboxSession; transport: MockTransport } {
  const transport = new MockTransport();
  const session = new CoderNetworkSandboxSession({
    transport,
    workspace: 'my-ws',
    id: 'my-ws',
    defaultWorkingDirectory: '/home/coder',
    ports: overrides.ports ?? [4000],
    ownsLifecycle: overrides.ownsLifecycle ?? false,
  });
  return { session, transport };
}

describe('CoderNetworkSandboxSession', () => {
  it('exposes id, ports and a descriptive description', () => {
    const { session } = makeSession();
    expect(session.id).toBe('my-ws');
    expect(session.ports).toEqual([4000]);
    expect(session.defaultWorkingDirectory).toBe('/home/coder');
    expect(session.description).toContain('my-ws');
    expect(session.description).toContain('4000');
  });

  it('run delegates to transport.exec with the default working directory', async () => {
    const { session, transport } = makeSession();
    transport.execResult = { exitCode: 2, stdout: 'out', stderr: 'err' };
    const result = await session.run({ command: 'echo hi' });
    expect(result).toEqual({ exitCode: 2, stdout: 'out', stderr: 'err' });
    expect(transport.execCalls).toHaveLength(1);
    expect(transport.execCalls[0]!.command).toBe('echo hi');
    expect(transport.execCalls[0]!.workingDirectory).toBe('/home/coder');
  });

  it('run honors an explicit working directory and env', async () => {
    const { session, transport } = makeSession();
    await session.run({ command: 'x', workingDirectory: '/tmp/w', env: { A: '1' } });
    expect(transport.execCalls[0]!.workingDirectory).toBe('/tmp/w');
    expect(transport.execCalls[0]!.env).toEqual({ A: '1' });
  });

  it('getPortUrl forwards the port and returns a ws URL', async () => {
    const { session, transport } = makeSession();
    const url = await session.getPortUrl({ port: 4000, protocol: 'ws' });
    expect(url).toBe('ws://127.0.0.1:20001');
    expect(transport.forwardCalls).toEqual([{ workspace: 'my-ws', remotePort: 4000 }]);
  });

  it('getPortUrl caches the forward per port', async () => {
    const { session, transport } = makeSession();
    const a = await session.getPortUrl({ port: 4000 });
    const b = await session.getPortUrl({ port: 4000 });
    expect(a).toBe(b);
    expect(transport.forwardCalls).toHaveLength(1);
  });

  it('getPortUrl maps secure schemes to their plaintext local equivalent', async () => {
    const { session } = makeSession();
    expect(await session.getPortUrl({ port: 4000, protocol: 'https' })).toMatch(
      /^http:\/\//,
    );
    expect(await session.getPortUrl({ port: 4001, protocol: 'http' })).toMatch(
      /^http:\/\//,
    );
  });

  it('defaults the protocol to ws', async () => {
    const { session } = makeSession();
    expect(await session.getPortUrl({ port: 4000 })).toMatch(/^ws:\/\//);
  });

  it('setPorts replaces the exposed set and tears down dropped forwards', async () => {
    const { session, transport } = makeSession({ ports: [4000] });
    await session.getPortUrl({ port: 4000 });
    await session.setPorts([5000]);
    expect(session.ports).toEqual([5000]);
    // the 4000 forward should have been closed
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.closedForwards).toBe(1);
  });

  it('stop closes forwards but does not stop a wrapped (unowned) workspace', async () => {
    const { session, transport } = makeSession({ ownsLifecycle: false });
    await session.getPortUrl({ port: 4000 });
    await session.stop();
    expect(transport.closedForwards).toBe(1);
    expect(transport.stopCalls).toBe(0);
  });

  it('stop is idempotent', async () => {
    const { session } = makeSession();
    await session.stop();
    await session.stop();
    // no throw, and a second stop is a no-op
    expect(true).toBe(true);
  });

  it('stop stops an owned workspace', async () => {
    const { session, transport } = makeSession({ ownsLifecycle: true });
    await session.stop();
    expect(transport.stopCalls).toBe(1);
  });

  it('destroy deletes an owned workspace', async () => {
    const { session, transport } = makeSession({ ownsLifecycle: true });
    await session.destroy();
    expect(transport.destroyCalls).toBe(1);
  });

  it('getPortUrl throws once the session is stopped', async () => {
    const { session } = makeSession();
    await session.stop();
    await expect(session.getPortUrl({ port: 4000 })).rejects.toThrow(/stopped/);
  });

  it('restricted() exposes the base surface but no infra controls', () => {
    const { session } = makeSession();
    const restricted = session.restricted();
    expect(typeof restricted.run).toBe('function');
    expect(typeof restricted.spawn).toBe('function');
    expect(typeof restricted.readTextFile).toBe('function');
    expect(typeof restricted.writeTextFile).toBe('function');
    expect('getPortUrl' in restricted).toBe(false);
    expect('stop' in restricted).toBe(false);
    expect('setPorts' in restricted).toBe(false);
  });
});
