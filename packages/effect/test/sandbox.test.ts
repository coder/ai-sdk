import type {
  CoderTransport,
  CreateWorkspaceOptions,
  ExecResult,
  ListPresetsOptions,
  PortForward,
  PresetInfo,
  SpawnedProcess,
  TransportExecOptions,
  WorkspaceStatus,
} from "@coder/ai-sdk-sandbox";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { acquireSession, acquireWorkspace, CoderSandboxError } from "../src/sandbox.js";

const readyStatus = (name: string): WorkspaceStatus => ({
  id: "11111111-2222-3333-4444-555555555555",
  name,
  buildStatus: "running",
  transition: "start",
  agents: [{ name: "main", status: "connected", lifecycleState: "ready" }],
});

/**
 * In-memory `CoderTransport` fake. Tracks lifecycle calls; `exists` controls
 * whether the workspace pre-exists.
 */
class FakeTransport implements CoderTransport {
  readonly calls: Array<string> = [];
  exists: boolean;
  failStatus = false;
  /** When true, created workspaces report a never-ready agent. */
  neverReady = false;

  constructor(options: { exists: boolean }) {
    this.exists = options.exists;
  }

  async exec(options: TransportExecOptions): Promise<ExecResult> {
    this.calls.push(`exec:${options.command}`);
    return { exitCode: 0, stdout: "/home/coder", stderr: "" };
  }
  spawn(_options: TransportExecOptions): SpawnedProcess {
    throw new Error("spawn is not used in these tests");
  }
  forwardPort(): Promise<PortForward> {
    throw new Error("forwardPort is not used in these tests");
  }
  async start(workspace: string): Promise<void> {
    this.calls.push(`start:${workspace}`);
  }
  async stop(workspace: string): Promise<void> {
    this.calls.push(`stop:${workspace}`);
  }
  async destroy(workspace: string): Promise<void> {
    this.calls.push(`destroy:${workspace}`);
  }
  async status(workspace: string): Promise<WorkspaceStatus | null> {
    this.calls.push(`status:${workspace}`);
    if (this.failStatus) throw new Error("status exploded");
    if (!this.exists) return null;
    if (this.neverReady) {
      return {
        ...readyStatus(workspace),
        agents: [{ name: "main", status: "connecting", lifecycleState: "starting" }],
      };
    }
    return readyStatus(workspace);
  }
  async create(options: CreateWorkspaceOptions): Promise<void> {
    this.calls.push(`create:${options.workspace}`);
    this.exists = true;
  }
  async listPresets(_options: ListPresetsOptions): Promise<PresetInfo[]> {
    return [];
  }
}

const scopedAcquire = (
  transport: FakeTransport,
  teardown?: "delete-if-created" | "stop-if-created" | "keep",
) =>
  Effect.scoped(
    Effect.andThen(
      acquireWorkspace({
        workspace: "spike-ws",
        create: { template: "docker", validate: false },
        transport,
        teardown,
      }),
      (workspace) => Effect.succeed(workspace),
    ),
  );

