import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeRelay,
  NATIVE_RELAY_SOURCE,
  NativeSpawnedProcess,
  openNativePortForward,
} from "../src/native-relay.js";
import { shellQuote } from "../src/shell.js";

interface Message {
  v?: number;
  type?: string;
  id?: string;
  pid?: number;
  code?: number;
  data?: string;
  message?: string;
}

class RelayHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: Message[] = [];
  readonly waiters = new Set<() => void>();
  #buffer = "";

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(process.execPath, ["-e", NATIVE_RELAY_SOURCE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline === -1) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(JSON.parse(line) as Message);
        for (const waiter of this.waiters) waiter();
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ v: 1, ...message })}\n`);
  }

  async next(predicate: (message: Message) => boolean): Promise<Message> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return await new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for relay message: ${JSON.stringify(this.messages)}`));
      }, 5_000);
      const check = () => {
        const found = this.messages.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(found);
      };
      this.waiters.add(check);
    });
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

const harnesses: RelayHarness[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("native workspace relay", () => {
  it("streams separated output, stdin, pid, and exit status", async () => {
    const relay = new RelayHarness();
    harnesses.push(relay);
    await relay.next((message) => message.type === "ready");
    relay.send({
      type: "start",
      id: "process-1",
      command: "cat; printf err >&2; exit 7",
      loginShell: false,
      stdin: Buffer.from("input").toString("base64"),
    });
    expect((await relay.next((message) => message.type === "started")).pid).toBeGreaterThan(0);
    expect(
      Buffer.from(
        (await relay.next((message) => message.type === "stdout")).data ?? "",
        "base64",
      ).toString(),
    ).toBe("input");
    expect(
      Buffer.from(
        (await relay.next((message) => message.type === "stderr")).data ?? "",
        "base64",
      ).toString(),
    ).toBe("err");
    expect((await relay.next((message) => message.type === "exit")).code).toBe(7);
  });

  it("applies command environment after login profile initialization", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "coder-native-relay-env-"));
    tempDirs.push(dir);
    const requestedDirectory = await realpath(dir);
    const bash = path.join(dir, "bash");
    await writeFile(
      bash,
      '#!/bin/sh\nif [ "$1" = "-lc" ]; then export CODER_RELAY_ENV_ORDER=profile; cd /; fi\nexec /bin/bash "$@"\n',
    );
    await chmod(bash, 0o755);
    const relay = new RelayHarness({
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    harnesses.push(relay);
    await relay.next((message) => message.type === "ready");
    relay.send({
      type: "start",
      id: "process-env-order",
      command: 'printf "%s|%s|" "$CODER_RELAY_ENV_ORDER" "$PATH"; pwd -P',
      cwd: requestedDirectory,
      loginShell: true,
      env: {
        CODER_RELAY_ENV_ORDER: `caller ' "$PATH"`,
        PATH: "/command-only-without-bash",
      },
    });
    expect(
      Buffer.from(
        (
          await relay.next(
            (message) => message.type === "stdout" && message.id === "process-env-order",
          )
        ).data ?? "",
        "base64",
      ).toString(),
    ).toBe(`caller ' "$PATH"|/command-only-without-bash|${requestedDirectory}\n`);
    expect(
      (await relay.next((message) => message.type === "exit" && message.id === "process-env-order"))
        .code,
    ).toBe(0);
  });

  it("pauses workspace process output until the host resumes each stream", async () => {
    const relay = new RelayHarness();
    harnesses.push(relay);
    await relay.next((message) => message.type === "ready");
    relay.send({
      type: "start",
      id: "process-flow-control",
      command: "kill -STOP $$; printf out; printf err >&2; kill -STOP $$",
      loginShell: false,
    });
    await relay.next(
      (message) => message.type === "started" && message.id === "process-flow-control",
    );
    relay.send({ type: "proc-pause", id: "process-flow-control", stream: "stdout" });
    relay.send({ type: "proc-pause", id: "process-flow-control", stream: "stderr" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    relay.send({ type: "kill", id: "process-flow-control", signal: "SIGCONT" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      relay.messages.filter(
        (message) =>
          message.id === "process-flow-control" &&
          (message.type === "stdout" || message.type === "stderr"),
      ),
    ).toEqual([]);
    relay.send({ type: "proc-resume", id: "process-flow-control", stream: "stdout" });
    expect(
      Buffer.from(
        (
          await relay.next(
            (message) => message.type === "stdout" && message.id === "process-flow-control",
          )
        ).data ?? "",
        "base64",
      ).toString(),
    ).toBe("out");
    expect(
      relay.messages.some(
        (message) => message.type === "stderr" && message.id === "process-flow-control",
      ),
    ).toBe(false);
    relay.send({ type: "proc-resume", id: "process-flow-control", stream: "stderr" });
    expect(
      Buffer.from(
        (
          await relay.next(
            (message) => message.type === "stderr" && message.id === "process-flow-control",
          )
        ).data ?? "",
        "base64",
      ).toString(),
    ).toBe("err");
    relay.send({ type: "kill", id: "process-flow-control", signal: "SIGCONT" });
    expect(
      (
        await relay.next(
          (message) => message.type === "exit" && message.id === "process-flow-control",
        )
      ).code,
    ).toBe(0);
  });

  it("backpressures unread host process streams", async () => {
    type Sink = {
      onStarted(pid: number): void;
      onStdout(data: Uint8Array): void;
      onStderr(data: Uint8Array): void;
      onExit(code: number): void;
      onError(error: Error): void;
    };
    let sink!: Sink;
    const flow: string[] = [];
    const relay = {
      startProcess: (_id: string, _options: unknown, processSink: Sink) => {
        sink = processSink;
        sink.onStarted(123);
      },
      pauseProcessOutput: (_id: string, stream: string) => flow.push(`pause:${stream}`),
      resumeProcessOutput: (_id: string, stream: string) => flow.push(`resume:${stream}`),
      unregisterProcess: () => {},
      killProcess: () => {},
    } as unknown as NativeRelay;
    const process = new NativeSpawnedProcess(
      Promise.resolve(relay),
      { workspace: "ws", command: "ignored" },
      false,
    );
    await Promise.resolve();

    sink.onStdout(Buffer.from("out"));
    sink.onStderr(Buffer.from("err"));
    expect(flow).toEqual(["pause:stdout", "pause:stderr"]);

    const stdoutReader = process.stdout.getReader();
    await expect(stdoutReader.read()).resolves.toMatchObject({ value: Buffer.from("out") });
    const stderrReader = process.stderr.getReader();
    await expect(stderrReader.read()).resolves.toMatchObject({ value: Buffer.from("err") });
    await Promise.resolve();
    expect(flow).toEqual(["pause:stdout", "pause:stderr", "resume:stdout", "resume:stderr"]);
    stdoutReader.releaseLock();
    stderrReader.releaseLock();
    sink.onExit(0);
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it("terminates a spawned process group", async () => {
    const relay = new RelayHarness();
    harnesses.push(relay);
    await relay.next((message) => message.type === "ready");
    relay.send({
      type: "start",
      id: "process-kill",
      command: "sleep 30",
      loginShell: false,
    });
    await relay.next((message) => message.type === "started" && message.id === "process-kill");
    relay.send({ type: "kill", id: "process-kill", signal: "SIGTERM" });
    expect(
      (await relay.next((message) => message.type === "exit" && message.id === "process-kill"))
        .code,
    ).toBe(143);
  });

  it("maps signals outside the common termination set to conventional exit codes", async () => {
    const relay = new RelayHarness();
    harnesses.push(relay);
    await relay.next((message) => message.type === "ready");
    relay.send({
      type: "start",
      id: "process-signal",
      command: "kill -USR1 $$",
      loginShell: false,
    });
    expect(
      (await relay.next((message) => message.type === "exit" && message.id === "process-signal"))
        .code,
    ).toBe(128 + os.constants.signals.SIGUSR1);
  });

  it("terminates descendant processes when the relay exits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "coder-native-relay-cleanup-"));
    tempDirs.push(dir);
    const startedPath = path.join(dir, "started");
    const terminatedPath = path.join(dir, "terminated");
    const descendantSource =
      `const fs = require('node:fs'); ` +
      `fs.writeFileSync(${JSON.stringify(startedPath)}, String(process.pid)); ` +
      `process.once('SIGTERM', () => { ` +
      `fs.writeFileSync(${JSON.stringify(terminatedPath)}, 'yes'); process.exit(0); ` +
      `}); setInterval(() => {}, 1000);`;
    const relay = new RelayHarness();
    harnesses.push(relay);
    let descendantPid: number | undefined;
    try {
      await relay.next((message) => message.type === "ready");
      relay.send({
        type: "start",
        id: "process-relay-exit",
        command: `${shellQuote(process.execPath)} -e ${shellQuote(descendantSource)} & wait`,
        loginShell: false,
      });
      await relay.next(
        (message) => message.type === "started" && message.id === "process-relay-exit",
      );
      descendantPid = Number(await waitForFile(startedPath));
      const closed = once(relay.child, "close");
      relay.close();
      await closed;
      expect(await waitForFile(terminatedPath)).toBe("yes");
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
    }
  });

  it("opens a binary-safe TCP channel", async () => {
    const upstream = net.createServer((socket) => {
      socket.write(Buffer.from([0, 255, 1]));
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream address");
    const relay = new RelayHarness();
    harnesses.push(relay);
    try {
      await relay.next((message) => message.type === "ready");
      relay.send({ type: "tcp-open", id: "socket-1", port: address.port });
      await relay.next((message) => message.type === "tcp-opened");
      expect(
        Buffer.from(
          (await relay.next((message) => message.type === "tcp-data")).data ?? "",
          "base64",
        ),
      ).toEqual(Buffer.from([0, 255, 1]));
      relay.send({
        type: "tcp-data",
        id: "socket-1",
        data: Buffer.from("ping").toString("base64"),
      });
      expect(
        Buffer.from(
          (
            await relay.next(
              (message) =>
                message.type === "tcp-data" &&
                Buffer.from(message.data ?? "", "base64").toString() === "ping",
            )
          ).data ?? "",
          "base64",
        ).toString(),
      ).toBe("ping");
    } finally {
      upstream.close();
    }
  });

  it("keeps the upstream write side open after a remote TCP half-close", async () => {
    let resolveRequest!: (data: Buffer) => void;
    const request = new Promise<Buffer>((resolve) => {
      resolveRequest = resolve;
    });
    const upstream = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", (data) => {
        resolveRequest(data);
        socket.destroy();
      });
      socket.end("remote-half-close");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream address");
    const relay = new RelayHarness();
    harnesses.push(relay);
    try {
      await relay.next((message) => message.type === "ready");
      relay.send({ type: "tcp-open", id: "socket-half-close", port: address.port });
      await relay.next(
        (message) => message.type === "tcp-opened" && message.id === "socket-half-close",
      );
      await relay.next(
        (message) => message.type === "tcp-end" && message.id === "socket-half-close",
      );
      relay.send({
        type: "tcp-data",
        id: "socket-half-close",
        data: Buffer.from("request-after-remote-eof").toString("base64"),
      });
      expect((await request).toString()).toBe("request-after-remote-eof");
    } finally {
      upstream.close();
    }
  });

  it("signals backpressure while upstream TCP writes are queued", async () => {
    let resolveUpstream!: (socket: net.Socket) => void;
    const upstreamConnected = new Promise<net.Socket>((resolve) => {
      resolveUpstream = resolve;
    });
    const upstream = net.createServer((socket) => {
      socket.pause();
      resolveUpstream(socket);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("no upstream address");
    const relay = new RelayHarness();
    harnesses.push(relay);
    try {
      await relay.next((message) => message.type === "ready");
      relay.send({ type: "tcp-open", id: "socket-backpressure", port: address.port });
      await relay.next(
        (message) => message.type === "tcp-opened" && message.id === "socket-backpressure",
      );
      const upstreamSocket = await upstreamConnected;
      const data = Buffer.alloc(128 * 1024, 0x31).toString("base64");
      for (let index = 0; index < 128; index += 1) {
        relay.send({ type: "tcp-data", id: "socket-backpressure", data });
        await new Promise((resolve) => setImmediate(resolve));
        if (
          relay.messages.some(
            (message) => message.type === "tcp-pause" && message.id === "socket-backpressure",
          )
        ) {
          break;
        }
      }
      expect(
        (
          await relay.next(
            (message) => message.type === "tcp-pause" && message.id === "socket-backpressure",
          )
        ).type,
      ).toBe("tcp-pause");
      upstreamSocket.resume();
      expect(
        (
          await relay.next(
            (message) => message.type === "tcp-resume" && message.id === "socket-backpressure",
          )
        ).type,
      ).toBe("tcp-resume");
      relay.send({ type: "tcp-close", id: "socket-backpressure" });
      await relay.next(
        (message) => message.type === "tcp-close" && message.id === "socket-backpressure",
      );
    } finally {
      upstream.close();
    }
  });

  it("flushes queued TCP data before a graceful remote close", async () => {
    type Sink = {
      opened(): void;
      data(data: Uint8Array): void;
      end(): void;
      close(): void;
      error(error: Error): void;
    };
    let resolveSink!: (sink: Sink) => void;
    const sinkReady = new Promise<Sink>((resolve) => {
      resolveSink = resolve;
    });
    const relay = {
      closed: false,
      onClose: () => () => {},
      openTcp: (_id: string, _port: number, sink: Sink) => {
        resolveSink(sink);
        sink.opened();
      },
      tcpData: () => {},
      tcpEnd: () => {},
      pauseTcp: () => {},
      resumeTcp: () => {},
      closeTcp: () => {},
    } as unknown as NativeRelay;
    const forward = await openNativePortForward(relay, { workspace: "ws", remotePort: 4444 });
    try {
      const payload = Buffer.alloc(1024 * 1024, 0x5a);
      const received: Buffer[] = [];
      let socketError: Error | undefined;
      const socket = net.connect(forward.localPort, forward.localHost);
      socket.on("data", (data) => received.push(data));
      socket.on("error", (error) => {
        socketError = error;
      });
      const socketClosed = once(socket, "close");
      socket.pause();
      await once(socket, "connect");
      const sink = await sinkReady;
      sink.data(payload);
      sink.end();
      sink.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      socket.resume();
      await socketClosed;
      expect(socketError).toBeUndefined();
      const result = Buffer.concat(received);
      expect(result.length).toBe(payload.length);
      expect(result.equals(payload)).toBe(true);
    } finally {
      await forward.close();
    }
  });

  it("preserves response data after a local TCP half-close", async () => {
    type Sink = {
      opened(): void;
      data(data: Uint8Array): void;
      end(): void;
      close(): void;
      error(error: Error): void;
    };
    let sink!: Sink;
    const request: Buffer[] = [];
    const relay = {
      closed: false,
      onClose: () => () => {},
      openTcp: (_id: string, _port: number, opened: Sink) => {
        sink = opened;
        sink.opened();
      },
      tcpData: (_id: string, data: Uint8Array) => request.push(Buffer.from(data)),
      tcpEnd: () => {
        sink.data(Buffer.from("response-after-eof"));
        sink.end();
        sink.close();
      },
      pauseTcp: () => {},
      resumeTcp: () => {},
      closeTcp: () => {},
    } as unknown as NativeRelay;
    const forward = await openNativePortForward(relay, { workspace: "ws", remotePort: 4444 });
    try {
      const response: Buffer[] = [];
      const socket = net.connect(forward.localPort, forward.localHost);
      socket.on("data", (data) => response.push(data));
      const socketClosed = once(socket, "close");
      await once(socket, "connect");
      socket.end("request-before-eof");
      await socketClosed;
      expect(Buffer.concat(request).toString()).toBe("request-before-eof");
      expect(Buffer.concat(response).toString()).toBe("response-after-eof");
    } finally {
      await forward.close();
    }
  });

  it("pauses remote TCP data until a slow local client drains", async () => {
    type Sink = {
      opened(): void;
      data(data: Uint8Array): void;
      end(): void;
      close(): void;
      error(error: Error): void;
    };
    let resolveSink!: (sink: Sink) => void;
    const sinkReady = new Promise<Sink>((resolve) => {
      resolveSink = resolve;
    });
    let resolvePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      resolvePaused = resolve;
    });
    let pauseCount = 0;
    let resolveResumed!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resolveResumed = resolve;
    });
    const relay = {
      closed: false,
      onClose: () => () => {},
      openTcp: (_id: string, _port: number, sink: Sink) => {
        resolveSink(sink);
        sink.opened();
      },
      tcpData: () => {},
      tcpEnd: () => {},
      pauseTcp: () => {
        pauseCount += 1;
        resolvePaused();
      },
      resumeTcp: () => resolveResumed(),
      closeTcp: () => {},
    } as unknown as NativeRelay;
    const forward = await openNativePortForward(relay, { workspace: "ws", remotePort: 4444 });
    try {
      const payload: Buffer[] = [];
      const chunk = Buffer.alloc(128 * 1024, 0x42);
      const received: Buffer[] = [];
      const socket = net.connect(forward.localPort, forward.localHost);
      socket.on("data", (data) => received.push(data));
      const socketClosed = once(socket, "close");
      socket.pause();
      await once(socket, "connect");
      const sink = await sinkReady;
      for (let index = 0; index < 128 && pauseCount === 0; index += 1) {
        payload.push(chunk);
        sink.data(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await paused;
      expect(pauseCount).toBe(1);
      socket.resume();
      await resumed;
      sink.end();
      sink.close();
      await socketClosed;
      expect(Buffer.concat(received).equals(Buffer.concat(payload))).toBe(true);
    } finally {
      await forward.close();
    }
  });

  it("rejects a pending port bind with the caller's abort reason", async () => {
    const relay = {
      closed: false,
      onClose: () => () => {},
    } as unknown as NativeRelay;
    const controller = new AbortController();
    const reason = new Error("cancel pending bind");
    const pending = openNativePortForward(relay, {
      workspace: "ws",
      remotePort: 4444,
      abortSignal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
