import { createHash } from "node:crypto";
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
  stdinMode?: string;
  data?: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fakeCoderd(
  options: {
    bootstrapPrefix?: string;
    currentUserId?: string;
    ownerId?: string;
    ownerName?: string;
    ptyRedirect?: string;
  } = {},
): Promise<{
  url: string;
  requests: RelayRequest[];
  bootstrapSource: () => string;
  ptyConnections: () => number;
  ptyConnected: Promise<void>;
  releaseBootstrap: () => void;
  sendBootstrapChunk: (data: string) => void;
}> {
  let bootstrap = "";
  let releaseRequested = false;
  let ptyConnections = 0;
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
    if (request.url === "/api/v2/users/me") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: options.currentUserId ?? options.ownerId ?? "user-id" }));
      return;
    }
    if (
      request.url === "/api/v2/users/me/workspace/ws" ||
      request.url === `/api/v2/users/${options.ownerName ?? "me"}/workspace/ws`
    ) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "workspace-id",
          owner_id: options.ownerId ?? "user-id",
          owner_name: options.ownerName ?? "me",
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
    if (request.url === "/api/v2/workspaces/workspace-id/builds" && request.method === "POST") {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "stop-build-id",
          transition: "stop",
          job: { status: "pending" },
        }),
      );
      return;
    }
    if (request.url === "/api/v2/workspacebuilds/stop-build-id") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: "stop-build-id",
          transition: "stop",
          job: { status: "succeeded" },
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
    if (options.ptyRedirect) {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${options.ptyRedirect}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    expect(url.searchParams.get("backend_type")).toBe("buffered");
    expect(url.searchParams.get("command")?.length).toBeLessThan(500);
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      ptyConnections += 1;
      ptyWebsocket = websocket;
      let bootstrapped = false;
      const processInputs = new Map<string, Buffer[]>();
      const finishProcess = (id: string, stdin: string) => {
        send(websocket, { type: "stdout", id, data: stdin });
        send(websocket, {
          type: "stderr",
          id,
          data: Buffer.from("separate-error").toString("base64"),
        });
        send(websocket, { type: "exit", id, code: 7 });
      };
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
          if (message.stdinMode === "stream") processInputs.set(message.id, []);
          else finishProcess(message.id, message.stdin ?? "");
        } else if (message.type === "proc-stdin" && message.id) {
          processInputs.get(message.id)?.push(Buffer.from(message.data ?? "", "base64"));
        } else if (message.type === "proc-stdin-end" && message.id) {
          const stdin = Buffer.concat(processInputs.get(message.id) ?? []).toString("base64");
          processInputs.delete(message.id);
          finishProcess(message.id, stdin);
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
      if (releaseRequested) {
        websocket.send(
          Buffer.from(`${options.bootstrapPrefix ?? ""}${NATIVE_RELAY_BOOTSTRAP_MARKER}\n`),
        );
      }
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
    ptyConnections: () => ptyConnections,
    ptyConnected,
    releaseBootstrap: () => {
      releaseRequested = true;
      ptyWebsocket?.send(
        Buffer.from(`${options.bootstrapPrefix ?? ""}${NATIVE_RELAY_BOOTSTRAP_MARKER}\n`),
      );
    },
    sendBootstrapChunk: (data) => ptyWebsocket?.send(Buffer.from(data)),
  };
}

function send(websocket: WebSocket, message: Record<string, unknown>): void {
  websocket.send(Buffer.from(`${JSON.stringify({ v: 1, ...message })}\n`));
}

