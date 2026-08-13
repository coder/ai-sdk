import { randomUUID } from "node:crypto";
import net from "node:net";
import WebSocket, { type RawData } from "ws";
import type { CoderApiClient } from "./native-api.js";
import { shellQuote } from "./shell.js";
import type {
  ForwardPortOptions,
  PortForward,
  SpawnedProcess,
  TransportExecOptions,
} from "./transport.js";

const RELAY_PROTOCOL_VERSION = 1;
export const NATIVE_RELAY_BOOTSTRAP_MARKER = "__CODER_AI_SDK_RELAY_BOOTSTRAP_READY_V1__";

/**
 * Dependency-free relay executed inside the workspace. It deliberately emits
 * only newline-delimited protocol frames on stdout; child output is carried as
 * base64 fields so the surrounding PTY never gets a chance to transform it.
 *
 * Exported for protocol-level tests, but not re-exported from the package.
 */
export const NATIVE_RELAY_SOURCE = String.raw`'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const processes = new Map();
const discardedProcessOutputs = new Map();
const sockets = new Map();
const signalNumbers = os.constants.signals;
function resolveExecutable(name) {
  for (const directory of String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
    const candidate = path.resolve(directory || '.', name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  return name;
}
const bashPath = resolveExecutable('bash');
function emit(message) {
  process.stdout.write(JSON.stringify(Object.assign({ v: 1 }, message)) + '\n');
}
function bytes(value) {
  return Buffer.from(value || '', 'base64');
}
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function commandScript(message) {
  const directory = message.cwd ? 'cd ' + shellQuote(message.cwd) + ' && ' : '';
  const entries = Object.entries(message.env || {});
  if (entries.length === 0) return directory + message.command;
  const assignments = entries.map(([key, value]) => shellQuote(key + '=' + String(value))).join(' ');
  return directory + 'exec env ' + assignments + ' ' + shellQuote(bashPath) + ' -c ' + shellQuote(message.command);
}
function processExitCode(code, signal) {
  if (typeof code === 'number') return code;
  return 128 + (signalNumbers[signal] || 0);
}
function start(message) {
  if (processes.has(message.id)) {
    emit({ type: 'proc-error', id: message.id, message: 'duplicate process id' });
    return;
  }
  const args = [message.loginShell === false ? '-c' : '-lc', commandScript(message)];
  let child;
  try {
    child = childProcess.spawn(bashPath, args, {
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    emit({ type: 'proc-error', id: message.id, message: String(error && error.message || error) });
    return;
  }
  const discardedOutputs = new Set();
  processes.set(message.id, child);
  discardedProcessOutputs.set(message.id, discardedOutputs);
  child.once('spawn', () => emit({ type: 'started', id: message.id, pid: child.pid }));
  child.stdout.on('data', (data) => {
    if (!discardedOutputs.has('stdout')) emit({ type: 'stdout', id: message.id, data: data.toString('base64') });
  });
  child.stderr.on('data', (data) => {
    if (!discardedOutputs.has('stderr')) emit({ type: 'stderr', id: message.id, data: data.toString('base64') });
  });
  child.once('error', (error) => {
    processes.delete(message.id);
    discardedProcessOutputs.delete(message.id);
    emit({ type: 'proc-error', id: message.id, message: String(error && error.message || error) });
  });
  child.once('close', (code, signal) => {
    if (!processes.delete(message.id)) return;
    discardedProcessOutputs.delete(message.id);
    emit({ type: 'exit', id: message.id, code: processExitCode(code, signal), signal: signal || undefined });
  });
  if (message.stdin) child.stdin.write(bytes(message.stdin));
  child.stdin.end();
}
function terminate(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (_) {
    try { child.kill(signal); } catch (_) {}
  }
}
function kill(message) {
  terminate(processes.get(message.id), message.signal || 'SIGTERM');
}
function tcpOpen(message) {
  if (sockets.has(message.id)) {
    emit({ type: 'tcp-error', id: message.id, message: 'duplicate socket id' });
    return;
  }
  let socket;
  try { socket = net.createConnection({ host: '127.0.0.1', port: message.port, allowHalfOpen: true }); }
  catch (error) {
    emit({ type: 'tcp-error', id: message.id, message: String(error && error.message || error) });
    emit({ type: 'tcp-close', id: message.id });
    return;
  }
  sockets.set(message.id, socket);
  socket.once('connect', () => emit({ type: 'tcp-opened', id: message.id }));
  socket.on('data', (data) => emit({ type: 'tcp-data', id: message.id, data: data.toString('base64') }));
  socket.on('drain', () => emit({ type: 'tcp-resume', id: message.id }));
  socket.once('end', () => emit({ type: 'tcp-end', id: message.id }));
  socket.once('error', (error) => emit({ type: 'tcp-error', id: message.id, message: String(error && error.message || error) }));
  socket.once('close', () => {
    sockets.delete(message.id);
    emit({ type: 'tcp-close', id: message.id });
  });
}
function receive(line) {
  if (!line) return;
  let message;
  try { message = JSON.parse(line); }
  catch (error) { emit({ type: 'error', message: 'invalid JSON: ' + String(error && error.message || error) }); return; }
  if (message.v !== 1) { emit({ type: 'error', message: 'unsupported protocol version' }); return; }
  switch (message.type) {
    case 'start': start(message); break;
    case 'kill': kill(message); break;
    case 'proc-pause': {
      const child = processes.get(message.id);
      const stream = message.stream === 'stdout' ? child && child.stdout : message.stream === 'stderr' ? child && child.stderr : undefined;
      if (stream) stream.pause();
      break;
    }
    case 'proc-resume': {
      const child = processes.get(message.id);
      const stream = message.stream === 'stdout' ? child && child.stdout : message.stream === 'stderr' ? child && child.stderr : undefined;
      if (stream) stream.resume();
      break;
    }
    case 'proc-discard': {
      const child = processes.get(message.id);
      const discardedOutputs = discardedProcessOutputs.get(message.id);
      const stream = message.stream === 'stdout' ? child && child.stdout : message.stream === 'stderr' ? child && child.stderr : undefined;
      if (stream && discardedOutputs) { discardedOutputs.add(message.stream); stream.resume(); }
      break;
    }
    case 'tcp-open': tcpOpen(message); break;
    case 'tcp-data': {
      const socket = sockets.get(message.id);
      if (socket && !socket.write(bytes(message.data))) emit({ type: 'tcp-pause', id: message.id });
      break;
    }
    case 'tcp-end': { const socket = sockets.get(message.id); if (socket) socket.end(); break; }
    case 'tcp-close': { const socket = sockets.get(message.id); if (socket) socket.destroy(); break; }
    case 'tcp-pause': { const socket = sockets.get(message.id); if (socket) socket.pause(); break; }
    case 'tcp-resume': { const socket = sockets.get(message.id); if (socket) socket.resume(); break; }
    case 'ping': emit({ type: 'pong' }); break;
    default: emit({ type: 'error', id: message.id, message: 'unknown message type: ' + message.type });
  }
}
let shuttingDown = false;
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes.values()) terminate(child, 'SIGTERM');
  for (const socket of sockets.values()) socket.destroy();
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on('line', receive);
input.once('close', () => { cleanup(); process.exit(0); });
for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.once(signal, () => { cleanup(); process.exit(processExitCode(null, signal)); });
}
process.once('exit', cleanup);
emit({ type: 'ready', protocol: 1, pid: process.pid });
`;