describe("acquireWorkspace", () => {
  it("creates a missing workspace and deletes it on scope close (default policy)", async () => {
    const transport = new FakeTransport({ exists: false });
    const workspace = await Effect.runPromise(scopedAcquire(transport));

    expect(workspace.created).toBe(true);
    expect(transport.calls).toContain("create:spike-ws");
    expect(transport.calls).toContain("destroy:spike-ws");
    expect(transport.calls).not.toContain("stop:spike-ws");
  });

  it("never tears down a pre-existing workspace it merely attached to", async () => {
    const transport = new FakeTransport({ exists: true });
    const workspace = await Effect.runPromise(scopedAcquire(transport));

    expect(workspace.created).toBe(false);
    expect(transport.calls).not.toContain("destroy:spike-ws");
    expect(transport.calls).not.toContain("stop:spike-ws");
  });

  it("honors the stop-if-created and keep policies", async () => {
    const stopped = new FakeTransport({ exists: false });
    await Effect.runPromise(scopedAcquire(stopped, "stop-if-created"));
    expect(stopped.calls).toContain("stop:spike-ws");
    expect(stopped.calls).not.toContain("destroy:spike-ws");

    const kept = new FakeTransport({ exists: false });
    await Effect.runPromise(scopedAcquire(kept, "keep"));
    expect(kept.calls).not.toContain("stop:spike-ws");
    expect(kept.calls).not.toContain("destroy:spike-ws");
  });

  it("rolls back a created workspace when readiness fails after creation", async () => {
    const transport = new FakeTransport({ exists: false });
    transport.neverReady = true;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireWorkspace({
          workspace: "spike-ws",
          create: { template: "docker", validate: false },
          readyTimeoutMs: 1,
          transport,
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(transport.calls).toContain("create:spike-ws");
    // The created-but-never-ready workspace must not leak.
    expect(transport.calls).toContain("destroy:spike-ws");
  });

  it("never deletes a workspace it did not itself create (concurrent-creation race)", async () => {
    // Simulates losing a create race: our status probe says the workspace is
    // missing, but our own create call then fails (e.g. name conflict with
    // `ifExists: "error"`). The other caller's workspace must not be touched.
    const transport = new FakeTransport({ exists: false });
    transport.create = async (options: CreateWorkspaceOptions) => {
      transport.calls.push(`create:${options.workspace}`);
      throw new Error("a workspace with this name already exists");
    };

    const exit = await Effect.runPromiseExit(scopedAcquire(transport));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(transport.calls).toContain("create:spike-ws");
    expect(transport.calls).not.toContain("destroy:spike-ws");
    expect(transport.calls).not.toContain("stop:spike-ws");
  });

  it("does not roll back a pre-existing workspace when acquisition fails", async () => {
    const transport = new FakeTransport({ exists: true });
    transport.neverReady = true;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(acquireWorkspace({ workspace: "spike-ws", readyTimeoutMs: 1, transport })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(transport.calls).not.toContain("destroy:spike-ws");
    expect(transport.calls).not.toContain("stop:spike-ws");
  });

  it("wraps acquisition failures in CoderSandboxError", async () => {
    const transport = new FakeTransport({ exists: false });
    transport.failStatus = true;

    const exit = await Effect.runPromiseExit(scopedAcquire(transport));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(CoderSandboxError);
      expect(exit.cause.error.phase).toBe("acquire");
    }
  });

  it("releases the workspace when the fiber is interrupted after acquisition", async () => {
    const transport = new FakeTransport({ exists: false });

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Effect.andThen(
              acquireWorkspace({
                workspace: "spike-ws",
                create: { template: "docker", validate: false },
                transport,
              }),
              // Hold the scope open until interrupted.
              Effect.never,
            ),
          ),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const check = () => {
                if (transport.calls.includes("create:spike-ws")) return resolve();
                setTimeout(check, 5);
              };
              check();
            }),
        );
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(transport.calls).toContain("destroy:spike-ws");
  });
});

describe("acquireSession", () => {
  const settings = (transport: FakeTransport) => ({
    workspace: "spike-ws",
    transport,
    defaultWorkingDirectory: "/home/coder",
    ownsLifecycle: true,
  });

  it("stops the session on scope close by default", async () => {
    const transport = new FakeTransport({ exists: true });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.map(acquireSession({ settings: settings(transport) }), (session) => session.id),
      ),
    );

    expect(id).toBe("spike-ws");
    expect(transport.calls).toContain("stop:spike-ws");
    expect(transport.calls).not.toContain("destroy:spike-ws");
  });

  it("destroys the session when configured", async () => {
    const transport = new FakeTransport({ exists: true });
    await Effect.runPromise(
      Effect.scoped(acquireSession({ settings: settings(transport), teardown: "destroy" })),
    );

    expect(transport.calls).toContain("destroy:spike-ws");
  });

  it("rolls back a workspace created by a failed create-mode session acquisition", async () => {
    const transport = new FakeTransport({ exists: false });
    transport.neverReady = true;

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireSession({
          settings: {
            workspace: "spike-ws",
            create: { template: "docker", validate: false },
            readyTimeoutMs: 1,
            defaultWorkingDirectory: "/home/coder",
            transport,
          },
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(transport.calls).toContain("create:spike-ws");
    // The created-but-never-ready workspace must not leak.
    expect(transport.calls).toContain("destroy:spike-ws");
  });

  it("releases the session when the fiber is interrupted after acquisition", async () => {
    const transport = new FakeTransport({ exists: true });
    // Wrap-mode acquisition makes no transport calls, so signal it explicitly.
    let acquired = false;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Effect.andThen(
              acquireSession({ settings: settings(transport) }),
              Effect.suspend(() => {
                acquired = true;
                return Effect.never;
              }),
            ),
          ),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const check = () => {
                if (acquired) return resolve();
                setTimeout(check, 5);
              };
              check();
            }),
        );
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(transport.calls).toContain("stop:spike-ws");
  });
});
