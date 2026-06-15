/**
 * End-to-end verification of the built provider against a REAL Coder workspace.
 *
 *   npx tsx scripts/verify-real.ts [workspace]   (default: aisdk-sandbox-test)
 *
 * Requires the `coder` CLI on PATH and logged in. Exercises the actual
 * CoderCliTransport + createCoderSandbox: exec, exit codes, env, cwd, stdin,
 * base64 file round-trips, spawn streaming, and — the bridge's critical path —
 * a real WebSocket upgrade tunneled through OpenSSH `-L` forwarding.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { CoderCliTransport } from '../src/cli-transport.js';
import * as fileIo from '../src/file-io.js';
import { createCoderSandbox } from '../src/index.js';

const WS = process.argv[2] ?? 'aisdk-sandbox-test';
const PORT = 4000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Minimal WebSocket client over a raw TCP socket: handshake + one echo round-trip. */
function wsEcho(host: string, port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(port, host, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('ws timeout'));
    }, 10_000);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const header = buf.subarray(0, idx).toString();
        if (!/HTTP\/1\.1 101/.test(header)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`no 101 upgrade: ${header.split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        buf = buf.subarray(idx + 4);
        const payload = Buffer.from(message);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
        socket.write(
          Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]),
        );
      }
      if (upgraded && buf.length >= 2) {
        const len = buf[1]! & 0x7f;
        if (buf.length >= 2 + len) {
          clearTimeout(timer);
          const echoed = buf.subarray(2, 2 + len).toString();
          socket.destroy();
          resolve(echoed);
        }
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// A WebSocket echo server (no deps) written into the workspace and run with python3.
const WS_SERVER_PY = `
import socket, hashlib, base64, sys
PORT = int(sys.argv[1]); GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", PORT)); srv.listen(5)
print("WS_LISTENING", flush=True)
def handle(conn):
    data = b""
    while b"\\r\\n\\r\\n" not in data:
        chunk = conn.recv(1024)
        if not chunk: return
        data += chunk
    key = None
    for line in data.decode("latin1").split("\\r\\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    if not key: return
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\n"
                  "Connection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n").encode())
    frame = conn.recv(1024)
    if not frame or len(frame) < 6: return
    ln = frame[1] & 0x7f; mask = frame[2:6]
    payload = bytes(frame[6 + i] ^ mask[i % 4] for i in range(ln))
    conn.sendall(bytes([0x81, len(payload)]) + payload)
while True:
    try:
        c, _ = srv.accept(); handle(c); c.close()
    except Exception:
        pass
