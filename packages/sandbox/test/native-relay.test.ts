import { spawn } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_RELAY_SOURCE } from "../src/native-relay.js";

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
  readonly child = spawn(process.execPath, ["-e", NATIVE_RELAY_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  readonly messages: Message[] = [];
  readonly waiters = new Set<() => void>();
  #buffer = "";

  constructor() {
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

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
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
});