describe("CoderNativeTransport", () => {
  it("rejects cross-origin PTY redirects without forwarding credentials", async () => {
    let targetRequests = 0;
    let targetToken: string | undefined;
    const target = http.createServer((request, response) => {
      targetRequests += 1;
      targetToken = request.headers["coder-session-token"] as string | undefined;
      response.end();
    });
    target.on("upgrade", (request, socket) => {
      targetRequests += 1;
      targetToken = request.headers["coder-session-token"] as string | undefined;
      socket.destroy();
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (targetAddress === null || typeof targetAddress === "string") {
      throw new Error("no redirect target port");
    }
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => {
          target.close(() => resolve());
        }),
    );
    const coderd = await fakeCoderd({
      ptyRedirect: `ws://127.0.0.1:${targetAddress.port}/capture`,
    });
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    await expect(transport.exec({ workspace: "ws", command: "ignored" })).rejects.toThrow(
      /refused cross-origin WebSocket redirect/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(targetRequests).toBe(0);
    expect(targetToken).toBeUndefined();
  });

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
    expect(coderd.bootstrapSource()).toContain("const bashPath = resolveExecutable('bash')");
    expect(coderd.bootstrapSource()).toContain("childProcess.spawn(bashPath");
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

  it("delivers large Unicode stdin through bounded relay frames", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    const stdin = `x${"😀".repeat(200_000)}tail`;
    const execution = transport.exec({ workspace: "ws", command: "ignored", stdin });
    await coderd.ptyConnected;
    coderd.releaseBootstrap();
    const result = await execution;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(digest(result.stdout)).toBe(digest(stdin));

    const start = coderd.requests.find((request) => request.type === "start");
    expect(start).toMatchObject({ stdinMode: "stream" });
    expect(start?.stdin).toBeUndefined();
    const frames = coderd.requests.filter((request) => request.type === "proc-stdin");
    const decodedSizes = frames.map(
      (request) => Buffer.from(request.data ?? "", "base64").byteLength,
    );
    expect(frames.length).toBeGreaterThan(1);
    expect(Math.max(...decodedSizes)).toBeLessThanOrEqual(64 * 1024);
    expect(decodedSizes.reduce((total, size) => total + size, 0)).toBe(Buffer.byteLength(stdin));
    expect(coderd.requests.filter((request) => request.type === "proc-stdin-end")).toHaveLength(1);
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

  it("coalesces equivalent references by resolved workspace agent", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      loginShell: false,
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());
    coderd.releaseBootstrap();

    const results = await Promise.all([
      transport.exec({ workspace: "ws", command: "first", stdin: "one" }),
      transport.exec({ workspace: "me/ws", command: "second", stdin: "two" }),
      transport.exec({ workspace: "ws.main", command: "third", stdin: "three" }),
    ]);

    expect(results.map((result) => result.stdout)).toEqual(["one", "two", "three"]);
    expect(coderd.ptyConnections()).toBe(1);
    expect(coderd.requests.filter((request) => request.type === "start")).toHaveLength(3);
  });

  it("recognizes a bootstrap marker appended to profile output without a newline", async () => {
    const coderd = await fakeCoderd({ bootstrapPrefix: "profile output without newline" });
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      loginShell: false,
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored", stdin: "ready" });
    await coderd.ptyConnected;
    coderd.releaseBootstrap();

    await expect(execution).resolves.toEqual({
      exitCode: 7,
      stdout: "ready",
      stderr: "separate-error",
    });
  });

  it("recognizes a bootstrap marker split across bounded chunks", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored", stdin: "ready" });
    await coderd.ptyConnected;
    const split = NATIVE_RELAY_BOOTSTRAP_MARKER.length - 7;
    coderd.sendBootstrapChunk(
      `${"profile-output".repeat(8_192)}${NATIVE_RELAY_BOOTSTRAP_MARKER.slice(0, split)}`,
    );
    coderd.sendBootstrapChunk(`${NATIVE_RELAY_BOOTSTRAP_MARKER.slice(split)}\n`);

    await expect(execution).resolves.toEqual({
      exitCode: 7,
      stdout: "ready",
      stderr: "separate-error",
    });
  });

  it("bounds diagnostic output while waiting for the bootstrap marker", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      relayConnectTimeoutMs: 500,
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored" });
    await coderd.ptyConnected;
    coderd.sendBootstrapChunk(`discard-me-${"x".repeat(64 * 1024)}diagnostic-tail`);

    const error = await execution.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("PTY output:");
    expect(message).toContain("diagnostic-tail");
    expect(message).not.toContain("discard-me");
    expect(message.length).toBeLessThan(700);
  });

  it("cancels pending relay setup when the transport closes", async () => {
    let resolveFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    const transport = new CoderNativeTransport({
      url: "http://coder.example.test",
      token: "test-token",
      fetch: async () => {
        resolveFetchStarted();
        return await new Promise<Response>(() => {});
      },
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored" });
    void execution.catch(() => {});
    await fetchStarted;
    await transport.close();

    await expect(execution).rejects.toThrow("Coder native transport closed");
  });

  it("preserves an active relay when start is already a no-op", async () => {
    const coderd = await fakeCoderd();
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      relayConnectTimeoutMs: 2_000,
    });
    cleanups.push(() => transport.close());

    const forwarding = transport.forwardPort({ workspace: "ws", remotePort: 4444 });
    await coderd.ptyConnected;
    coderd.releaseBootstrap();
    const forward = await forwarding;
    try {
      await transport.start("ws");
      expect(forward.closed).toBe(false);
    } finally {
      await forward.close();
    }
  });

  it("routes a running start behind a concurrent stop", async () => {
    let status = "running";
    let transition = "start";
    let workspaceRequests = 0;
    const buildTransitions: string[] = [];
    let resolveStopInnerReached!: () => void;
    const stopInnerReached = new Promise<void>((resolve) => {
      resolveStopInnerReached = resolve;
    });
    let releaseStopInner!: () => void;
    const stopInnerRelease = new Promise<void>((resolve) => {
      releaseStopInner = resolve;
    });
    let resolveStartLookupReached!: () => void;
    const startLookupReached = new Promise<void>((resolve) => {
      resolveStartLookupReached = resolve;
    });
    const transport = new CoderNativeTransport({
      url: "https://coder.example.test",
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          workspaceRequests += 1;
          if (workspaceRequests === 3) {
            resolveStopInnerReached();
            await stopInnerRelease;
          }
          if (workspaceRequests === 4) resolveStartLookupReached();
          return new Response(
            JSON.stringify({
              id: "workspace-id",
              owner_id: "user-id",
              owner_name: "me",
              name: "ws",
              latest_build: {
                id: `${transition}-build`,
                template_version_id: "version-current",
                transition,
                status,
                job: { status: "succeeded" },
                resources: [],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          const requested = (JSON.parse(String(init?.body)) as { transition: string }).transition;
          buildTransitions.push(requested);
          return new Response(
            JSON.stringify({
              id: `${requested}-build`,
              transition: requested,
              job: { status: "pending" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        const build = url.pathname.match(/^\/api\/v2\/workspacebuilds\/(start|stop)-build$/);
        if (build?.[1]) {
          transition = build[1];
          status = transition === "start" ? "running" : "stopped";
          return new Response(
            JSON.stringify({
              id: `${transition}-build`,
              transition,
              job: { status: "succeeded" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ message: "unexpected route", detail: url.pathname }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    cleanups.push(() => transport.close());

    const stopping = transport.stop("ws");
    await stopInnerReached;
    const starting = transport.start("ws");
    await startLookupReached;
    releaseStopInner();

    await Promise.all([stopping, starting]);
    expect(buildTransitions).toEqual(["stop", "start"]);
    await expect(transport.status("ws")).resolves.toMatchObject({ buildStatus: "running" });
  });

  it("does not wait for unrelated relay setup during lifecycle cleanup", async () => {
    const coderd = await fakeCoderd();
    let resolveOtherFetchStarted!: () => void;
    const otherFetchStarted = new Promise<void>((resolve) => {
      resolveOtherFetchStarted = resolve;
    });
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith("/workspace/other")) {
          resolveOtherFetchStarted();
          return await new Promise<Response>(() => {});
        }
        return await fetch(input, init);
      },
    });
    cleanups.push(() => transport.close());

    let unrelatedSettled = false;
    const unrelated = transport.exec({ workspace: "other", command: "ignored" });
    void unrelated.then(
      () => {
        unrelatedSettled = true;
      },
      () => {
        unrelatedSettled = true;
      },
    );
    await otherFetchStarted;

    await transport.stop("ws");
    expect(unrelatedSettled).toBe(false);

    await transport.close();
    await expect(unrelated).rejects.toThrow("Coder native transport closed");
  });

  it("cancels a pending explicit-owner relay through the me alias", async () => {
    const coderd = await fakeCoderd({ ownerName: "alice" });
    let resolveExplicitLookup!: () => void;
    const explicitLookup = new Promise<void>((resolve) => {
      resolveExplicitLookup = resolve;
    });
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === "/api/v2/users/alice/workspace/ws") {
          resolveExplicitLookup();
          return await new Promise<Response>(() => {});
        }
        return await fetch(input, init);
      },
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "alice/ws", command: "ignored" });
    const outcome = execution.then(
      () => "fulfilled",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await explicitLookup;

    await transport.stop("me/ws");
    await expect(outcome).resolves.toMatch(/workspace "me\/ws" lifecycle/);
  });

  it("cancels an unresolved me relay setup before a lifecycle transition", async () => {
    const coderd = await fakeCoderd({ ownerName: "alice" });
    let resolveSetupFetchStarted!: () => void;
    const setupFetchStarted = new Promise<void>((resolve) => {
      resolveSetupFetchStarted = resolve;
    });
    let stallNextWorkspaceLookup = true;
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/workspace/ws") && stallNextWorkspaceLookup) {
          stallNextWorkspaceLookup = false;
          resolveSetupFetchStarted();
          return await new Promise<Response>(() => {});
        }
        return await fetch(input, init);
      },
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored" });
    void execution.catch(() => {});
    await setupFetchStarted;

    await transport.stop("alice/ws");
    await expect(execution).rejects.toThrow(/workspace "alice\/ws" lifecycle/);
  });

  it("does not conflate an unresolved me setup with another owner's workspace", async () => {
    const coderd = await fakeCoderd({
      currentUserId: "alice-id",
      ownerId: "bob-id",
      ownerName: "bob",
    });
    let resolveSetupFetchStarted!: () => void;
    const setupFetchStarted = new Promise<void>((resolve) => {
      resolveSetupFetchStarted = resolve;
    });
    let stallNextWorkspaceLookup = true;
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/v2/users/me/workspace/ws" && stallNextWorkspaceLookup) {
          stallNextWorkspaceLookup = false;
          resolveSetupFetchStarted();
          return await new Promise<Response>(() => {});
        }
        return await fetch(input, init);
      },
    });
    cleanups.push(() => transport.close());

    let executionSettled = false;
    const execution = transport.exec({ workspace: "ws", command: "ignored" });
    void execution.then(
      () => {
        executionSettled = true;
      },
      () => {
        executionSettled = true;
      },
    );
    await setupFetchStarted;

    await transport.stop("bob/ws");
    expect(executionSettled).toBe(false);
    await transport.close();
    await expect(execution).rejects.toThrow("Coder native transport closed");
  });

  it("cancels a stalled owner-alias lookup with the lifecycle signal", async () => {
    const coderd = await fakeCoderd({ ownerName: "alice" });
    let resolveSetupFetchStarted!: () => void;
    const setupFetchStarted = new Promise<void>((resolve) => {
      resolveSetupFetchStarted = resolve;
    });
    let resolveOwnerFetchStarted!: () => void;
    const ownerFetchStarted = new Promise<void>((resolve) => {
      resolveOwnerFetchStarted = resolve;
    });
    let stallNextWorkspaceLookup = true;
    const transport = new CoderNativeTransport({
      url: coderd.url,
      token: "test-token",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/v2/users/me/workspace/ws" && stallNextWorkspaceLookup) {
          stallNextWorkspaceLookup = false;
          resolveSetupFetchStarted();
          return await new Promise<Response>(() => {});
        }
        if (path === "/api/v2/users/me") {
          resolveOwnerFetchStarted();
          return await new Promise<Response>(() => {});
        }
        return await fetch(input, init);
      },
    });
    cleanups.push(() => transport.close());

    const execution = transport.exec({ workspace: "ws", command: "ignored" });
    void execution.catch(() => {});
    await setupFetchStarted;
    const controller = new AbortController();
    const stopping = transport.stop("alice/ws", { abortSignal: controller.signal });
    await ownerFetchStarted;

    controller.abort(new Error("cancel lifecycle identity lookup"));
    await expect(stopping).rejects.toThrow("cancel lifecycle identity lookup");
    await transport.close();
    await expect(execution).rejects.toThrow("Coder native transport closed");
  });

  it("cancels stalled initial lifecycle lookups when custom fetch ignores its signal", async () => {
    const lifecycleMethods = ["start", "stop", "destroy"] as const;
    for (const method of lifecycleMethods) {
      let resolveFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        resolveFetchStarted = resolve;
      });
      const transport = new CoderNativeTransport({
        url: "https://coder.example.test",
        token: "test-token",
        fetch: async () => {
          resolveFetchStarted();
          return await new Promise<Response>(() => {});
        },
      });
      cleanups.push(() => transport.close());
      const controller = new AbortController();
      const lifecycle = transport[method]("ws", { abortSignal: controller.signal });
      await fetchStarted;

      const reason = new Error(`cancel ${method} lookup`);
      controller.abort(reason);
      await expect(lifecycle).rejects.toBe(reason);
    }
  });
});
