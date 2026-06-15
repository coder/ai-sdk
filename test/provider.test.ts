import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createCoderSandbox } from '../src/coder-sandbox-provider.js';
import type {
  CoderTransport,
  CreateWorkspaceOptions,
  ExecResult,
  ForwardPortOptions,
  LifecycleOptions,
  PortForward,
  PresetInfo,
  SpawnedProcess,
  TransportExecOptions,
  WorkspaceStatus,
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
  async status(): Promise<WorkspaceStatus | null> {
    return null;
  }
  async create(): Promise<void> {}
  async listPresets(): Promise<PresetInfo[]> {
    return [];
  }
}

function readyStatus(name = 'ws'): WorkspaceStatus {
  return {
    name,
    buildStatus: 'running',
    transition: 'start',
    agents: [{ name: 'main', status: 'connected', lifecycleState: 'ready' }],
  };
}

function stoppedStatus(name = 'ws'): WorkspaceStatus {
  return { name, buildStatus: 'stopped', transition: 'stop', agents: [] };
}

function startErrorStatus(name = 'ws'): WorkspaceStatus {
  return {
    name,
    buildStatus: 'running',
    transition: 'start',
    agents: [{ name: 'main', status: 'connected', lifecycleState: 'start_error' }],
  };
}

/** A transport for create-mode tests: scripted status responses + call tracking. */
class CreateMockTransport implements CoderTransport {
  createCalls: CreateWorkspaceOptions[] = [];
  startCalls = 0;
  stopCalls = 0;
  destroyCalls = 0;
  statusCalls = 0;
  presets: PresetInfo[] = [];
  /** Status responses returned in order; the last one repeats once exhausted. */
  statusScript: (WorkspaceStatus | null)[] = [null];
  #idx = 0;