interface RelayMessage {
  v?: number;
  type?: string;
  id?: string;
  pid?: number;
  code?: number;
  signal?: string;
  data?: string;
  message?: string;
}

interface ProcessSink {
  onStarted(pid: number): void;
  onStdout(data: Uint8Array): void;
  onStderr(data: Uint8Array): void;
  onExit(code: number): void;
  onError(error: Error): void;
}

type ProcessOutput = "stdout" | "stderr";

interface TcpSink {
  opened(): void;
  data(data: Uint8Array): void;
  end(): void;
  pause(): void;
  resume(): void;
  close(): void;
  error(error: Error): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export interface NativeRelayConnectOptions {
  api: CoderApiClient;
  agentId: string;
  nodeCommand: string;
  connectTimeoutMs: number;
  signal?: AbortSignal;
}

export class NativeRelay {
  readonly #websocket: WebSocket;
  readonly #bootstrapReady = deferred<void>();
  readonly #ready = deferred<void>();
  readonly #processes = new Map<string, ProcessSink>();
  readonly #sockets = new Map<string, TcpSink>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  #buffer = "";
  #bootstrapOutput = "";
  #bootstrapReadySeen = false;
  #closed = false;
  #readySeen = false;
  #closeError?: Error;

  private constructor(websocket: WebSocket) {
    this.#websocket = websocket;
    websocket.on("message", (data) => this.#onData(data));
    websocket.on("error", (error) => this.#fail(toError(error)));
    websocket.on("close", (code, reason) => {
      const detail = Buffer.from(reason).toString("utf8");
      this.#fail(
        this.#closeError ??
          new Error(`Coder native relay WebSocket closed (${code})${detail ? `: ${detail}` : ""}`),
      );
    });
  }

  static async connect(options: NativeRelayConnectOptions): Promise<NativeRelay> {
    if (options.signal?.aborted) throw abortError(options.signal);
    const query = new URLSearchParams({
      reconnect: randomUUID(),
      width: "80",
      height: "24",
      command: relayBootstrapCommand(options.nodeCommand),
      backend_type: "buffered",
    });
    const url = options.api.websocketUrl(
      `/api/v2/workspaceagents/${encodeURIComponent(options.agentId)}/pty?${query.toString()}`,
    );
    const websocket = new WebSocket(url, {
      headers: options.api.websocketHeaders(),
      followRedirects: true,
      perMessageDeflate: false,
    });
    const relay = new NativeRelay(websocket);
    const open = deferred<void>();
    const onOpen = () => open.resolve();
    const onError = (error: Error) => open.reject(error);
    websocket.once("open", onOpen);
    websocket.once("error", onError);
    const abort = () => {
      const error = abortError(options.signal);
      open.reject(error);
      relay.#bootstrapReady.reject(error);
      relay.#ready.reject(error);
      websocket.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const error = relay.#connectTimeoutError(options.connectTimeoutMs);
      open.reject(error);
      relay.#bootstrapReady.reject(error);
      relay.#ready.reject(error);
      websocket.close();
    }, options.connectTimeoutMs);
    timer.unref?.();
    try {
      await open.promise;
      websocket.off("error", onError);
      await relay.#bootstrapReady.promise;
      relay.#sendPtyData(`${Buffer.from(NATIVE_RELAY_SOURCE).toString("base64")}\n`);
      await relay.#ready.promise;
      return relay;
    } catch (error) {
      relay.#fail(toError(error));
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  startProcess(
    id: string,
    options: TransportExecOptions,
    sink: ProcessSink,
    loginShell: boolean,
  ): void {
    this.#assertOpen();
    this.#processes.set(id, sink);
    try {
      this.#send({
        type: "start",
        id,
        command: options.command,
        ...(options.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.stdin !== undefined
          ? { stdin: Buffer.from(options.stdin).toString("base64") }
          : {}),
        loginShell,
      });
    } catch (error) {
      this.#processes.delete(id);
      throw error;
    }
  }

