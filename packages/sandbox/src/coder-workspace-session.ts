import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import type { Experimental_SandboxSession } from '@ai-sdk/provider-utils';
import * as fileIo from './file-io.js';
import type {
  CoderTransport,
  ExecResult,
  PortForward,
  SpawnedProcess,
  TransportExecOptions,
} from './transport.js';

// Derived from the moving canary contract so the run/spawn option bag can never
// silently drift from the AI SDK's sandbox-session shape.
type SandboxProcessOptions = Parameters<Experimental_SandboxSession['run']>[0];

export interface CoderWorkspaceSessionConfig {
  transport: CoderTransport;
  /** Workspace reference: `[owner/]workspace[.agent]`. */
  workspace: string;
  /** Stable id used by the harness for cross-process resume (the workspace name). */
  id: string;
  /** Absolute default working directory for `run`/`spawn` and relative file paths. */
  defaultWorkingDirectory: string;
  /** Ports the workspace exposes; `ports[0]` is what the adapter binds the bridge to. */
  ports: number[];
  /**
   * When true, `stop()`/`destroy()` actually stop/delete the workspace. When
   * false (wrapping a caller-owned workspace) they only release host-side
   * resources (port-forwards) and leave the workspace running.
   */
  ownsLifecycle: boolean;
}

/**
 * A {@link HarnessV1NetworkSandboxSession} backed by a Coder workspace.
 *
 * Exec maps to `coder ssh`, file I/O to base64-over-`coder ssh`, and
 * `getPortUrl` to an OpenSSH `-L` local forward over a `coder ssh --stdio`
 * ProxyCommand, exposed as a local `ws://127.0.0.1:<port>` URL — which is what
 * bridge-backed harness adapters (Claude Code, Codex) open their WebSocket
 * against.
 */
