import type {
  CoderTransport,
  CreateWorkspaceOptions,
  ExecResult,
  ForwardPortOptions,
  LifecycleOptions,
  ListPresetsOptions,
  PortForward,
  PresetInfo,
  SpawnedProcess,
  TransportExecOptions,
  WorkspaceStatus,
} from "./transport.js";
import { CoderApiClient, parseNativeWorkspaceRef } from "./native-api.js";
import { NativeRelay, NativeSpawnedProcess, openNativePortForward } from "./native-relay.js";

const DEFAULT_RELAY_CONNECT_TIMEOUT_MS = 30_000;

export interface CoderNativeTransportOptions {
  /** Coder deployment URL. Defaults to `CODER_URL`. */
  url?: string;
  /** Coder session/API token. Defaults to `CODER_SESSION_TOKEN`. */
  token?: string;
  /** Custom fetch implementation, primarily for tests or custom HTTP agents. */
  fetch?: typeof globalThis.fetch;
  /** Additional headers sent to Coderd over both HTTP and WebSocket. */
  headers?: Record<string, string>;
  /** Poll interval while waiting for provisioner builds. Default: 1000ms. */
  buildPollIntervalMs?: number;
  /** Maximum wait for one provisioner build. Default: 30 minutes. */
  buildTimeoutMs?: number;
  /** Maximum wait for the workspace relay handshake. Default: 30000ms. */
  relayConnectTimeoutMs?: number;
  /** Node executable used inside the workspace for the relay. Default: `node`. */
  relayNodeCommand?: string;
  /** Run commands through `bash -lc` instead of `bash -c`. Default: true. */
  loginShell?: boolean;
}

interface RelayEntry {
  workspaceId: string;
  relay: NativeRelay;
}

interface RelaySetup {
  controller: AbortController;
  promise: Promise<RelayEntry>;
  workspaceKey: string;
  workspaceId?: string;
}

/**
 * Native Coder transport: Coderd's REST API supplies the control plane and an
 * authenticated workspace-agent PTY carries a small multiplexed process/TCP
 * relay. No local `coder` or `ssh` binary is launched.
 */
export class CoderNativeTransport implements CoderTransport {
  readonly #api: CoderApiClient;
  readonly #loginShell: boolean;
  readonly #relayNodeCommand: string;
  readonly #relayConnectTimeoutMs: number;
  readonly #relays = new Map<string, RelaySetup>();