  unregisterProcess(id: string): void {
    this.#processes.delete(id);
  }

  killProcess(id: string, signal = "SIGTERM"): void {
    if (this.#closed) return;
    this.#send({ type: "kill", id, signal });
  }

  pauseProcessOutput(id: string, stream: ProcessOutput): void {
    if (this.#closed) return;
    this.#send({ type: "proc-pause", id, stream });
  }

  resumeProcessOutput(id: string, stream: ProcessOutput): void {
    if (this.#closed) return;
    this.#send({ type: "proc-resume", id, stream });
  }

  discardProcessOutput(id: string, stream: ProcessOutput): void {
    if (this.#closed) return;
    this.#send({ type: "proc-discard", id, stream });
  }

  openTcp(id: string, port: number, sink: TcpSink): void {
    this.#assertOpen();
    this.#sockets.set(id, sink);
    try {
      this.#send({ type: "tcp-open", id, port });
    } catch (error) {
      this.#sockets.delete(id);
      throw error;
    }
  }

  tcpData(id: string, data: Uint8Array): void {
    if (this.#closed) return;
    this.#send({ type: "tcp-data", id, data: Buffer.from(data).toString("base64") });
  }

  tcpEnd(id: string): void {
    if (this.#closed) return;
    this.#send({ type: "tcp-end", id });
  }

  pauseTcp(id: string): void {
    if (this.#closed) return;
    this.#send({ type: "tcp-pause", id });
  }

  resumeTcp(id: string): void {
    if (this.#closed) return;
    this.#send({ type: "tcp-resume", id });
  }

  closeTcp(id: string): void {
    const existed = this.#sockets.delete(id);
    if (existed && !this.#closed) this.#send({ type: "tcp-close", id });
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.#closed) {
      queueMicrotask(() => listener(this.#closeError));
      return () => {};
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closeError = new Error("Coder native relay closed");
    this.#websocket.close(1000, "transport closed");
    this.#fail(this.#closeError);
  }

  #send(message: Record<string, unknown>): void {
    this.#sendPtyData(`${JSON.stringify({ v: RELAY_PROTOCOL_VERSION, ...message })}\n`);
  }

  #sendPtyData(data: string): void {
    if (this.#websocket.readyState !== WebSocket.OPEN) {
      throw this.#closeError ?? new Error("Coder native relay WebSocket is not open");
    }
    this.#websocket.send(Buffer.from(JSON.stringify({ data }), "utf8"), { binary: true });
  }

  #assertOpen(): void {
    if (this.#closed || !this.#readySeen) {
      throw this.#closeError ?? new Error("Coder native relay is not open");
    }
  }

  #connectTimeoutError(timeoutMs: number): Error {
    const phase =
      this.#websocket.readyState === WebSocket.CONNECTING
        ? "opening the authenticated PTY WebSocket"
        : !this.#bootstrapReadySeen
          ? "waiting for the remote PTY bootstrap"
          : "starting the workspace relay";
    const output = this.#bootstrapOutput.trim();
    return new Error(
      `timed out after ${timeoutMs}ms ${phase}${output ? `; PTY output: ${output}` : ""}`,
    );
  }

  #onData(data: RawData): void {
    const chunk = rawDataBuffer(data).toString("utf8");
    this.#buffer += chunk;
    if (!this.#bootstrapReadySeen) {
      const marker = this.#buffer.indexOf(NATIVE_RELAY_BOOTSTRAP_MARKER);
      if (marker !== -1) {
        this.#bootstrapOutput = `${this.#bootstrapOutput}${this.#buffer.slice(0, marker)}`.slice(
          -500,
        );
        this.#buffer = this.#buffer.slice(marker + NATIVE_RELAY_BOOTSTRAP_MARKER.length);
        if (this.#buffer.startsWith("\r\n")) this.#buffer = this.#buffer.slice(2);
        else if (this.#buffer.startsWith("\n")) this.#buffer = this.#buffer.slice(1);
        this.#bootstrapReadySeen = true;
        this.#bootstrapReady.resolve();
      }
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      let message: RelayMessage;
      try {
        message = JSON.parse(line) as RelayMessage;
      } catch {
        if (!this.#readySeen) {
          this.#bootstrapOutput = `${this.#bootstrapOutput}${line}\n`.slice(-500);
          continue;
        }
        this.#fail(new Error(`invalid data from Coder native relay: ${line.slice(0, 200)}`));
        return;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: RelayMessage): void {
    if (message.v !== RELAY_PROTOCOL_VERSION || typeof message.type !== "string") {
      this.#fail(new Error("Coder native relay returned an unsupported protocol frame"));
      return;
    }
    if (message.type === "ready") {
      if (message.pid === undefined) {
        this.#ready.reject(new Error("Coder native relay ready frame had no pid"));
        return;
      }
      this.#readySeen = true;
      this.#ready.resolve();
      return;
    }
    if (message.type === "error" && message.id === undefined) {
      this.#fail(new Error(`Coder native relay error: ${message.message ?? "unknown error"}`));
      return;
    }
    if (message.id === undefined) return;
    const process = this.#processes.get(message.id);
    if (process !== undefined) {
      switch (message.type) {
        case "started":
          if (message.pid !== undefined) process.onStarted(message.pid);
          break;
        case "stdout":
          process.onStdout(Buffer.from(message.data ?? "", "base64"));
          break;
        case "stderr":
          process.onStderr(Buffer.from(message.data ?? "", "base64"));
          break;
        case "exit":
          this.#processes.delete(message.id);
          process.onExit(message.code ?? 1);
          break;
        case "proc-error":
          this.#processes.delete(message.id);
          process.onError(new Error(message.message ?? "workspace process failed"));
          break;
      }
      return;
    }
    const socket = this.#sockets.get(message.id);
    if (socket === undefined) return;
    switch (message.type) {
      case "tcp-opened":
        socket.opened();
        break;
      case "tcp-data":
        socket.data(Buffer.from(message.data ?? "", "base64"));
        break;
      case "tcp-end":
        socket.end();
        break;
      case "tcp-pause":
        socket.pause();
        break;
      case "tcp-resume":
        socket.resume();
        break;
      case "tcp-close":
        this.#sockets.delete(message.id);
        socket.close();
        break;
      case "tcp-error":
        socket.error(new Error(message.message ?? "workspace TCP connection failed"));
        break;
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    this.#bootstrapReady.reject(error);
    this.#ready.reject(error);
    for (const process of this.#processes.values()) process.onError(error);
    this.#processes.clear();
    for (const socket of this.#sockets.values()) socket.error(error);
    this.#sockets.clear();
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
    if (
      this.#websocket.readyState === WebSocket.CONNECTING ||
      this.#websocket.readyState === WebSocket.OPEN
    ) {
      this.#websocket.close();
    }
  }
}

export class NativeSpawnedProcess implements SpawnedProcess, ProcessSink {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly #id = randomUUID();
  readonly #completion = deferred<{ exitCode: number }>();
  readonly #started: Promise<void>;
  readonly #abortSignal?: AbortSignal;
  readonly #onAbort: () => void;
  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #stderrController!: ReadableStreamDefaultController<Uint8Array>;
  #relay?: NativeRelay;
  #pid?: number;
  #settled = false;
  #stdoutCanceled = false;
  #stderrCanceled = false;
  #stdoutPaused = false;
  #stderrPaused = false;

  constructor(relay: Promise<NativeRelay>, options: TransportExecOptions, loginShell: boolean) {
    this.stdout = new ReadableStream({
      start: (controller) => {
        this.#stdoutController = controller;
      },
      pull: () => this.#resumeOutput("stdout"),
      cancel: () => this.#cancelOutput("stdout"),
    });
    this.stderr = new ReadableStream({
      start: (controller) => {
        this.#stderrController = controller;
      },
      pull: () => this.#resumeOutput("stderr"),
      cancel: () => this.#cancelOutput("stderr"),
    });
    this.#abortSignal = options.abortSignal;
    this.#onAbort = () => {
      const error = abortError(this.#abortSignal);
      this.#relay?.killProcess(this.#id);
      this.onError(error);
    };
    this.#abortSignal?.addEventListener("abort", this.#onAbort, { once: true });
    if (this.#abortSignal?.aborted) this.#onAbort();
    this.#started = relay
      .then((connected) => {
        if (this.#settled) return;
        this.#relay = connected;
        connected.startProcess(this.#id, options, this, loginShell);
        if (this.#stdoutCanceled) connected.discardProcessOutput(this.#id, "stdout");
        if (this.#stderrCanceled) connected.discardProcessOutput(this.#id, "stderr");
      })
      .catch((error: unknown) => this.onError(toError(error)));
  }

  get pid(): number | undefined {
    return this.#pid;
  }

  onStarted(pid: number): void {
    this.#pid = pid;
  }

  onStdout(data: Uint8Array): void {
    this.#enqueueOutput("stdout", data);
  }

  onStderr(data: Uint8Array): void {
    this.#enqueueOutput("stderr", data);
  }

  onExit(code: number): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanup();
    if (!this.#stdoutCanceled) this.#stdoutController.close();
    if (!this.#stderrCanceled) this.#stderrController.close();
    this.#completion.resolve({ exitCode: code });
  }

  onError(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#cleanup();
    if (!this.#stdoutCanceled) this.#stdoutController.error(error);
    if (!this.#stderrCanceled) this.#stderrController.error(error);
    this.#completion.reject(error);
  }

  wait(): Promise<{ exitCode: number }> {
    return this.#completion.promise;
  }

  async kill(): Promise<void> {
    if (this.#settled) return;
    await this.#started;
    this.#relay?.killProcess(this.#id);
  }

  #enqueueOutput(stream: ProcessOutput, data: Uint8Array): void {
    if (this.#settled || this.#outputCanceled(stream)) return;
    const controller = stream === "stdout" ? this.#stdoutController : this.#stderrController;
    controller.enqueue(data);
    if ((controller.desiredSize ?? 0) > 0) return;
    if (stream === "stdout") {
      if (this.#stdoutPaused) return;
      this.#stdoutPaused = true;
    } else {
      if (this.#stderrPaused) return;
      this.#stderrPaused = true;
    }
    this.#relay?.pauseProcessOutput(this.#id, stream);
  }

  #resumeOutput(stream: ProcessOutput): void {
    if (this.#settled || this.#outputCanceled(stream)) return;
    if (stream === "stdout") {
      if (!this.#stdoutPaused) return;
      this.#stdoutPaused = false;
    } else {
      if (!this.#stderrPaused) return;
      this.#stderrPaused = false;
    }
    this.#relay?.resumeProcessOutput(this.#id, stream);
  }

  #cancelOutput(stream: ProcessOutput): void {
    if (this.#settled || this.#outputCanceled(stream)) return;
    if (stream === "stdout") {
      this.#stdoutCanceled = true;
      this.#stdoutPaused = false;
    } else {
      this.#stderrCanceled = true;
      this.#stderrPaused = false;
    }
    this.#relay?.discardProcessOutput(this.#id, stream);
  }

  #outputCanceled(stream: ProcessOutput): boolean {
    return stream === "stdout" ? this.#stdoutCanceled : this.#stderrCanceled;
  }

  #cleanup(): void {
    this.#abortSignal?.removeEventListener("abort", this.#onAbort);
    this.#relay?.unregisterProcess(this.#id);
  }
}

export async function openNativePortForward(
  relay: NativeRelay,
  options: ForwardPortOptions,
): Promise<PortForward> {
  const server = net.createServer({ allowHalfOpen: true });
  const sockets = new Set<net.Socket>();
  let closed = false;
  let rejectPendingBind: ((error: Error) => void) | undefined;
  const closeForward = (): void => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server.listening) server.close();
    else server.once("listening", () => server.close());
  };
  const removeCloseListener = relay.onClose(closeForward);
  server.on("error", closeForward);
  server.on("connection", (socket) => {
    const id = randomUUID();
    sockets.add(socket);
    socket.pause();
    let remoteClosed = false;
    let remoteEnded = false;
    let remotePaused = false;
    const closeRemote = () => {
      if (remoteClosed) return;
      remoteClosed = true;
      relay.closeTcp(id);
    };
    socket.on("data", (data) => relay.tcpData(id, data));
    socket.on("end", () => relay.tcpEnd(id));
    socket.on("drain", () => {
      if (remoteClosed || !remotePaused) return;
      remotePaused = false;
      relay.resumeTcp(id);
    });
    socket.on("close", () => {
      sockets.delete(socket);
      closeRemote();
    });
    socket.on("error", closeRemote);
    try {
      relay.openTcp(id, options.remotePort, {
        opened: () => socket.resume(),
        data: (data) => {
          if (!socket.destroyed && !socket.write(data) && !remotePaused) {
            remotePaused = true;
            relay.pauseTcp(id);
          }
        },
        end: () => {
          remoteEnded = true;
          socket.end();
        },
        pause: () => socket.pause(),
        resume: () => {
          if (!socket.destroyed) socket.resume();
        },
        close: () => {
          remoteClosed = true;
          if (!remoteEnded && !socket.destroyed) socket.destroy();
        },
        error: (error) => {
          remoteClosed = true;
          socket.destroy(error);
        },
      });
    } catch (error) {
      socket.destroy(toError(error));
    }
  });
  const onAbort = () => {
    removeCloseListener();
    rejectPendingBind?.(abortError(options.abortSignal));
    closeForward();
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted) {
    removeCloseListener();
    throw abortError(options.abortSignal);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        rejectPendingBind = undefined;
        reject(error);
      };
      rejectPendingBind = (error) => {
        server.off("error", onError);
        rejectPendingBind = undefined;
        reject(error);
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        rejectPendingBind = undefined;
        resolve();
      });
    });
  } catch (error) {
    closeForward();
    removeCloseListener();
    options.abortSignal?.removeEventListener("abort", onAbort);
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    closeForward();
    removeCloseListener();
    throw new Error("failed to allocate a local port for the Coder native forward");
  }
  return {
    localHost: "127.0.0.1",
    localPort: address.port,
    get closed() {
      return closed || relay.closed;
    },
    close: async () => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      removeCloseListener();
      closeForward();
    },
  };
}

function relayBootstrapCommand(nodeCommand: string): string {
  const script =
    "stty raw -echo; " +
    `printf '%s\\n' ${shellQuote(NATIVE_RELAY_BOOTSTRAP_MARKER)}; ` +
    "IFS= read -r CODER_AI_SDK_RELAY_PAYLOAD; " +
    `exec ${shellQuote(nodeCommand)} -e "$(printf %s "$CODER_AI_SDK_RELAY_PAYLOAD" | base64 -d)"`;
  return `exec bash -lc ${shellQuote(script)}`;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
