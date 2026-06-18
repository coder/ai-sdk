import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import net from "node:net";
import { Readable } from "node:stream";
import { buildRemoteScript, shellQuote } from "./shell.js";
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
  WorkspaceAgentInfo,
  WorkspaceStatus,
} from "./transport.js";

export interface CoderCliTransportOptions {
  /** Path or name of the coder binary. Default: `coder`. */
  coderBinary?: string;
  /**
   * Path or name of the OpenSSH client used for exec/spawn. Default: `ssh`.
   * Exec goes through real OpenSSH (via a `coder ssh --stdio` ProxyCommand)
   * rather than `coder ssh <ws> -- cmd`, because the latter allocates a PTY —
   * which mangles output (CRLF), merges stdout/stderr, and breaks exit-code
   * propagation. `coder ssh`'s own help recommends `coder config-ssh` for full
   * SSH parity; this is the programmatic equivalent.
   */
  sshBinary?: string;
  /** Coder deployment URL; sets `CODER_URL`. Falls back to ambient `coder login`. */
  url?: string;
  /** Coder session token; sets `CODER_SESSION_TOKEN`. Falls back to ambient login. */
  token?: string;
  /** Extra environment merged into every coder/ssh invocation. */
  env?: Record<string, string>;
  /**
   * Run remote commands through a bash *login* shell (`bash -lc`) so PATH and
   * profile-managed toolchains (nvm, asdf, mise, …) resolve. Default: `true`.
   */
  loginShell?: boolean;
  /**
   * Coder startup-script wait behavior for the proxied connection
   * (`coder ssh --wait`). Default `'no'`: programmatic exec should not block on
   * (or stream the logs of) startup scripts. Set `'auto'`/`'yes'` if your
   * workspace provisions required tooling in a blocking startup script.
   */
  waitMode?: "yes" | "no" | "auto";
  /**
   * Redirect the ProxyCommand's own stderr to /dev/null so coder CLI chatter
   * (version-mismatch warnings, startup logs) does not bleed into a command's
   * stderr. Default: `true`. Disable to surface coder connection errors.
   */
  silenceProxyStderr?: boolean;
  /** Timeout (ms) to wait for a port-forward's local endpoint. Default 30000. */
  portForwardTimeoutMs?: number;
}

const DEFAULT_PORT_FORWARD_TIMEOUT_MS = 30_000;

export interface SshArgsOptions {
  coderBinary: string;
  loginShell: boolean;
  waitMode: "yes" | "no" | "auto";
  silenceProxyStderr: boolean;
}

/**
 * Build the OpenSSH argv for running one command in a workspace via a
 * `coder ssh --stdio` ProxyCommand.
 *
 * The remote command is passed as a *single* argument because OpenSSH joins
 * trailing command words with spaces and does not re-quote them — splitting
 * `bash -lc '<script>'` across argv elements would drop the quoting and corrupt
 * the script. Exposed for unit testing.
 */