export class CoderWorkspaceSession implements HarnessV1NetworkSandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly description: string;

  readonly #transport: CoderTransport;
  readonly #workspace: string;
  readonly #ownsLifecycle: boolean;
  readonly #forwards = new Map<number, Promise<PortForward>>();
  #ports: number[];
  #stopped = false;

  constructor(config: CoderWorkspaceSessionConfig) {
    this.#transport = config.transport;
    this.#workspace = config.workspace;
    this.#ownsLifecycle = config.ownsLifecycle;
    this.#ports = [...config.ports];
    this.id = config.id;
    this.defaultWorkingDirectory = config.defaultWorkingDirectory;
    this.description =
      `Coder workspace "${config.workspace}". ` +
      `Default working directory: ${config.defaultWorkingDirectory}. ` +
      `Exposed ports: ${this.#ports.length > 0 ? this.#ports.join(', ') : 'none'}. ` +
      `Commands run inside the workspace via 'coder ssh'.`;
  }

  get ports(): ReadonlyArray<number> {
    return this.#ports;
  }

  #execOptions(options: SandboxProcessOptions): TransportExecOptions {
    return {
      workspace: this.#workspace,
      command: options.command,
      workingDirectory: options.workingDirectory ?? this.defaultWorkingDirectory,
      env: options.env,
      abortSignal: options.abortSignal,
    };
  }

  #fileIoContext(): fileIo.FileIoContext {
    return {
      transport: this.#transport,
      workspace: this.#workspace,
      defaultWorkingDirectory: this.defaultWorkingDirectory,
    };
  }

  // --- exec surface ---------------------------------------------------------

  readonly run = (options: SandboxProcessOptions): Promise<ExecResult> =>
    this.#transport.exec(this.#execOptions(options));

  readonly spawn = async (options: SandboxProcessOptions): Promise<SpawnedProcess> =>
    this.#transport.spawn(this.#execOptions(options));

  // --- file I/O surface -----------------------------------------------------

  readonly readFile = (options: fileIo.ReadFileOptions) =>
    fileIo.readFile(this.#fileIoContext(), options);

  readonly readBinaryFile = (options: fileIo.ReadFileOptions) =>
    fileIo.readBinaryFile(this.#fileIoContext(), options);

  readonly readTextFile = (options: fileIo.ReadTextFileOptions) =>
    fileIo.readTextFile(this.#fileIoContext(), options);

  readonly writeFile = (options: fileIo.WriteFileOptions<ReadableStream<Uint8Array>>) =>
    fileIo.writeFile(this.#fileIoContext(), options);

  readonly writeBinaryFile = (options: fileIo.WriteFileOptions<Uint8Array>) =>
    fileIo.writeBinaryFile(this.#fileIoContext(), options);

  readonly writeTextFile = (options: fileIo.WriteTextFileOptions) =>
    fileIo.writeTextFile(this.#fileIoContext(), options);

  // --- network surface ------------------------------------------------------

  readonly getPortUrl = async (options: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => {
    if (this.#stopped) {
      throw new Error('cannot resolve a port URL: the sandbox session is stopped');
    }
    let forward = this.#forwards.get(options.port);
    if (forward !== undefined) {
      // Reuse only a live forward: a rejected promise or a tunnel whose child
      // has since exited must be evicted so we re-establish below.
      const existing = await forward.catch(() => undefined);
      if (existing === undefined || existing.closed) {
        this.#forwards.delete(options.port);
        if (existing?.closed) void existing.close().catch(() => {});
        forward = undefined;
      }
    }
    if (forward === undefined) {
      forward = this.#transport.forwardPort({
        workspace: this.#workspace,
        remotePort: options.port,
      });
      this.#forwards.set(options.port, forward);
      // If the forward fails, drop it so a later call can retry.
      forward.catch(() => this.#forwards.delete(options.port));
    }
    const resolved = await forward;
    const scheme = localScheme(options.protocol ?? 'ws');
    return `${scheme}://${resolved.localHost}:${resolved.localPort}`;
  };

  readonly setPorts = async (
    ports: ReadonlyArray<number>,
    _options?: { abortSignal?: AbortSignal },
  ): Promise<void> => {
    const next = [...ports];
    // Tear down forwards for ports that are no longer exposed.
    for (const [port, forward] of this.#forwards) {
      if (!next.includes(port)) {
        this.#forwards.delete(port);
        void forward.then((f) => f.close()).catch(() => {});
      }
    }
    this.#ports = next;
  };

  // --- lifecycle ------------------------------------------------------------

  readonly stop = async (): Promise<void> => {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#closeForwards();
    if (this.#ownsLifecycle) {
      await this.#transport.stop(this.#workspace);
    }
  };

  readonly destroy = async (): Promise<void> => {
    this.#stopped = true;
    await this.#closeForwards();
    if (this.#ownsLifecycle) {
      await this.#transport.destroy(this.#workspace);
    }
  };

  /** Reduced view exposing only the base file/exec surface (no infra controls). */
  readonly restricted = (): Experimental_SandboxSession => ({
    description: this.description,
    readFile: this.readFile,
    readBinaryFile: this.readBinaryFile,
    readTextFile: this.readTextFile,
    writeFile: this.writeFile,
    writeBinaryFile: this.writeBinaryFile,
    writeTextFile: this.writeTextFile,
    spawn: this.spawn,
    run: this.run,
  });

  async #closeForwards(): Promise<void> {
    const forwards = [...this.#forwards.values()];
    this.#forwards.clear();
    await Promise.all(forwards.map((forward) => forward.then((f) => f.close()).catch(() => {})));
  }
}

/**
 * The OpenSSH `-L` local forward is plaintext on the loopback interface, so
 * secure schemes collapse to their plaintext local equivalent. Bridge adapters
 * request `ws`, which is the common case.
 */
function localScheme(protocol: 'http' | 'https' | 'ws'): 'http' | 'ws' {
  switch (protocol) {
    case 'ws':
      return 'ws';
    case 'http':
    case 'https':
      return 'http';
  }
}