`;

async function main(): Promise<void> {
  const transport = new CoderCliTransport({});
  console.log(`\n# Verifying against workspace "${WS}"\n`);

  console.log('## exec');
  const echo = await transport.exec({ workspace: WS, command: 'echo hello' });
  check('echo → stdout', echo.stdout.trim() === 'hello', JSON.stringify(echo));
  check('echo → exit 0', echo.exitCode === 0);

  for (const c of [0, 1, 42]) {
    const r = await transport.exec({ workspace: WS, command: `exit ${c}` });
    check(`exit ${c} propagates`, r.exitCode === c, `got ${r.exitCode}`);
  }

  const home = await transport.exec({ workspace: WS, command: 'pwd', workingDirectory: '/tmp' });
  check('workingDirectory applied', home.stdout.trim() === '/tmp', home.stdout);

  const env = await transport.exec({
    workspace: WS,
    command: 'printf %s "$FOO"',
    env: { FOO: 'bar baz' },
  });
  check('env var applied', env.stdout === 'bar baz', JSON.stringify(env.stdout));

  const stdin = await transport.exec({ workspace: WS, command: 'cat', stdin: 'piped!' });
  check('stdin delivered', stdin.stdout === 'piped!', JSON.stringify(stdin.stdout));

  const errSep = await transport.exec({ workspace: WS, command: 'echo OUT; echo ERR 1>&2' });
  check('stdout/stderr separated', errSep.stdout.trim() === 'OUT' && errSep.stderr.trim() === 'ERR',
    JSON.stringify(errSep));

  console.log('## file I/O (base64 over ssh)');
  const dir = `/tmp/aisdk-verify-${Date.now()}`;
  const ctx: fileIo.FileIoContext = { transport, workspace: WS, defaultWorkingDirectory: dir };
  await fileIo.writeTextFile(ctx, { path: `${dir}/notes.txt`, content: 'hello\nworld' });
  const text = await fileIo.readTextFile(ctx, { path: `${dir}/notes.txt` });
  check('text round-trip', text === 'hello\nworld', JSON.stringify(text));

  const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 42, 200]);
  await fileIo.writeBinaryFile(ctx, { path: `${dir}/blob.bin`, content: bytes });
  const readBytes = await fileIo.readBinaryFile(ctx, { path: `${dir}/blob.bin` });
  check('binary round-trip', !!readBytes && Buffer.compare(Buffer.from(readBytes), Buffer.from(bytes)) === 0);

  const missing = await fileIo.readBinaryFile(ctx, { path: `${dir}/nope` });
  check('missing file → null', missing === null);

  await fileIo.writeTextFile(ctx, { path: `${dir}/lines.txt`, content: 'a\nb\nc\nd' });
  const slice = await fileIo.readTextFile(ctx, { path: `${dir}/lines.txt`, startLine: 2, endLine: 3 });
  check('line range read', slice === 'b\nc', JSON.stringify(slice));

  console.log('## spawn (streaming)');
  const proc = await transport.spawn({ workspace: WS, command: 'printf out; printf err 1>&2' });
  const [so, se, wr] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.wait()]);
  check('spawn stdout stream', so === 'out', JSON.stringify(so));
  check('spawn stderr stream', se === 'err', JSON.stringify(se));
  check('spawn wait exit code', wr.exitCode === 0);

  console.log('## provider + session (public API)');
  const provider = createCoderSandbox({ workspace: WS });
  const session = await provider.createSession();
  check('session.id = workspace', session.id === WS);
  check('defaultWorkingDirectory resolved from $HOME', session.defaultWorkingDirectory === '/home/coder',
    session.defaultWorkingDirectory);
  const runRes = await session.run({ command: 'echo via-session' });
  check('session.run', runRes.stdout.trim() === 'via-session' && runRes.exitCode === 0);

  console.log('## getPortUrl + WebSocket over ssh -L (the bridge path)');
  const serverPath = `${dir}/ws_server.py`;
  await session.writeTextFile({ path: serverPath, content: WS_SERVER_PY });
  const serverProc = await session.spawn({ command: `python3 ${serverPath} ${PORT}` });
  // wait for the server to announce it is listening
  const reader = serverProc.stdout.getReader();
  let banner = '';
  const ready = (async () => {
    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) banner += Buffer.from(value).toString('utf8');
      if (banner.includes('WS_LISTENING')) return true;
    }
    return false;
  })();
  check('in-workspace WS server started', await ready, banner);

  let wsUrl = '';
  try {
    wsUrl = await session.getPortUrl({ port: PORT, protocol: 'ws' });
    check('getPortUrl returns ws:// loopback URL', /^ws:\/\/127\.0\.0\.1:\d+$/.test(wsUrl), wsUrl);
    const u = new URL(wsUrl);
    const echoed = await wsEcho(u.hostname, Number(u.port), 'bridge-handshake-ok');
    check('WebSocket upgrade + echo through port-forward', echoed === 'bridge-handshake-ok', JSON.stringify(echoed));
  } catch (e) {
    check('WebSocket over port-forward', false, String(e));
  }

  console.log('## cleanup');
  await Promise.resolve(serverProc.kill()).catch(() => {});
  await session.stop();
  await transport.exec({ workspace: WS, command: `rm -rf ${dir}` }).catch(() => {});
  check('session.stop() + cleanup', true);

  console.log(`\n# Result: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
