import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in for the `coder` CLI used by the integration tests. It runs
 * commands on the local machine instead of a workspace:
 *
 * - `ssh <ws> -- <cmd...>`  → exec `<cmd...>` locally (workspace ignored)
 * - `create <name> …`       → records `<name>` in a state dir (get-or-create)
 * - `list --search …`       → emits a ready-workspace JSON array iff created
 * - `templates presets list` → emits a wrapped PascalCase preset JSON array
 * - `start|stop`            → no-op success; `delete` clears the state file
 *
 * Port-forwarding is NOT handled here: the real transport tunnels via OpenSSH
 * (`ssh -N -L`), which the fake ssh's `-L` branch handles, so `coder` never sees
 * a `port-forward` subcommand.
 *
 * This lets us exercise the real {@link CoderCliTransport} (argument building,
 * stdin plumbing, base64 file round-trips, stream handling, port-forward
 * lifecycle, and the create/status/presets JSON paths) without a live Coder
 * deployment.
 */
const SCRIPT = `#!/usr/bin/env bash
STATE_DIR="$(dirname "$0")/state"
sub="\${1:-}"; shift || true
case "$sub" in
  ssh)
    shift || true
    if [ "\${1:-}" = "--" ]; then shift; fi
    exec "$@"
    ;;
  start|stop) exit 0 ;;
  delete)
    base=""
    while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) base="\${1##*/}"; shift ;; esac; done
    rm -f "$STATE_DIR/$base" 2>/dev/null || true
    exit 0
    ;;
  create)
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --template|--template-version|--preset|--parameter|--rich-parameter-file|--ephemeral-parameter|--stop-after|--automatic-updates|--org|-O)
          shift 2 ;;
        --yes|-y|--use-parameter-defaults) shift ;;
        -*) shift ;;
        *) if [ -z "$name" ]; then name="$1"; fi; shift ;;
      esac
    done
    base="\${name##*/}"
    mkdir -p "$STATE_DIR"
    echo ready > "$STATE_DIR/$base"
    exit 0
    ;;
  list)
    search=""
    while [ $# -gt 0 ]; do
      case "$1" in --search) search="$2"; shift 2 ;; -o|--output|-c|--column) shift 2 ;; *) shift ;; esac
    done
    name="\${search##*name:}"; name="\${name%% *}"; base="\${name##*/}"
    if [ -n "$base" ] && [ -f "$STATE_DIR/$base" ]; then
      printf '[{"name":"%s","latest_build":{"status":"running","transition":"start","resources":[{"agents":[{"name":"main","status":"connected","lifecycle_state":"ready"}]}]}}]' "$base"
    else
      printf '[]'
    fi
    exit 0
    ;;
  templates)
    printf '[{"TemplatePreset":{"ID":"00000000-0000-0000-0000-000000000000","Name":"Standard","Parameters":[],"Default":true,"DesiredPrebuildInstances":0,"Description":"","Icon":""}}]'
    exit 0
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-coder-"));
  const binary = path.join(dir, "coder");
  await writeFile(binary, SCRIPT, "utf8");
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-ssh-"));
  const binary = path.join(dir, "ssh");
  await writeFile(binary, SSH_SCRIPT, "utf8");
  await chmod(binary, 0o755);
  return {
    path: binary,
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
