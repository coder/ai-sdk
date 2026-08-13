import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { NATIVE_RELAY_BOOTSTRAP_MARKER } from "../src/native-relay.js";
import { CoderNativeTransport } from "../src/native-transport.js";

interface RelayRequest {
  type?: string;
  id?: string;
  stdin?: string;
  data?: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fakeCoderd(): Promise<{
  url: string;
  requests: RelayRequest[];
  bootstrapSource: () => string;
  ptyConnected: Promise<void>;
  releaseBootstrap: () => void;
}> {
  let bootstrap = "";
  let releaseRequested = false;
  let ptyWebsocket: WebSocket | undefined;
  let resolvePtyConnected!: () => void;
  const ptyConnected = new Promise<void>((resolve) => {
    resolvePtyConnected = resolve;
  });
  const requests: RelayRequest[] = [];
  const server = http.createServer((request, response) => {
    if (request.headers["coder-session-token"] !== "test-token") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    if (request.url === "/api/v2/users/me/workspace/ws") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "workspace-id",
          owner_name: "me",
          name: "ws",
          latest_build: {
            id: "build-id",
            transition: "start",
            status: "running",
            job: { status: "succeeded" },
            resources: [
              {
                agents: [
                  {
                    id: "agent-id",
                    name: "main",
                    status: "connected",
                    lifecycle_state: "ready",
                  },
                ],
              },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers["coder-session-token"] !== "test-token") {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v2/workspaceagents/agent-id/pty") {
      socket.destroy();
      return;
    }
    expect(url.searchParams.get("backend_type")).toBe("buffered");
    expect(url.searchParams.get("command")?.length).toBeLessThan(500);
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      ptyWebsocket = websocket;
      let bootstrapped = false;
      websocket.on("message", (raw) => {
        const outer = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as {
          data: string;
        };
        if (!bootstrapped) {
          bootstrapped = true;
          bootstrap = Buffer.from(outer.data.trim(), "base64").toString("utf8");
          send(websocket, { type: "ready", protocol: 1, pid: 999 });
          return;
        }
        const message = JSON.parse(outer.data.trim()) as RelayRequest;
        requests.push(message);
        if (message.type === "start" && message.id) {
          send(websocket, { type: "started", id: message.id, pid: 1234 });
          send(websocket, { type: "stdout", id: message.id, data: message.stdin ?? "" });
          send(websocket, {
            type: "stderr",
            id: message.id,
            data: Buffer.from("separate-error").toString("base64"),
          });
          send(websocket, { type: "exit", id: message.id, code: 7 });
        } else if (message.type === "tcp-open" && message.id) {
          send(websocket, { type: "tcp-opened", id: message.id });
        } else if (message.type === "tcp-data" && message.id) {
          send(websocket, { type: "tcp-data", id: message.id, data: message.data });
        } else if (message.type === "tcp-end" && message.id) {
          send(websocket, { type: "tcp-end", id: message.id });
          send(websocket, { type: "tcp-close", id: message.id });
        }
      });
      resolvePtyConnected();
      if (releaseRequested) websocket.send(Buffer.from(`${NATIVE_RELAY_BOOTSTRAP_MARKER}\n`));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fake Coderd port");
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        websocketServer.clients.forEach((client) => client.terminate());
        websocketServer.close();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    bootstrapSource: () => bootstrap,
    ptyConnected,
    releaseBootstrap: () => {
      releaseRequested = true;
      ptyWebsocket?.send(Buffer.from(`${NATIVE_RELAY_BOOTSTRAP_MARKER}\n`));
    },
  };
}

function send(websocket: WebSocket, message: Record<string, unknown>): void {
  websocket.send(Buffer.from(`${JSON.stringify({ v: 1, ...message })}\n`));
}

describe("CoderNativeTransport", () => {
  it("runs process and TCP contracts through authenticated Coderd WebSockets", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      loginShell: false,
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    expect(await transport.status("ws")).toMatchObject({
      id: "workspace-id",
      buildStatus: "running",
      agents: [{ name: "main", status: "connected" }],
    });
    const execution = transport.exec({ workspace: "ws", command: "ignored", stdin: "hello" });
    await coderd.ptyConnected;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const bootstrapBeforeMarker = coderd.bootstrapSource();
    coderd.releaseBootstrap();
    const result = await execution;
    expect(result).toEqual({ exitCode: 7, stdout: "hello", stderr: "separate-error" });
    expect(bootstrapBeforeMarker).toBe("");
    expect(coderd.bootstrapSource()).toContain("childProcess.spawn('bash'");
    expect(coderd.requests.find((request) => request.type === "start")).toMatchObject({
      type: "start",
      command: "ignored",
      loginShell: false,
    });

    const forward = await transport.forwardPort({ workspace: "ws", remotePort: 4444 });
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(forward.localPort, forward.localHost, () =>
          socket.write("ping"),
        );
        socket.once("data", (data) => {
          resolve(data.toString("utf8"));
          socket.end();
        });
        socket.once("error", reject);
      });
      expect(echoed).toBe("ping");
    } finally {
      await forward.close();
    }
  });

  it("isolates shared relay setup from one caller's cancellation", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      loginShell: false,
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    const controller = new AbortController();
    const canceled = transport.exec({
      workspace: "ws",
      command: "first",
      abortSignal: controller.signal,
    });
    await coderd.ptyConnected;
    const survivor = transport.exec({ workspace: "ws", command: "second", stdin: "still-running" });

    controller.abort(new Error("cancel only the first caller"));
    await expect(canceled).rejects.toThrow("cancel only the first caller");
    expect(coderd.bootstrapSource()).toBe("");

    coderd.releaseBootstrap();
    await expect(survivor).resolves.toEqual({
      exitCode: 7,
      stdout: "still-running",
      stderr: "separate-error",
    });
    expect(coderd.requests.filter((request) => request.type === "start")).toHaveLength(1);
  });
});
