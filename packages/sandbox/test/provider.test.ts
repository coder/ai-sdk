import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCoderWorkspace, ensureCoderWorkspace } from "../src/coder-workspace-provider.js";
import * as sandbox from "../src/index.js";
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
} from "../src/transport.js";

class MockTransport implements CoderTransport {
  startCalls: string[] = [];
  homeDir = "/home/coder";
  async exec(options: TransportExecOptions): Promise<ExecResult> {
    if (options.command.includes("$HOME")) {
      return { exitCode: 0, stdout: this.homeDir, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error("not used");
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    return { localHost: "127.0.0.1", localPort: 1234, closed: false, close: async () => {} };
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

function readyStatus(name = "ws", id?: string): WorkspaceStatus {
  return {
    ...(id !== undefined ? { id } : {}),
    name,
    buildStatus: "running",
    transition: "start",
    agents: [{ name: "main", status: "connected", lifecycleState: "ready" }],
  };
}

function stoppedStatus(name = "ws"): WorkspaceStatus {
  return { name, buildStatus: "stopped", transition: "stop", agents: [] };
}

function startErrorStatus(name = "ws"): WorkspaceStatus {
  return {
    name,
    buildStatus: "running",
    transition: "start",
    agents: [{ name: "main", status: "connected", lifecycleState: "start_error" }],
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
    if (options.command.includes("$HOME")) {
      return { exitCode: 0, stdout: "/home/coder", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error("not used");
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    return { localHost: "127.0.0.1", localPort: 1234, closed: false, close: async () => {} };
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

describe("createCoderWorkspace", () => {
  it("reports the harness-sandbox-v1 spec and a stable provider id", () => {
    const provider = createCoderWorkspace({ workspace: "ws", transport: new MockTransport() });
    expect(provider.specificationVersion).toBe("harness-sandbox-v1");
    expect(provider.providerId).toBe("coder-workspace");
    expect(provider.bridgePorts).toBeUndefined();
  });

  it("createSession wraps a fixed workspace and uses it as the id", async () => {
    const provider = createCoderWorkspace({
      workspace: "my-ws",
      transport: new MockTransport(),
      defaultWorkingDirectory: "/home/coder",
    });
    const session = await provider.createSession();
    expect(session.id).toBe("my-ws");
    expect(session.defaultWorkingDirectory).toBe("/home/coder");
  });

  it("resolves the workspace from sessionId via a function", async () => {
    const provider = createCoderWorkspace({
      workspace: (sessionId) => `ws-${sessionId}`,
      transport: new MockTransport(),
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.createSession!({ sessionId: "abc" });
    expect(session.id).toBe("ws-abc");
  });

  it("requires `workspace` or `create` at the type level", () => {
    const transport = new MockTransport();
    // Valid: workspace only, create only, or both.
    expect(createCoderWorkspace({ workspace: "ws", transport })).toBeDefined();
    expect(createCoderWorkspace({ create: { template: "docker" }, transport })).toBeDefined();
    expect(
      createCoderWorkspace({ workspace: "ws", create: { template: "docker" }, transport }),
    ).toBeDefined();
    // @ts-expect-error neither `workspace` nor `create` is provided
    createCoderWorkspace({ transport });
    // @ts-expect-error empty settings
    createCoderWorkspace({});
  });

  it("resolves the default working directory from $HOME when not provided", async () => {
    const transport = new MockTransport();
    transport.homeDir = "/home/dev";
    const provider = createCoderWorkspace({ workspace: "ws", transport });
    const session = await provider.createSession();
    expect(session.defaultWorkingDirectory).toBe("/home/dev");
  });

  it("runs coder start when ensureStarted is set", async () => {
    const transport = new MockTransport();
    const provider = createCoderWorkspace({
      workspace: "ws",
      transport,
      ensureStarted: true,
      defaultWorkingDirectory: "/w",
    });
    await provider.createSession();
    expect(transport.startCalls).toEqual(["ws"]);
  });

  it("does NOT call onFirstCreate when wrapping an unowned workspace", async () => {
    const provider = createCoderWorkspace({
      workspace: "ws",
      transport: new MockTransport(),
      defaultWorkingDirectory: "/w",
      ownsLifecycle: false,
    });
    let called = false;
    await provider.createSession!({
      onFirstCreate: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("calls onFirstCreate with the restricted session when it owns the lifecycle", async () => {
    const provider = createCoderWorkspace({
      workspace: "ws",
      transport: new MockTransport(),
      defaultWorkingDirectory: "/w",
      ownsLifecycle: true,
    });
    let receivedRun = false;
    await provider.createSession!({
      onFirstCreate: async (session) => {
        receivedRun = typeof session.run === "function" && !("getPortUrl" in session);
      },
    });
    expect(receivedRun).toBe(true);
  });

  it("resumeSession reattaches by sessionId-derived workspace", async () => {
    const provider = createCoderWorkspace({
      workspace: (sessionId) => `ws-${sessionId}`,
      transport: new MockTransport(),
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.resumeSession!({ sessionId: "xyz" });
    expect(session.id).toBe("ws-xyz");
  });
});

describe("createCoderWorkspace — create mode", () => {
  const derivedName = (sessionId: string, prefix = "agent"): string =>
    `${prefix}-${createHash("sha1").update(sessionId).digest("hex").slice(0, 12)}`;

  it("derives a fresh per-session workspace, creates it, and deletes on destroy", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, readyStatus()]; // not found, then ready
    const provider = createCoderWorkspace({
      create: { template: "docker" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.createSession!({ sessionId: "sess-123" });

    expect(session.id).toBe(derivedName("sess-123"));
    expect(session.id).toMatch(/^agent-[0-9a-f]{12}$/);
    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]!.workspace).toBe(session.id);
    expect(transport.createCalls[0]!.template).toBe("docker");

    await session.destroy?.();
    expect(transport.destroyCalls).toBe(1); // created → owned → deleted
  });

  it("honors a custom name prefix and owner", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderWorkspace({
      create: { template: "docker", namePrefix: "My Agent", owner: "alice" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.createSession!({ sessionId: "s" });
    expect(session.id).toBe(`alice/${derivedName("s", "my-agent")}`);
    expect(transport.createCalls[0]!.workspace).toBe(session.id);
  });

  it("attaches to an existing workspace without creating, and does not delete it", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus("existing-ws")]; // already exists + ready
    const provider = createCoderWorkspace({
      workspace: "existing-ws",
      create: { template: "docker" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.createSession!({ sessionId: "s" });
    expect(session.id).toBe("existing-ws");
    expect(transport.createCalls).toHaveLength(0);

    await session.destroy?.();
    expect(transport.destroyCalls).toBe(0); // borrowed (explicit name) → never deleted
  });

  it("starts an existing-but-stopped workspace before waiting for readiness", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [stoppedStatus("existing-ws"), readyStatus("existing-ws")];
    const provider = createCoderWorkspace({
      workspace: "existing-ws",
      create: { template: "docker" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    await provider.createSession!({ sessionId: "s" });
    expect(transport.startCalls).toBe(1);
    expect(transport.createCalls).toHaveLength(0);
  });

  it("throws when the workspace exists and ifExists is 'error'", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus("existing-ws")];
    const provider = createCoderWorkspace({
      workspace: "existing-ws",
      create: { template: "docker", ifExists: "error" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    await expect(provider.createSession!({ sessionId: "s" })).rejects.toThrow(/already exists/);
  });

  it("fails fast when the agent reports a startup error", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, startErrorStatus()];
    const provider = createCoderWorkspace({
      create: { template: "docker" },
      transport,
      readyTimeoutMs: 5_000,
      defaultWorkingDirectory: "/w",
    });
    await expect(provider.createSession!({ sessionId: "s" })).rejects.toThrow(/failed to start/);
  });

  it("validates a requested preset against the template and lists available ones", async () => {
    const transport = new CreateMockTransport();
    transport.presets = [
      { name: "Standard", default: true },
      { name: "Large", default: false },
    ];
    transport.statusScript = [null];
    const provider = createCoderWorkspace({
      create: { template: "docker", preset: "Nope" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    await expect(provider.createSession!({ sessionId: "s" })).rejects.toThrow(
      /preset "Nope" not found.*Standard.*Large/s,
    );
    expect(transport.createCalls).toHaveLength(0);
  });

  it("passes a valid preset and stringified parameters through to create", async () => {
    const transport = new CreateMockTransport();
    transport.presets = [{ name: "Standard", default: true }];
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderWorkspace({
      create: {
        template: "docker",
        preset: "Standard",
        parameters: { cpus: 4, gpu: true, region: "us-west" },
        stopAfter: "8h",
      },
      transport,
      defaultWorkingDirectory: "/w",
    });
    await provider.createSession!({ sessionId: "s" });
    expect(transport.createCalls).toHaveLength(1);
    const call = transport.createCalls[0]!;
    expect(call.preset).toBe("Standard");
    expect(call.parameters).toEqual({ cpus: "4", gpu: "true", region: "us-west" });
    expect(call.stopAfter).toBe("8h");
  });

  it("skips preset validation when validate is false", async () => {
    const transport = new CreateMockTransport();
    transport.presets = [{ name: "Standard", default: true }];
    transport.statusScript = [null, readyStatus()];
    const provider = createCoderWorkspace({
      create: { template: "docker", preset: "Anything", validate: false },
      transport,
      defaultWorkingDirectory: "/w",
    });
    await provider.createSession!({ sessionId: "s" });
    expect(transport.createCalls[0]!.preset).toBe("Anything");
  });

  it("resume re-derives the same per-session name and still owns it", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus()]; // already exists from a prior createSession
    const provider = createCoderWorkspace({
      create: { template: "docker" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    const session = await provider.resumeSession!({ sessionId: "sess-123" });
    expect(session.id).toBe(derivedName("sess-123"));
    expect(transport.createCalls).toHaveLength(0);
    await session.destroy?.();
    expect(transport.destroyCalls).toBe(1); // derived name → owned even on resume
  });

  it("aborts readiness polling immediately for an already-aborted signal", async () => {
    const transport = new CreateMockTransport();
    // Workspace already exists and is ready, so ensureWorkspace skips create/start
    // and goes straight to waitForReady; only the single existence pre-check runs.
    transport.statusScript = [readyStatus("existing-ws")];
    const provider = createCoderWorkspace({
      workspace: "existing-ws",
      create: { template: "docker" },
      transport,
      defaultWorkingDirectory: "/w",
    });
    const reason = new Error("caller aborted");
    await expect(
      provider.createSession!({ sessionId: "s", abortSignal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    // The readiness loop never polled: status was hit once (the pre-check) and
    // never again, and no create/start side effects occurred.
    expect(transport.statusCalls).toBe(1);
    expect(transport.createCalls).toHaveLength(0);
    expect(transport.startCalls).toBe(0);
  });

  it("runs onFirstCreate only for a freshly created workspace", async () => {
    const created = new CreateMockTransport();
    created.statusScript = [null, readyStatus()];
    const providerA = createCoderWorkspace({
      create: { template: "docker" },
      transport: created,
      defaultWorkingDirectory: "/w",
    });
    let createdHookRan = false;
    await providerA.createSession!({
      sessionId: "s",
      onFirstCreate: async () => {
        createdHookRan = true;
      },
    });
    expect(createdHookRan).toBe(true);

    const attached = new CreateMockTransport();
    attached.statusScript = [readyStatus("existing-ws")];
    const providerB = createCoderWorkspace({
      workspace: "existing-ws",
      create: { template: "docker" },
      transport: attached,
      defaultWorkingDirectory: "/w",
    });
    let attachedHookRan = false;
    await providerB.createSession!({
      sessionId: "s",
      onFirstCreate: async () => {
        attachedHookRan = true;
      },
    });
    expect(attachedHookRan).toBe(false);
  });
});

describe("ensureCoderWorkspace", () => {
  const WS_ID = "b0e4c1f8-1234-4abc-9def-000000000001";

  it("returns the ready status (with UUID) for an existing running workspace", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus("ws", WS_ID)];
    const ws = await ensureCoderWorkspace({ workspace: "ws", transport });
    expect(ws.id).toBe(WS_ID);
    expect(ws.name).toBe("ws");
    expect(ws.created).toBe(false);
    expect(ws.buildStatus).toBe("running");
    expect(ws.agents[0]).toMatchObject({ status: "connected", lifecycleState: "ready" });
    expect(transport.createCalls).toHaveLength(0);
    expect(transport.startCalls).toBe(0);
  });

  it("tolerates an old CLI that reports no workspace id", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus()];
    const ws = await ensureCoderWorkspace({ workspace: "ws", transport });
    expect(ws.id).toBeUndefined();
    expect(ws.name).toBe("ws");
  });

  it("creates a missing workspace from the template and reports created: true", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null, readyStatus("ws", WS_ID)];
    const ws = await ensureCoderWorkspace({
      workspace: "ws",
      create: { template: "docker" },
      transport,
    });
    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]!.workspace).toBe("ws");
    expect(transport.createCalls[0]!.template).toBe("docker");
    expect(ws.created).toBe(true);
    expect(ws.id).toBe(WS_ID);
  });

  it("throws when the workspace is missing and no create block is set", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [null];
    await expect(ensureCoderWorkspace({ workspace: "ws", transport })).rejects.toThrow(
      /ensureCoderWorkspace: workspace "ws" does not exist/,
    );
    expect(transport.createCalls).toHaveLength(0);
  });

  it("starts a stopped workspace before waiting for readiness", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [stoppedStatus(), readyStatus("ws", WS_ID)];
    const ws = await ensureCoderWorkspace({ workspace: "ws", transport });
    expect(transport.startCalls).toBe(1);
    expect(transport.createCalls).toHaveLength(0);
    expect(ws.created).toBe(false);
    expect(ws.id).toBe(WS_ID);
  });

  it("keeps polling until the agent becomes ready", async () => {
    const transport = new CreateMockTransport();
    const starting: WorkspaceStatus = {
      name: "ws",
      buildStatus: "running",
      transition: "start",
      agents: [{ name: "main", status: "connecting", lifecycleState: "starting" }],
    };
    transport.statusScript = [starting, starting, readyStatus("ws", WS_ID)];
    const ws = await ensureCoderWorkspace({ workspace: "ws", transport });
    // existence pre-check + a not-ready poll + the ready poll
    expect(transport.statusCalls).toBe(3);
    expect(ws.id).toBe(WS_ID);
  });

  it("validates a requested preset like createCoderWorkspace does", async () => {
    const transport = new CreateMockTransport();
    transport.presets = [{ name: "Standard", default: true }];
    transport.statusScript = [null];
    await expect(
      ensureCoderWorkspace({
        workspace: "ws",
        create: { template: "docker", preset: "Nope" },
        transport,
      }),
    ).rejects.toThrow(/ensureCoderWorkspace: preset "Nope" not found.*Standard/s);
    expect(transport.createCalls).toHaveLength(0);
  });

  it("honors create.ifExists: 'error'", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus()];
    await expect(
      ensureCoderWorkspace({
        workspace: "ws",
        create: { template: "docker", ifExists: "error" },
        transport,
      }),
    ).rejects.toThrow(/ensureCoderWorkspace: workspace "ws" already exists/);
  });

  it("times out with the last observed status in the error", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [stoppedStatus()];
    await expect(
      ensureCoderWorkspace({ workspace: "ws", transport, readyTimeoutMs: 0 }),
    ).rejects.toThrow(/ensureCoderWorkspace: timed out after 0ms.*"ws"/s);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const transport = new CreateMockTransport();
    transport.statusScript = [readyStatus()];
    const reason = new Error("caller aborted");
    await expect(
      ensureCoderWorkspace({ workspace: "ws", transport, abortSignal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(transport.statusCalls).toBe(1); // the existence pre-check only
  });
});

describe("package export surface", () => {
  it("exports ensureCoderWorkspace from the package index", () => {
    expect(sandbox.ensureCoderWorkspace).toBe(ensureCoderWorkspace);
    expect(typeof sandbox.createCoderWorkspace).toBe("function");
  });

  it("exposes the ensure settings and result types", () => {
    // Type-level check: these annotations fail typecheck if the exports drift.
    const settings: sandbox.EnsureCoderWorkspaceSettings = { workspace: "ws" };
    const result: sandbox.EnsuredCoderWorkspace = {
      id: "b0e4c1f8-1234-4abc-9def-000000000001",
      name: "ws",
      buildStatus: "running",
      transition: "start",
      agents: [],
      created: true,
    };
    expect(settings.workspace).toBe("ws");
    expect(result.created).toBe(true);
  });
});
