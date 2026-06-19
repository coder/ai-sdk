import { createHash } from "node:crypto";
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
} from "@coder/ai-sdk-sandbox";
import type { SandboxBackendCreateInput, SandboxBackendPrewarmInput } from "eve/sandbox";
import { describe, expect, it } from "vitest";
import { createCoderSandboxBackend } from "../src/index.js";

const HOME = "/home/coder";

function readyStatus(name = "ws"): WorkspaceStatus {
  return {
    name,
    buildStatus: "running",
    transition: "start",
    agents: [{ name: "main", status: "connected", lifecycleState: "ready" }],
  };
}

/**
 * A scripted, side-effect-tracking {@link CoderTransport}. Lets us exercise the eve
 * backend end-to-end — create-or-attach, the session I/O surface, and dispose — with
 * no live Coder deployment.
 */
class MockTransport implements CoderTransport {
  execCommands: string[] = [];
  createCalls: CreateWorkspaceOptions[] = [];
  startCalls = 0;
  stopCalls: string[] = [];
  destroyCalls: string[] = [];
  /** Status responses returned in order; the last repeats once exhausted. */
  statusScript: (WorkspaceStatus | null)[] = [null, readyStatus()];
  #idx = 0;

  async exec(options: TransportExecOptions): Promise<ExecResult> {
    this.execCommands.push(options.command);
    if (options.command.includes("$HOME")) {
      return { exitCode: 0, stdout: HOME, stderr: "" };
    }
    return { exitCode: 0, stdout: `ran:${options.command}`, stderr: "" };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error("not used");
  }
  async forwardPort(_options: ForwardPortOptions): Promise<PortForward> {
    return { localHost: "127.0.0.1", localPort: 1234, closed: false, close: async () => {} };
  }
  async start(_workspace: string, _options?: LifecycleOptions): Promise<void> {
    this.startCalls += 1;
  }
  async stop(workspace: string, _options?: LifecycleOptions): Promise<void> {
    this.stopCalls.push(workspace);
  }
  async destroy(workspace: string, _options?: LifecycleOptions): Promise<void> {
    this.destroyCalls.push(workspace);
  }
  async status(): Promise<WorkspaceStatus | null> {
    const i = Math.min(this.#idx, this.statusScript.length - 1);
    this.#idx += 1;
    return this.statusScript[i] ?? null;
  }
  async create(options: CreateWorkspaceOptions): Promise<void> {
    this.createCalls.push(options);
  }
  async listPresets(): Promise<PresetInfo[]> {
    return [];
  }
}

/** The per-session workspace name the underlying provider derives from a session key. */
function derivedName(sessionKey: string): string {
  return `agent-${createHash("sha1").update(sessionKey).digest("hex").slice(0, 12)}`;
}

function createInput(
  sessionKey: string,
  existingMetadata?: Record<string, unknown>,
): SandboxBackendCreateInput {
  return {
    templateKey: null,
    sessionKey,
    runtimeContext: { appRoot: "/app" },
    existingMetadata,
  };
}

function prewarmInput(
  seedFiles: SandboxBackendPrewarmInput["seedFiles"] = [],
  log?: (message: string) => void,
): SandboxBackendPrewarmInput {
  return {
    templateKey: "tpl",
    runtimeContext: { appRoot: "/app" },
    seedFiles,
    log,
  };
}

describe("createCoderSandboxBackend", () => {
  it("reports the stable backend name", () => {
    const backend = createCoderSandboxBackend({ workspace: "ws", transport: new MockTransport() });
    expect(backend.name).toBe("coder");
  });

  it("requires `workspace` or `create`", () => {
    expect(() => createCoderSandboxBackend({ transport: new MockTransport() })).toThrow(
      /set `workspace`.*`create`/s,
    );
  });

  it("create() provisions a per-session workspace and exposes an eve SandboxSession", async () => {
    const transport = new MockTransport();
    transport.statusScript = [null, readyStatus()];
    const backend = createCoderSandboxBackend({ create: { template: "docker" }, transport });

    const handle = await backend.create(createInput("sess-123"));

    expect(handle.session.id).toBe(derivedName("sess-123"));
    expect(transport.createCalls).toHaveLength(1);
    expect(transport.createCalls[0]!.template).toBe("docker");
    expect(typeof handle.session.run).toBe("function");
    expect(typeof handle.session.resolvePath).toBe("function");
    expect(await handle.useSessionFn()).toBe(handle.session);
  });

  it("captureState records the backend name, workspace metadata, and session key", async () => {
    const transport = new MockTransport();
    transport.statusScript = [null, readyStatus()];
    const backend = createCoderSandboxBackend({ create: { template: "docker" }, transport });
    const handle = await backend.create(createInput("s"));
    expect(await handle.captureState()).toEqual({
      backendName: "coder",
      metadata: { workspace: derivedName("s") },
      sessionKey: "s",
    });
  });

  it("run() delegates to the transport's exec", async () => {
    const transport = new MockTransport();
    const backend = createCoderSandboxBackend({ workspace: "ws", transport });
    const handle = await backend.create(createInput("s"));
    expect((await handle.session.run({ command: "echo hi" })).stdout).toBe("ran:echo hi");
  });

  it("removePath() issues an rm with the resolved path and flags", async () => {
    const transport = new MockTransport();
    const backend = createCoderSandboxBackend({ workspace: "ws", transport });
    const handle = await backend.create(createInput("s"));
    await handle.session.removePath({ path: "build", recursive: true, force: true });
    expect(transport.execCommands).toContain(`rm -rf -- '${HOME}/build'`);
  });

  it("resolvePath anchors relative paths to the working dir and passes absolute through", async () => {
    const transport = new MockTransport();
    const backend = createCoderSandboxBackend({ workspace: "ws", transport });
    const handle = await backend.create(createInput("s"));
    expect(handle.session.resolvePath("a/b.txt")).toBe(`${HOME}/a/b.txt`);
    expect(handle.session.resolvePath("/etc/hosts")).toBe("/etc/hosts");
  });

  describe("setNetworkPolicy", () => {
    async function makeSession(allowUnsafe?: boolean) {
      const transport = new MockTransport();
      const backend = createCoderSandboxBackend({
        workspace: "ws",
        transport,
        allowUnsafeNetworkPolicy: allowUnsafe,
      });
      return (await backend.create(createInput("s"))).session;
    }

    it("accepts allow-all as a no-op", async () => {
      await expect((await makeSession()).setNetworkPolicy("allow-all")).resolves.toBeUndefined();
    });

    it("throws on a restrictive policy by default", async () => {
      await expect((await makeSession()).setNetworkPolicy("deny-all")).rejects.toThrow(
        /cannot enforce network/,
      );
    });

    it("no-ops a restrictive policy when allowUnsafeNetworkPolicy is set", async () => {
      await expect((await makeSession(true)).setNetworkPolicy("deny-all")).resolves.toBeUndefined();
    });
  });

  describe("dispose", () => {
    async function disposeWith(policy?: "keep" | "stop" | "delete") {
      const transport = new MockTransport();
      transport.statusScript = [null, readyStatus()];
      const backend = createCoderSandboxBackend({
        create: { template: "docker" },
        transport,
        dispose: policy,
      });
      await (await backend.create(createInput("s"))).dispose();
      return transport;
    }

    it("keeps the workspace running by default", async () => {
      const transport = await disposeWith();
      expect(transport.stopCalls).toEqual([]);
      expect(transport.destroyCalls).toEqual([]);
    });

    it("stops the workspace when dispose is 'stop'", async () => {
      const transport = await disposeWith("stop");
      expect(transport.stopCalls).toEqual([derivedName("s")]);
      expect(transport.destroyCalls).toEqual([]);
    });

    it("deletes the workspace when dispose is 'delete'", async () => {
      const transport = await disposeWith("delete");
      expect(transport.destroyCalls).toEqual([derivedName("s")]);
    });

    it("never stops or deletes a borrowed (explicitly named) workspace", async () => {
      const transport = new MockTransport();
      const backend = createCoderSandboxBackend({
        workspace: "team-dev",
        transport,
        dispose: "delete",
      });
      await (await backend.create(createInput("s"))).dispose();
      expect(transport.destroyCalls).toEqual([]);
      expect(transport.stopCalls).toEqual([]);
    });
  });

  describe("prewarm", () => {
    it("returns reused:false without capturing template state", async () => {
      const backend = createCoderSandboxBackend({
        create: { template: "docker" },
        transport: new MockTransport(),
      });
      expect(await backend.prewarm(prewarmInput())).toEqual({ reused: false });
    });

    it("logs that seed files are ignored", async () => {
      const backend = createCoderSandboxBackend({
        create: { template: "docker" },
        transport: new MockTransport(),
      });
      const logs: string[] = [];
      await backend.prewarm(prewarmInput([{ path: "x.txt", content: "hi" }], (m) => logs.push(m)));
      expect(logs.join("\n")).toMatch(/ignoring 1 seed file/);
    });
  });

  it("reattaches to an existing workspace without creating when existingMetadata is present", async () => {
    const transport = new MockTransport();
    transport.statusScript = [readyStatus(derivedName("s"))];
    const backend = createCoderSandboxBackend({ create: { template: "docker" }, transport });
    const handle = await backend.create(createInput("s", { workspace: derivedName("s") }));
    expect(handle.session.id).toBe(derivedName("s"));
    expect(transport.createCalls).toHaveLength(0);
  });
});