export function buildSshArgs(
  workspace: string,
  remoteScript: string,
  options: SshArgsOptions,
): string[] {
  const shell = options.loginShell ? "bash -lc" : "bash -c";
  const remoteCommand = `${shell} ${shellQuote(remoteScript)}`;
  const proxy =
    `${shellQuote(options.coderBinary)} ssh --stdio --wait=${options.waitMode} ${shellQuote(workspace)}` +
    (options.silenceProxyStderr ? " 2>/dev/null" : "");
  return [
    "-o",
    `ProxyCommand=${proxy}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-T",
    sshHostAlias(workspace),
    remoteCommand,
  ];
}

/** A stable, ssh-safe host label. The real workspace is fixed in ProxyCommand. */
export function sshHostAlias(workspace: string): string {
  return `coder.${workspace.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/**
 * Build the OpenSSH argv for a local port-forward (`-L`) to a workspace port,
 * tunneled over a `coder ssh --stdio` ProxyCommand. Used instead of
 * `coder port-forward` because SSH local forwarding reliably delivers the
 * server's initial (unprompted) bytes to the first client through a freshly
 * created tunnel — which bridge-backed harness adapters depend on (the bridge
 * sends an unprompted `bridge-hello` immediately after the WebSocket upgrade).
 */
export function buildLocalForwardArgs(
  workspace: string,
  localPort: number,
  remotePort: number,
  options: { coderBinary: string; waitMode: "yes" | "no" | "auto"; silenceProxyStderr: boolean },
): string[] {
  const proxy =
    `${shellQuote(options.coderBinary)} ssh --stdio --wait=${options.waitMode} ${shellQuote(workspace)}` +
    (options.silenceProxyStderr ? " 2>/dev/null" : "");
  return [
    "-o",
    `ProxyCommand=${proxy}`,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    sshHostAlias(workspace),
  ];
}

/**
 * Build the `coder create` argv for a non-interactive workspace creation.
 * `--yes` bypasses confirmation prompts; every required value must be supplied
 * up front (via `parameters`/`parameterFile`/`preset`/`useParameterDefaults`)
 * or the build request errors because it cannot prompt. Exposed for unit tests.
 *
 * Note on precedence: when both a `preset` and explicit `parameters` set the
 * same name, Coder applies the preset's value — pick one per parameter.
 */
export function buildCreateArgs(options: CreateWorkspaceOptions): string[] {
  const args = ["create", options.workspace, "--yes", "--template", options.template];
  if (options.templateVersion !== undefined) {
    args.push("--template-version", options.templateVersion);
  }
  if (options.preset !== undefined) {
    args.push("--preset", options.preset);
  }
  for (const [name, value] of Object.entries(options.parameters ?? {})) {
    args.push("--parameter", `${name}=${value}`);
  }
  if (options.parameterFile !== undefined) {
    args.push("--rich-parameter-file", options.parameterFile);
  }
  if (options.useParameterDefaults) {
    args.push("--use-parameter-defaults");
  }
  for (const [name, value] of Object.entries(options.ephemeralParameters ?? {})) {
    args.push("--ephemeral-parameter", `${name}=${value}`);
  }
  if (options.stopAfter !== undefined) {
    args.push("--stop-after", options.stopAfter);
  }
  if (options.automaticUpdates !== undefined) {
    args.push("--automatic-updates", options.automaticUpdates);
  }
  if (options.org !== undefined) {
    args.push("--org", options.org);
  }
  return args;
}

/** Split a `[owner/]name[.agent]` reference into its parts (owner defaults to `me`). */
export function parseWorkspaceRef(ref: string): { owner: string; name: string } {
  const slashCount = (ref.match(/\//g) ?? []).length;
  if (slashCount > 1) {
    throw new Error(`invalid workspace reference "${ref}"; expected [owner/]name[.agent]`);
  }
  const [ownerOrName, maybeName] = ref.includes("/")
    ? (ref.split("/", 2) as [string, string])
    : (["me", ref] as [string, string]);
  const name = (maybeName ?? ownerOrName).split(".")[0] ?? "";
  if (name === "" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid workspace reference "${ref}"; expected [owner/]name[.agent]`);
  }
  return { owner: ownerOrName === "" ? "me" : ownerOrName, name };
}

/**
 * Parse one workspace object from `coder list -o json` into a
 * {@link WorkspaceStatus}. Tolerant of missing fields. Exposed for unit tests.
 */
export function parseWorkspaceStatus(workspace: unknown): WorkspaceStatus {
  const ws = asRecord(workspace);
  const build = asRecord(ws.latest_build);
  const resources = Array.isArray(build.resources) ? build.resources : [];
  const agents: WorkspaceAgentInfo[] = [];
  for (const resource of resources) {
    const list = asRecord(resource).agents;
    if (!Array.isArray(list)) continue;
    for (const agent of list) {
      const a = asRecord(agent);
      agents.push({
        name: typeof a.name === "string" ? a.name : "",
        status: typeof a.status === "string" ? a.status : "connecting",
        lifecycleState: typeof a.lifecycle_state === "string" ? a.lifecycle_state : "created",
      });
    }
  }
  return {
    name: typeof ws.name === "string" ? ws.name : "",
    buildStatus: typeof build.status === "string" ? build.status : "pending",
    transition: typeof build.transition === "string" ? build.transition : "start",
    agents,
  };
}

/**
 * Parse the raw stdout of `coder templates presets list -o json`. A template
 * with no presets prints a human message ("No presets found …") to stdout even
 * under `-o json`, rather than `[]`; treat that (and empty output) as no
 * presets. Exposed for unit tests.
 */
export function parsePresetsOutput(stdout: string): PresetInfo[] {
  const trimmed = stdout.trim();
  if (trimmed === "" || /^no presets found/i.test(trimmed)) return [];
  return parsePresetList(JSON.parse(trimmed));
}

/**
 * Parse already-decoded `coder templates presets list -o json` JSON. The CLI
 * serializes the codersdk struct with PascalCase keys, each wrapped under
 * `TemplatePreset`; this reader also tolerates a flat / snake_case shape from
 * other code paths. Exposed for unit tests.
 */
export function parsePresetList(json: unknown): PresetInfo[] {
  if (!Array.isArray(json)) return [];
  return json.map((entry) => {
    const record = asRecord(entry);
    const preset = asRecord(record.TemplatePreset ?? record);
    const name = pickString(preset, "Name", "name") ?? "";
    const description = pickString(preset, "Description", "description");
    return {
      name,
      default: pickBoolean(preset, "Default", "default") ?? false,
      ...(description !== undefined && description !== "" ? { description } : {}),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

/**
 * Default {@link CoderTransport}. Exec/spawn use OpenSSH via a
 * `coder ssh --stdio` ProxyCommand; port-forward and lifecycle use the `coder`
 * CLI directly.
 */
export class CoderCliTransport implements CoderTransport {
  readonly #coderBinary: string;
  readonly #sshBinary: string;
  readonly #url?: string;
  readonly #token?: string;
  readonly #extraEnv: Record<string, string>;
  readonly #loginShell: boolean;
  readonly #waitMode: "yes" | "no" | "auto";
  readonly #silenceProxyStderr: boolean;
  readonly #portForwardTimeoutMs: number;

  constructor(options: CoderCliTransportOptions = {}) {
    this.#coderBinary = options.coderBinary ?? "coder";
    this.#sshBinary = options.sshBinary ?? "ssh";
    this.#url = options.url;
    this.#token = options.token;
    this.#extraEnv = options.env ?? {};
    this.#loginShell = options.loginShell ?? true;
    this.#waitMode = options.waitMode ?? "no";
    this.#silenceProxyStderr = options.silenceProxyStderr ?? true;
    this.#portForwardTimeoutMs = options.portForwardTimeoutMs ?? DEFAULT_PORT_FORWARD_TIMEOUT_MS;
  }

  #childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.#url ? { CODER_URL: this.#url } : {}),
      ...(this.#token ? { CODER_SESSION_TOKEN: this.#token } : {}),
      ...this.#extraEnv,
    };
  }

  #sshArgs(options: TransportExecOptions): string[] {
    const script = buildRemoteScript({
      command: options.command,
      workingDirectory: options.workingDirectory,
      env: options.env,
    });
    return buildSshArgs(options.workspace, script, {
      coderBinary: this.#coderBinary,
      loginShell: this.#loginShell,
      waitMode: this.#waitMode,
      silenceProxyStderr: this.#silenceProxyStderr,
    });
  }

  exec(options: TransportExecOptions): Promise<ExecResult> {
    return this.#run(this.#sshBinary, this.#sshArgs(options), {
      stdin: options.stdin,
      abortSignal: options.abortSignal,
    });
  }

  spawn(options: TransportExecOptions): SpawnedProcess {
    const child = nodeSpawn(this.#sshBinary, this.#sshArgs(options), {
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env: this.#childEnv(),
      signal: options.abortSignal,
    });
    writeStdin(child, options.stdin);
    return toSpawnedProcess(child, this.#sshBinary, options.abortSignal);
  }

  async forwardPort(options: ForwardPortOptions): Promise<PortForward> {
    const localPort = await allocateLocalPort();
    const child = nodeSpawn(
      this.#sshBinary,
      buildLocalForwardArgs(options.workspace, localPort, options.remotePort, {
        coderBinary: this.#coderBinary,
        waitMode: this.#waitMode,
        silenceProxyStderr: this.#silenceProxyStderr,
      }),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#childEnv(),
        signal: options.abortSignal,
      },
    );

    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    child.once("error", () => {
      closed = true;
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    child.stderr?.on("data", onStderr);

    try {
      await waitForLocalPort(localPort, child, this.#portForwardTimeoutMs, options.abortSignal);
    } catch (error) {
      child.kill("SIGTERM");
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "EACCES") {
        throw describeSpawnError(error, this.#sshBinary);
      }
      const detail = stderr.trim();
      throw new Error(
        `ssh -L forward (${options.workspace} :${options.remotePort}) failed to become ready` +
          (detail ? `: ${detail}` : ""),
        { cause: error },
      );
    }
    // Readiness done: stop buffering stderr for the tunnel's remaining lifetime.
    child.stderr?.off("data", onStderr);

    return {
      localHost: "127.0.0.1",
      localPort,
      get closed() {
        return closed;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        child.kill("SIGTERM");
      },
    };
  }

  async start(workspace: string, options?: LifecycleOptions): Promise<void> {
    await this.#runLifecycle(["start", workspace, "--yes"], workspace, "start", options);
  }

  async stop(workspace: string, options?: LifecycleOptions): Promise<void> {
    await this.#runLifecycle(["stop", workspace, "--yes"], workspace, "stop", options);
  }

  async destroy(workspace: string, options?: LifecycleOptions): Promise<void> {
    await this.#runLifecycle(["delete", workspace, "--yes"], workspace, "delete", options);
  }

  async status(workspace: string, options?: LifecycleOptions): Promise<WorkspaceStatus | null> {
    const { owner, name } = parseWorkspaceRef(workspace);
    const result = await this.#run(
      this.#coderBinary,
      ["list", "--output", "json", "--search", `owner:${owner} name:${name}`],
      { abortSignal: options?.abortSignal },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `coder list (${workspace}) failed (exit ${result.exitCode}): ${(
          result.stderr || result.stdout
        ).trim()}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`coder list (${workspace}) returned invalid JSON`, { cause: error });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parseWorkspaceStatus(parsed[0]);
  }

  async create(options: CreateWorkspaceOptions): Promise<void> {
    const result = await this.#run(this.#coderBinary, buildCreateArgs(options), {
      abortSignal: options.abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `coder create ${options.workspace} (template ${options.template}) failed ` +
          `(exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
  }

  async listPresets(options: ListPresetsOptions): Promise<PresetInfo[]> {
    const args = ["templates", "presets", "list", options.template, "--output", "json"];
    if (options.templateVersion !== undefined) {
      args.push("--template-version", options.templateVersion);
    }
    if (options.org !== undefined) {
      args.push("--org", options.org);
    }
    const result = await this.#run(this.#coderBinary, args, {
      abortSignal: options.abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `coder templates presets list ${options.template} failed (exit ${result.exitCode}): ${(
          result.stderr || result.stdout
        ).trim()}`,
      );
    }
    try {
      return parsePresetsOutput(result.stdout);
    } catch (error) {
      throw new Error(
        `coder templates presets list ${options.template} returned invalid JSON: ` +
          result.stdout.trim().slice(0, 120),
        { cause: error },
      );
    }
  }

  async #runLifecycle(
    args: string[],
    workspace: string,
    verb: string,
    options?: LifecycleOptions,
  ): Promise<void> {
    const result = await this.#run(this.#coderBinary, args, {
      abortSignal: options?.abortSignal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `coder ${verb} ${workspace} failed (exit ${result.exitCode}): ${(
          result.stderr || result.stdout
        ).trim()}`,
      );
    }
  }

  #run(
    binary: string,
    args: string[],
    options: { stdin?: Uint8Array | string; abortSignal?: AbortSignal },
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = nodeSpawn(binary, args, {
        stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        env: this.#childEnv(),
        signal: options.abortSignal,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => reject(describeSpawnError(error, binary)));
      child.on("close", (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });

      writeStdin(child, options.stdin);
    });
  }
}

/**
 * Turn a spawn failure for a missing/non-executable binary (ENOENT/EACCES) into
 * an actionable error naming the binary and how to fix it; pass other errors
 * through unchanged.
 */
function describeSpawnError(error: unknown, binary: string): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "EACCES") {
    return new Error(
      `failed to launch "${binary}": ${code === "ENOENT" ? "not found on PATH" : "not executable"}. ` +
        `Install the Coder CLI (https://coder.com/docs/install) and run \`coder login\`, ensure an OpenSSH ` +
        `client is on PATH, or set explicit paths via new CoderCliTransport({ coderBinary, sshBinary }).`,
      { cause: error as Error },
    );
  }
  return error as Error;
}

function writeStdin(child: ChildProcess, stdin?: Uint8Array | string): void {
  if (stdin === undefined || child.stdin === null) return;
  // Swallow EPIPE if the process exits before consuming stdin.
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
}

function toSpawnedProcess(
  child: ChildProcess,
  binary: string,
  abortSignal?: AbortSignal,
): SpawnedProcess {
  const stdout = nodeReadableToWebStream(child.stdout);
  const stderr = nodeReadableToWebStream(child.stderr);

  let settled = false;
  const wait = new Promise<{ exitCode: number }>((resolve, reject) => {
    const onError = (error: Error) => finish(() => reject(describeSpawnError(error, binary)));
    const onClose = (code: number | null) => finish(() => resolve({ exitCode: code ?? 0 }));
    const onAbort = () => finish(() => reject(abortSignal?.reason ?? new Error("aborted")));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("close", onClose);
      abortSignal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", onError);
    child.on("close", onClose);
    if (abortSignal) {
      if (abortSignal.aborted) {
        finish(() => reject(abortSignal.reason ?? new Error("aborted")));
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });

  return {
    pid: child.pid,
    stdout,
    stderr,
    wait: () => wait,
    kill: async () => {
      child.kill("SIGTERM");
    },
  };
}

function nodeReadableToWebStream(readable: Readable | null): ReadableStream<Uint8Array> {
  if (readable === null) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  return Readable.toWeb(readable);
}

/** Reserve an ephemeral local TCP port by binding then releasing it. */
function allocateLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) reject(new Error("failed to allocate a local port"));
        else resolve(port);
      });
    });
  });
}

/** Poll until the local port accepts a TCP connection, or fail. */
function waitForLocalPort(
  port: number,
  child: ChildProcess,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      child.off("close", onClose);
      child.off("error", onError);
      abortSignal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onClose = (code: number | null) =>
      settle(() => reject(new Error(`ssh -L forward exited early (code ${code ?? "null"})`)));
    const onError = (error: Error) => settle(() => reject(error));
    const onAbort = () => settle(() => reject(abortSignal?.reason ?? new Error("aborted")));

    child.on("close", onClose);
    child.on("error", onError);
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const attempt = () => {
      if (done) return;
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        settle(resolve);
      });
      socket.once("error", () => {
        socket.destroy();
        if (done) return;
        if (Date.now() > deadline) {
          settle(() => reject(new Error(`timed out waiting for local port ${port}`)));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}
