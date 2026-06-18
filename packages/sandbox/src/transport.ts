/**
 * Transport abstraction over a Coder workspace. The sandbox session talks to a
 * workspace exclusively through this interface, which keeps the harness-facing
 * session decoupled from *how* we reach Coder (the default is the `coder` CLI;
 * tests inject a mock, and a future implementation could use the Coder REST API
 * or a persistent SSH/SFTP connection).
 */
export interface CoderTransport {
  /** Run a command to completion, buffering stdout/stderr into strings. */
  exec(options: TransportExecOptions): Promise<ExecResult>;
  /** Start a long-running process and return streaming handles immediately. */
  spawn(options: TransportExecOptions): SpawnedProcess;
  /**
   * Open a TCP port-forward from the host to a port inside the workspace and
   * resolve once the local endpoint accepts connections.
   */
  forwardPort(options: ForwardPortOptions): Promise<PortForward>;
  /** Ensure the workspace is started. Should be idempotent. */
  start(workspace: string, options?: LifecycleOptions): Promise<void>;
  /** Stop the workspace. Should be idempotent. */
  stop(workspace: string, options?: LifecycleOptions): Promise<void>;
  /** Delete the workspace. Must tolerate an already-stopped workspace. */
  destroy(workspace: string, options?: LifecycleOptions): Promise<void>;
  /**
   * Look up a workspace's current status, or `null` if it does not exist. Used
   * for get-or-create and for polling readiness after a create/start.
   */
  status(workspace: string, options?: LifecycleOptions): Promise<WorkspaceStatus | null>;
  /**
   * Create a workspace from a template. Resolves once the provisioner build
   * completes (which is *not* the same as the agent being ready — poll
   * {@link CoderTransport.status} for that).
   */
  create(options: CreateWorkspaceOptions): Promise<void>;
  /**
   * List the presets defined for a template (optionally a specific version).
   * Used for preflight validation of a requested preset name.
   */
  listPresets(options: ListPresetsOptions): Promise<PresetInfo[]>;
}

/**
 * Workspace-level build status (`latest_build.status` in the Coder API) — the
 * computed state of the workspace, not the raw provisioner-job status. A fully
 * started workspace reports `'running'`.
 *
 * The trailing `string & Record<never, never>` arm accepts statuses from newer
 * Coder versions while preserving editor autocomplete for the known values (the
 * same idiom is used by the other status unions below).
 */
export type WorkspaceBuildStatus =
  | "pending"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "canceling"
  | "canceled"
  | "deleting"
  | "deleted"
  | (string & Record<never, never>);

/** Connectivity of a workspace agent (`agent.status`). */
export type WorkspaceAgentStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "timeout"
  | (string & Record<never, never>);

/** Startup-script lifecycle of a workspace agent (`agent.lifecycle_state`). */
export type WorkspaceAgentLifecycle =
  | "created"
  | "starting"
  | "start_timeout"
  | "start_error"
  | "ready"
  | "shutting_down"
  | "shutdown_timeout"
  | "shutdown_error"
  | "off"
  | (string & Record<never, never>);

export interface WorkspaceAgentInfo {
  /** Agent name (e.g. `main`). */
  name: string;
  /** Connectivity to the control plane. */
  status: WorkspaceAgentStatus;
  /** Startup-script progress; `'ready'` means the startup script finished. */
  lifecycleState: WorkspaceAgentLifecycle;
}

export interface WorkspaceStatus {
  /** Workspace name (without owner/agent qualifiers). */
  name: string;
  /** Workspace-level build status (`latest_build.status`). */
  buildStatus: WorkspaceBuildStatus;
  /** Direction of the latest build: `'start' | 'stop' | 'delete'`. */
  transition: "start" | "stop" | "delete" | (string & Record<never, never>);
  /** Agents across the latest build's resources. */
  agents: WorkspaceAgentInfo[];
}

export interface CreateWorkspaceOptions {
  /** Workspace name to create, optionally `owner/name`. */
  workspace: string;
  /** Template name to create from. */
  template: string;
  /** Specific template version name; defaults to the template's active version. */
  templateVersion?: string;
  /** Named preset to apply (`--preset`); `'none'` forces no preset. */
  preset?: string;
  /** Rich parameter values, already stringified (`--parameter name=value`). */
  parameters?: Record<string, string>;
  /** Path to a YAML rich-parameter file (`--rich-parameter-file`). */
  parameterFile?: string;
  /** Accept template defaults for any parameter not otherwise provided. */
  useParameterDefaults?: boolean;
  /** Ephemeral (one-time build) parameter values, already stringified. */
  ephemeralParameters?: Record<string, string>;
  /** Auto-stop the workspace after this duration, e.g. `'8h'` (`--stop-after`). */
  stopAfter?: string;
  /** `--automatic-updates` setting. */
  automaticUpdates?: "always" | "never";
  /** Organization name or uuid for ambiguous template names (`--org`). */
  org?: string;
  abortSignal?: AbortSignal;
}

export interface ListPresetsOptions {
  template: string;
  templateVersion?: string;
  org?: string;
  abortSignal?: AbortSignal;
}

export interface PresetInfo {
  name: string;
  /** Whether the template author marked this as the default preset. */
  default: boolean;
  description?: string;
}

export interface TransportExecOptions {
  /** Workspace reference: `[owner/]workspace[.agent]`. */
  workspace: string;
  /** Command to run, as a shell string executed by bash inside the workspace. */
  command: string;
  /** Absolute working directory to run in. */
  workingDirectory?: string;
  /** Environment variables to set for the command (remote-side). */
  env?: Record<string, string>;
  /** Payload written to the command's stdin, then closed. */
  stdin?: Uint8Array | string;
  abortSignal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Handle to a spawned process. Structurally compatible with the AI SDK's
 * `Experimental_SandboxProcess`, so the session can return it directly.
 */
export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface ForwardPortOptions {
  workspace: string;
  /** Port inside the workspace to forward to. */
  remotePort: number;
  abortSignal?: AbortSignal;
}

export interface PortForward {
  /** Host interface the forward listens on (typically `127.0.0.1`). */
  readonly localHost: string;
  /** Host port that tunnels to the workspace's `remotePort`. */
  readonly localPort: number;
  /**
   * `true` once the underlying tunnel process has exited or errored. Consumers
   * read this to detect a dead tunnel and re-establish the forward.
   */
  readonly closed: boolean;
  /** Tear down the forward. Idempotent. */
  close(): Promise<void>;
}

export interface LifecycleOptions {
  abortSignal?: AbortSignal;
}
