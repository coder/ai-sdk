import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeRelay, NATIVE_RELAY_SOURCE, openNativePortForward } from "../src/native-relay.js";
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
    const bash = path.join(dir, "bash");
    await writeFile(
      bash,
      '#!/bin/sh\nif [ "$1" = "-lc" ]; then export CODER_RELAY_ENV_ORDER=profile; fi\nexec /bin/bash "$@"\n',
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
      command: 'printf %s "$CODER_RELAY_ENV_ORDER"',
      loginShell: true,
      env: { CODER_RELAY_ENV_ORDER: `caller ' "$PATH"` },
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
    ).toBe(`caller ' "$PATH"`);
    expect(
      (await relay.next((message) => message.type === "exit" && message.id === "process-env-order"))
        .code,
    ).toBe(0);
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