  constructor(options: CoderNativeTransportOptions = {}) {
    const url = options.url ?? process.env.CODER_URL;
    const token = options.token ?? process.env.CODER_SESSION_TOKEN;
    if (!url) {
      throw new Error("CoderNativeTransport requires a Coder URL; pass { url } or set CODER_URL");
    }
    if (!token) {
      throw new Error(
        "CoderNativeTransport requires a session token; pass { token } or set CODER_SESSION_TOKEN",
      );
    }
    this.#api = new CoderApiClient({
      url,
      token,
      fetch: options.fetch,
      headers: options.headers,
      buildPollIntervalMs: options.buildPollIntervalMs,
      buildTimeoutMs: options.buildTimeoutMs,
    });
    this.#loginShell = options.loginShell ?? true;
    this.#relayNodeCommand = options.relayNodeCommand ?? "node";
    this.#relayConnectTimeoutMs = options.relayConnectTimeoutMs ?? DEFAULT_RELAY_CONNECT_TIMEOUT_MS;
  }

  async exec(options: TransportExecOptions): Promise<ExecResult> {
    const process = this.spawn(options);
    const [stdout, stderr, result] = await Promise.all([
      drain(process.stdout),
      drain(process.stderr),
      process.wait(),
    ]);
    return { exitCode: result.exitCode, stdout, stderr };
  }

  spawn(options: TransportExecOptions): SpawnedProcess {
    return new NativeSpawnedProcess(
      this.#relayFor(options.workspace, options.abortSignal),
      options,
      this.#loginShell,
    );
  }

  async forwardPort(options: ForwardPortOptions): Promise<PortForward> {
    if (
      !Number.isInteger(options.remotePort) ||
      options.remotePort < 1 ||
      options.remotePort > 65_535
    ) {
      throw new Error(
        `invalid Coder workspace port ${options.remotePort}; expected an integer from 1 to 65535`,
      );
    }
    const relay = await this.#relayFor(options.workspace, options.abortSignal);
    return await openNativePortForward(relay, options);
  }

  async start(workspace: string, options?: LifecycleOptions): Promise<void> {
    const current = await this.#api.workspace(workspace, options?.abortSignal);
    if (current?.latest_build.status === "running") return;
    await this.#closeWorkspaceRelays(
      workspace,
      current?.id,
      current?.owner_name,
      options?.abortSignal,
    );
    await this.#api.start(workspace, options);
  }

  async stop(workspace: string, options?: LifecycleOptions): Promise<void> {
    const current = await this.#api.workspace(workspace, options?.abortSignal);
    await this.#closeWorkspaceRelays(
      workspace,
      current?.id,
      current?.owner_name,
      options?.abortSignal,
    );
    await this.#api.stop(workspace, options);
  }

  async destroy(workspace: string, options?: LifecycleOptions): Promise<void> {
    const current = await this.#api.workspace(workspace, options?.abortSignal);
    await this.#closeWorkspaceRelays(
      workspace,
      current?.id,
      current?.owner_name,
      options?.abortSignal,
    );
    await this.#api.destroy(workspace, options);
  }

  status(workspace: string, options?: LifecycleOptions): Promise<WorkspaceStatus | null> {
    return this.#api.status(workspace, options);
  }

  create(options: CreateWorkspaceOptions): Promise<void> {
    return this.#api.create(options);
  }

  listPresets(options: ListPresetsOptions): Promise<PresetInfo[]> {
    return this.#api.listPresets(options);
  }

  /** Close every cached workspace relay. Existing local port-forwards close too. */
  async close(): Promise<void> {
    const setups = [...this.#relays.values()];
    this.#relays.clear();
    const error = new Error("Coder native transport closed");
    for (const setup of setups) setup.controller.abort(error);
    const settled = await Promise.allSettled(setups.map((setup) => setup.promise));
    await Promise.all(
      settled
        .filter(
          (result): result is PromiseFulfilledResult<RelayEntry> => result.status === "fulfilled",
        )
        .map((result) => result.value.relay.close()),
    );
  }

  async #relayFor(workspace: string, signal?: AbortSignal): Promise<NativeRelay> {
    if (signal?.aborted) throw abortError(signal);
    const existing = this.#relays.get(workspace);
    if (existing !== undefined) {
      const entry = await waitWithAbort(existing.promise, signal);
      if (!entry.relay.closed) return entry.relay;
      if (this.#relays.get(workspace) === existing) this.#relays.delete(workspace);
    }
    const controller = new AbortController();
    const workspaceKey = canonicalWorkspaceKey(workspace);
    let setup!: RelaySetup;
    const promise = (async () => {
      try {
        const resolved = await waitWithAbort(
          this.#api.resolveAgent(workspace, controller.signal),
          controller.signal,
        );
        setup.workspaceId = resolved.workspace.id;
        setup.workspaceKey = canonicalWorkspaceKey(workspace, resolved.workspace.owner_name);
        if (resolved.workspace.latest_build.status !== "running") {
          throw new Error(
            `Coder workspace "${workspace}" is ${resolved.workspace.latest_build.status}; start it before connecting`,
          );
        }
        if (resolved.agent.status !== "connected") {
          throw new Error(
            `Coder workspace agent "${resolved.agent.name}" is ${resolved.agent.status}; wait for it to connect`,
          );
        }
        const relay = await NativeRelay.connect({
          api: this.#api,
          agentId: resolved.agent.id,
          nodeCommand: this.#relayNodeCommand,
          connectTimeoutMs: this.#relayConnectTimeoutMs,
          signal: controller.signal,
        });
        relay.onClose(() => {
          if (this.#relays.get(workspace) === setup) this.#relays.delete(workspace);
        });
        return { workspaceId: resolved.workspace.id, relay };
      } catch (error) {
        if (this.#relays.get(workspace) === setup) this.#relays.delete(workspace);
        throw error;
      }
    })();
    setup = { controller, promise, workspaceKey };
    this.#relays.set(workspace, setup);
    return (await waitWithAbort(promise, signal)).relay;
  }

  async #closeWorkspaceRelays(
    workspace: string,
    workspaceId?: string,
    workspaceOwner?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const requestedWorkspaceKey = canonicalWorkspaceKey(workspace);
    const workspaceKey = canonicalWorkspaceKey(workspace, workspaceOwner);
    const entries = [...this.#relays.entries()].filter(
      ([, setup]) =>
        setup.workspaceKey === workspaceKey ||
        setup.workspaceKey === requestedWorkspaceKey ||
        (workspaceId !== undefined && setup.workspaceId === workspaceId),
    );
    const error = new Error(`Coder native relay closed for workspace "${workspace}" lifecycle`);
    for (const [key, setup] of entries) {
      if (this.#relays.get(key) === setup) this.#relays.delete(key);
      setup.controller.abort(error);
    }
    const closing = Promise.allSettled(entries.map(([, setup]) => setup.promise)).then(
      async (settled) =>
        await Promise.all(
          settled
            .filter(
              (result): result is PromiseFulfilledResult<RelayEntry> =>
                result.status === "fulfilled",
            )
            .map((result) => result.value.relay.close()),
        ),
    );
    await waitWithAbort(closing, signal);
  }
}

function canonicalWorkspaceKey(workspace: string, resolvedOwner?: string): string {
  const { owner, name } = parseNativeWorkspaceRef(workspace);
  return `${resolvedOwner ?? owner}/${name}`;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw abortError(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
