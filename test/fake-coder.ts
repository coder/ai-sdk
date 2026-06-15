import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for the `coder` CLI used by the integration tests. It runs
 * commands on the local machine instead of a workspace:
 *
 * - `ssh <ws> -- <cmd...>`  → exec `<cmd...>` locally (workspace ignored)
 * - `port-forward <ws> --tcp <local>:<remote>` → a Node TCP proxy local→remote
 * - `start|stop|delete`     → no-op success
 *
 * This lets us exercise the real {@link CoderCliTransport} (argument building,
 * stdin plumbing, base64 file round-trips, stream handling, port-forward
 * lifecycle) without a live Coder deployment.
 */
const SCRIPT = `#!/usr/bin/env bash
sub="\${1:-}"; shift || true
case "$sub" in
  ssh)
    shift || true
    if [ "\${1:-}" = "--" ]; then shift; fi
    exec "$@"
    ;;
  start|stop|delete) exit 0 ;;
  port-forward)
    shift || true
    spec=""
    while [ $# -gt 0 ]; do
      case "$1" in --tcp) spec="$2"; shift 2 ;; *) shift ;; esac
    done
    lp="\${spec%%:*}"; rp="\${spec##*:}"
    exec node -e 'const net=require("net");const lp=+process.argv[1],rp=+process.argv[2];const s=net.createServer(c=>{const u=net.connect(rp,"127.0.0.1");c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());});s.listen(lp,"127.0.0.1");process.on("SIGTERM",()=>process.exit(0));' "$lp" "$rp"
    ;;
  *) echo "fake coder: unknown subcommand $sub" >&2; exit 2 ;;
esac
`;

export interface FakeCoder {
  /** Path to the fake `coder` executable. */
  path: string;
  /** Temp directory holding the executable. */
  dir: string;
  cleanup(): Promise<void>;
}

export async function createFakeCoder(): Promise<FakeCoder> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-coder-'));
  const binary = path.join(dir, 'coder');
  await writeFile(binary, SCRIPT, 'utf8');
  await chmod(binary, 0o755);
  return {
    path: binary,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * A stand-in for the OpenSSH client. The real transport invokes it two ways:
 *  - exec/file/spawn: `ssh <opts> <host> "<remote command>"` → run the final
 *    argument (the remote command) locally.
 *  - port-forward: `ssh <opts> -N -L <local>:127.0.0.1:<remote> <host>` → run a
 *    local TCP proxy from <local> to 127.0.0.1:<remote>.
 * Either way it ignores the ProxyCommand and host, letting us exercise the
 * transport without a real workspace.
 */
const SSH_SCRIPT = `#!/usr/bin/env bash
forward=""
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [ "\${args[$i]}" = "-L" ]; then forward="\${args[$((i+1))]}"; fi
done
if [ -n "$forward" ]; then
  lp="\${forward%%:*}"; rest="\${forward#*:}"; rhost="\${rest%%:*}"; rp="\${rest##*:}"
  exec node -e 'const net=require("net");const lp=+process.argv[1],rh=process.argv[2],rp=+process.argv[3];const s=net.createServer(c=>{const u=net.connect(rp,rh);c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());});s.listen(lp,"127.0.0.1");process.on("SIGTERM",()=>process.exit(0));' "$lp" "$rhost" "$rp"
else
  cmd="\${@: -1}"
  exec bash -c "$cmd"
fi
`;

export async function createFakeSsh(): Promise<FakeCoder> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-ssh-'));
  const binary = path.join(dir, 'ssh');
  await writeFile(binary, SSH_SCRIPT, 'utf8');
  await chmod(binary, 0o755);
  return {
    path: binary,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