  async exec(options: TransportExecOptions): Promise<ExecResult> {
    if (options.command.includes('$HOME')) {
      return { exitCode: 0, stdout: '/home/coder', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error('not used');
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    return { localHost: '127.0.0.1', localPort: 1234, close: async () => {} };
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
  async status(): Promise<WorkspaceStatus | null> {
    this.statusCalls += 1;
    const i = Math.min(this.#idx, this.statusScript.length - 1);
    this.#idx += 1;
    return this.statusScript[i] ?? null;
  }
  async create(options: CreateWorkspaceOptions): Promise<void> {
    this.createCalls.push(options);
  }
  async listPresets(): Promise<PresetInfo[]> {
    return this.presets;
  }
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

describe('createCoderSandbox — create mode', () => {
  const derivedName = (sessionId: string, prefix = 'agent'): string =>
    `${prefix}-${createHash('sha1').update(sessionId).digest('hex').slice(0, 12)}`;

  it('derives a fresh per-session workspace, creates it, and deletes on destroy', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, readyStatus()]; // not found, then ready
    const provider = createCoderSandbox({
      create: { template: 'docker' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.createSession!({ sessionId: 'sess-123' });

    expect(session.id).toBe(derivedName('sess-123'));
    expect(session.id).toMatch(/^agent-[0-9a-f]{12}$/);
    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]!.workspace).toBe(session.id);
    expect(transport.createCalls[0]!.template).toBe('docker');

    await session.destroy?.();
    expect(transport.destroyCalls).toBe(1); // created → owned → deleted
  });

  it('honors a custom name prefix and owner', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderSandbox({
      create: { template: 'docker', namePrefix: 'My Agent', owner: 'alice' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.createSession!({ sessionId: 's' });
    expect(session.id).toBe(`alice/${derivedName('s', 'my-agent')}`);
    expect(transport.createCalls[0]!.workspace).toBe(session.id);
  });

  it('attaches to an existing workspace without creating, and does not delete it', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus('existing-ws')]; // already exists + ready
    const provider = createCoderSandbox({
      workspace: 'existing-ws',
      create: { template: 'docker' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.createSession!({ sessionId: 's' });
    expect(session.id).toBe('existing-ws');
    expect(transport.createCalls).toHaveLength(0);

    await session.destroy?.();
    expect(transport.destroyCalls).toBe(0); // borrowed (explicit name) → never deleted
  });

  it('starts an existing-but-stopped workspace before waiting for readiness', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [stoppedStatus('existing-ws'), readyStatus('existing-ws')];
    const provider = createCoderSandbox({
      workspace: 'existing-ws',
      create: { template: 'docker' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    await provider.createSession!({ sessionId: 's' });
    expect(transport.startCalls).toBe(1);
    expect(transport.createCalls).toHaveLength(0);
  });

  it("throws when the workspace exists and ifExists is 'error'", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus('existing-ws')];
    const provider = createCoderSandbox({
      workspace: 'existing-ws',
      create: { template: 'docker', ifExists: 'error' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    await expect(provider.createSession!({ sessionId: 's' })).rejects.toThrow(/already exists/);
  });

  it('fails fast when the agent reports a startup error', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, startErrorStatus()];
    const provider = createCoderSandbox({
      create: { template: 'docker' },
      transport,
      readyTimeoutMs: 5_000,
      defaultWorkingDirectory: '/w',
    });
    await expect(provider.createSession!({ sessionId: 's' })).rejects.toThrow(/failed to start/);
  });

  it('validates a requested preset against the template and lists available ones', async () => {
    const transport = new CreateMockTransport();
    transport.presets = [
      { name: 'Standard', default: true },
      { name: 'Large', default: false },
    ];
    transport.statusScript = [null];
    const provider = createCoderSandbox({
      create: { template: 'docker', preset: 'Nope' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    await expect(provider.createSession!({ sessionId: 's' })).rejects.toThrow(
      /preset "Nope" not found.*Standard.*Large/s,
    );
    expect(transport.createCalls).toHaveLength(0);
  });

  it('passes a valid preset and stringified parameters through to create', async () => {
    const transport = new CreateMockTransport();
    transport.presets = [{ name: 'Standard', default: true }];
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderSandbox({
      create: {
        template: 'docker',
        preset: 'Standard',
        parameters: { cpus: 4, gpu: true, region: 'us-west' },
        stopAfter: '8h',
      },
      transport,
      defaultWorkingDirectory: '/w',
    });
    await provider.createSession!({ sessionId: 's' });
    expect(transport.createCalls).toHaveLength(1);
    const call = transport.createCalls[0]!;
    expect(call.preset).toBe('Standard');
    expect(call.parameters).toEqual({ cpus: '4', gpu: 'true', region: 'us-west' });
    expect(call.stopAfter).toBe('8h');
  });

  it('skips preset validation when validate is false', async () => {
    const transport = new CreateMockTransport();
    transport.presets = [{ name: 'Standard', default: true }];
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderSandbox({
      create: { template: 'docker', preset: 'Anything', validate: false },
      transport,
      defaultWorkingDirectory: '/w',
    });
    await provider.createSession!({ sessionId: 's' });
    expect(transport.createCalls[0]!.preset).toBe('Anything');
  });

  it('resume re-derives the same per-session name and still owns it', async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus()]; // already exists from a prior createSession
    const provider = createCoderSandbox({
      create: { template: 'docker' },
      transport,
      defaultWorkingDirectory: '/w',
    });
    const session = await provider.resumeSession!({ sessionId: 'sess-123' });
    expect(session.id).toBe(derivedName('sess-123'));
    expect(transport.createCalls).toHaveLength(0);
    await session.destroy?.();
    expect(transport.destroyCalls).toBe(1); // derived name → owned even on resume
  });

  it('runs onFirstCreate only for a freshly created workspace', async () => {
    const created = new CreateMockTransport();
    created.statusScript = [null, readyStatus()];
    const providerA = createCoderSandbox({
      create: { template: 'docker' },
      transport: created,
      defaultWorkingDirectory: '/w',
    });
    let createdHookRan = false;
    await providerA.createSession!({
      sessionId: 's',
      onFirstCreate: async () => {
        createdHookRan = true;
      },
    });
    expect(createdHookRan).toBe(true);

    const attached = new CreateMockTransport();
    attached.statusScript = [readyStatus('existing-ws')];
    const providerB = createCoderSandbox({
      workspace: 'existing-ws',
      create: { template: 'docker' },
      transport: attached,
      defaultWorkingDirectory: '/w',
    });
    let attachedHookRan = false;
    await providerB.createSession!({
      sessionId: 's',
      onFirstCreate: async () => {
        attachedHookRan = true;
      },
    });
    expect(attachedHookRan).toBe(false);
  });
});
