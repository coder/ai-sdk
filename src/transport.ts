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
  /** Tear down the forward. Idempotent. */
  close(): Promise<void>;
}

export interface LifecycleOptions {
  abortSignal?: AbortSignal;
}
