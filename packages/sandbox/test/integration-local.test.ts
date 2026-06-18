import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoderCliTransport } from "../src/cli-transport.js";
import { createCoderWorkspace } from "../src/coder-workspace-provider.js";
import * as fileIo from "../src/file-io.js";
import { createFakeCoder, createFakeSsh, type FakeCoder } from "./fake-coder.js";

let fakeCoder: FakeCoder;
let fakeSsh: FakeCoder;
let transport: CoderCliTransport;
let workDir: string;

beforeAll(async () => {
  fakeCoder = await createFakeCoder();
  fakeSsh = await createFakeSsh();
  // Exec/file/spawn and the port-forward (`ssh -N -L`) all go through the fake
  // ssh. loginShell:false keeps the locally-executed command off our profile.
  transport = new CoderCliTransport({
    coderBinary: fakeCoder.path,
    sshBinary: fakeSsh.path,
    loginShell: false,
  });
  workDir = await mkdtemp(path.join(os.tmpdir(), "coder-ws-"));
});

afterAll(async () => {
  await fakeCoder.cleanup();
  await fakeSsh.cleanup();
  await rm(workDir, { recursive: true, force: true });
});

function ctx(): fileIo.FileIoContext {
  return { transport, workspace: "ws", defaultWorkingDirectory: workDir };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("CoderCliTransport.exec (via fake coder)", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await transport.exec({ workspace: "ws", command: "echo hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("propagates non-zero exit codes", async () => {
    const result = await transport.exec({ workspace: "ws", command: "exit 3" });
    expect(result.exitCode).toBe(3);
  });

  it("applies the working directory", async () => {
    const result = await transport.exec({
      workspace: "ws",
      command: "pwd",
      workingDirectory: workDir,
    });
    // macOS reports /private/var symlinks; compare basename to stay portable.
    expect(result.stdout.trim().endsWith(path.basename(workDir))).toBe(true);
  });

  it("applies per-command environment variables", async () => {
    const result = await transport.exec({
      workspace: "ws",
      command: 'printf %s "$FOO"',
      env: { FOO: "bar baz" },
    });
    expect(result.stdout).toBe("bar baz");
  });

  it("delivers stdin to the command", async () => {
    const result = await transport.exec({
      workspace: "ws",
      command: "cat",
      stdin: "piped-input",
    });
    expect(result.stdout).toBe("piped-input");
  });
});

describe("CoderCliTransport.spawn (via fake coder)", () => {
  it("streams stdout and stderr and resolves an exit code", async () => {
    const proc = transport.spawn({
      workspace: "ws",
      command: "printf out; printf err 1>&2",
    });
    const [stdout, stderr, result] = await Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
      proc.wait(),
    ]);
    expect(stdout).toBe("out");
    expect(stderr).toBe("err");
    expect(result.exitCode).toBe(0);
  });
});

describe("file I/O round-trips (via fake coder)", () => {
  it("writes then reads a text file", async () => {
    const p = path.join(workDir, "notes.txt");
    await fileIo.writeTextFile(ctx(), { path: p, content: "hello\nworld" });
    const read = await fileIo.readTextFile(ctx(), { path: p });
    expect(read).toBe("hello\nworld");
  });

  it("round-trips arbitrary binary bytes", async () => {
    const p = path.join(workDir, "blob.bin");
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 42]);
    await fileIo.writeBinaryFile(ctx(), { path: p, content: bytes });
    const read = await fileIo.readBinaryFile(ctx(), { path: p });
    expect(read).not.toBeNull();
    expect(Array.from(read!)).toEqual(Array.from(bytes));
  });

  it("creates parent directories on write", async () => {
    const p = path.join(workDir, "nested/deep/file.txt");
    await fileIo.writeTextFile(ctx(), { path: p, content: "ok" });
    expect(await fileIo.readTextFile(ctx(), { path: p })).toBe("ok");
  });

  it("returns null for a missing file", async () => {
    const read = await fileIo.readBinaryFile(ctx(), {
      path: path.join(workDir, "does-not-exist"),
    });
    expect(read).toBeNull();
  });

  it("reads a 1-based inclusive line range", async () => {
    const p = path.join(workDir, "lines.txt");
    await fileIo.writeTextFile(ctx(), { path: p, content: "a\nb\nc\nd" });
    const read = await fileIo.readTextFile(ctx(), { path: p, startLine: 2, endLine: 3 });
    expect(read).toBe("b\nc");
  });
});

describe("CoderCliTransport create/status/presets (via fake coder)", () => {
  it("status returns null for a workspace that does not exist", async () => {
    expect(await transport.status("nope-does-not-exist")).toBeNull();
  });

  it("create then status reports a ready workspace (JSON round-trip)", async () => {
    const name = `it-create-${Date.now()}`;
    await transport.create({ workspace: name, template: "docker", preset: "Standard" });
    const status = await transport.status(name);
    expect(status).not.toBeNull();
    expect(status!.name).toBe(name);
    expect(status!.buildStatus).toBe("running");
    expect(status!.agents[0]).toMatchObject({ status: "connected", lifecycleState: "ready" });
    // delete clears the state so the workspace is gone again
    await transport.destroy(name);
    expect(await transport.status(name)).toBeNull();
  });

  it("listPresets parses the wrapped PascalCase JSON", async () => {
    const presets = await transport.listPresets({ template: "docker" });
    expect(presets).toEqual([{ name: "Standard", default: true }]);
  });
});

describe("createCoderWorkspace create mode (via fake coder + ssh)", () => {
  it("get-or-creates a workspace, runs a command in it, and deletes it on destroy", async () => {
    const name = `prov-create-${Date.now()}`;
    const provider = createCoderWorkspace({
      workspace: name,
      create: { template: "docker" },
      transport, // the shared fake-coder/fake-ssh-backed CoderCliTransport
      defaultWorkingDirectory: "/tmp",
    });
    const session = await provider.createSession!({ sessionId: "sx" });
    expect(session.id).toBe(name);
    // workspace now exists (was created)
    expect(await transport.status(name)).not.toBeNull();

    const result = await session.run({ command: "echo created-and-running" });
    expect(result.stdout.trim()).toBe("created-and-running");

    await session.destroy?.();
    expect(await transport.status(name)).toBeNull(); // created → owned → deleted
  });
});

describe("CoderCliTransport.forwardPort (via fake coder TCP proxy)", () => {
  it("tunnels host → workspace and tears down on close", async () => {
    // Upstream "workspace" service: an echo server.
    const upstream = net.createServer((socket) => socket.pipe(socket));
    const remotePort = await new Promise<number>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => {
        const addr = upstream.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      const forward = await transport.forwardPort({ workspace: "ws", remotePort });
      expect(forward.localHost).toBe("127.0.0.1");
      expect(forward.localPort).toBeGreaterThan(0);

      const echoed = await new Promise<string>((resolve, reject) => {
        const client = net.connect(forward.localPort, forward.localHost, () => {
          client.write("ping");
        });
        client.on("data", (data) => {
          resolve(data.toString("utf8"));
          client.end();
        });
        client.on("error", reject);
      });
      expect(echoed).toBe("ping");

      await forward.close();
    } finally {
      upstream.close();
    }
  });
});
