# @coder/ai-sdk-sandbox

A [Coder](https://coder.com) workspace sandbox provider for the Vercel AI SDK v7
**HarnessAgent**. It lets you run CLI coding agents inside a real Coder workspace
instead of an ephemeral cloud sandbox. Claude Code is verified end-to-end here;
Codex is expected to work via the same bridge mechanism but is not yet verified
in this repo.

It implements the `HarnessV1SandboxProvider` contract from `@ai-sdk/harness`, so
you pass it as the `sandbox` to a `HarnessAgent` exactly like
`@ai-sdk/sandbox-vercel`.

> **Status:** experimental. This provider tracks the stable AI SDK v7 harness
> packages (see the `@ai-sdk/harness` peer range in
> [`package.json`](./package.json)).

## Install

```bash
pnpm add @coder/ai-sdk-sandbox @ai-sdk/harness @ai-sdk/harness-claude-code @ai-sdk/provider-utils
```

Choose one host transport:

- `CoderNativeTransport` connects directly to Coderd and requires no `coder` or
  `ssh` binary on the host. Pass a deployment URL and token (see
  [Native transport](#native-transport)).
- The default `CoderCliTransport` requires the
  [`coder` CLI](https://coder.com/docs/install), an authenticated `coder login`,
  and an OpenSSH client (`ssh`) on PATH.

## Quick start

Wrap an existing, running workspace and run Claude Code in it:

```ts
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCoderWorkspace } from "@coder/ai-sdk-sandbox";

const agent = new HarnessAgent({
  harness: createClaudeCode({ thinking: { type: "adaptive" } }),
  sandbox: createCoderWorkspace({ workspace: "my-dev-workspace" }),
  instructions: "You are a careful coding assistant.",
});

const session = await agent.createSession();
try {
  const result = await agent.generate({
    session,
    prompt: "Create a short TODO.md in the repo root.",
  });
  console.log(result.text);
} finally {
  await session.destroy();
}
```

See [`examples/claude-code.ts`](./examples/claude-code.ts) for a runnable version.

### Native transport

Use `CoderNativeTransport` when the host should not depend on the Coder CLI or
OpenSSH:

```ts
import { CoderNativeTransport, createCoderWorkspace } from "@coder/ai-sdk-sandbox";

const transport = new CoderNativeTransport({
  url: process.env.CODER_URL!,
  token: process.env.CODER_SESSION_TOKEN!,
});

const sandbox = createCoderWorkspace({
  workspace: "my-dev-workspace",
  transport,
});

// When the application shuts down, close cached relay WebSockets:
await transport.close();
```

The constructor falls back to `CODER_URL` and `CODER_SESSION_TOKEN`, so
`new CoderNativeTransport()` is sufficient when both are set. The token is sent
only to Coderd in the `Coder-Session-Token` header; it is never copied into the
workspace.

## Creating workspaces on demand

Instead of pointing at an existing workspace, you can have the provider **create
one from a template** — with parameters and/or a preset — and tear it down when
the session ends. Add a `create` block:

```ts
const agent = new HarnessAgent({
  harness: createClaudeCode({ thinking: { type: "adaptive" } }),
  sandbox: createCoderWorkspace({
    create: {
      template: "docker", // required: the template to create from
      preset: "Large", // optional: a template version preset
      parameters: { cpus: 8, region: "us-west-2" },
      useParameterDefaults: true, // accept template defaults for the rest
      stopAfter: "8h", // auto-stop TTL
    },
  }),
});
```

By default this is **fresh-per-session**: the workspace name is derived from the
harness `sessionId` (e.g. `agent-1a2b3c4d5e6f`), so each session gets its own
workspace, and `session.destroy()` deletes it. `resumeSession` re-derives the
same name and reattaches. The provider waits for the workspace agent to finish
connecting and running its startup script (`lifecycle_state: ready`) before the
harness runs — a successful _build_ is not enough on its own.

You can also **get-or-create a named workspace** by combining `workspace` with
`create`: if it exists the provider attaches to it (and never deletes it); if it
doesn't, the provider creates it (and, by default, owns it).

```ts
createCoderWorkspace({
  workspace: "my-agent-ws",
  create: { template: "docker", ifExists: "attach" }, // 'attach' (default) | 'error'
});
```

**Parameters vs. presets.** A preset's parameter values take precedence over an
overlapping `parameters` entry of the same name (this is Coder's behavior), so
set a given value via the preset _or_ `parameters`, not both. Every unset
non-ephemeral parameter must be supplied via `parameters`, `parameterFile`, or a
`preset`, unless `useParameterDefaults` accepts its template default. Parameters
marked required have no usable default and must always be supplied; otherwise
creation fails because it cannot prompt non-interactively. If you set a `preset`,
the provider preflight-validates the name against the template's presets and
fails fast with the available names (set `validate: false` to skip).

### Create settings

```ts
createCoderWorkspace({
  create: {
    template: "docker", // required
    templateVersion: undefined, // default: the template's active version
    preset: undefined, // 'none' forces no preset
    parameters: {}, // { name: value }; numbers/bools stringified
    parameterFile: undefined, // path to a YAML rich-parameter file
    useParameterDefaults: false, // accept template defaults where unset
    ephemeralParameters: {}, // one-time build parameters
    stopAfter: undefined, // e.g. '8h' (auto-stop TTL)
    automaticUpdates: undefined, // 'always' | 'never'
    org: undefined, // --org, for ambiguous template names
    owner: undefined, // owner for a derived name (owner/name)
    ifExists: "attach", // 'attach' | 'error'
    namePrefix: "agent", // prefix for the derived per-session name
    validate: true, // preflight-check the preset name
  },
  readyTimeoutMs: 300_000, // wait budget for the agent to become ready
});
```

## Provisioning a workspace without a session

`ensureCoderWorkspace(settings)` runs the same get-or-create → start-if-stopped
→ wait-until-ready pipeline as create mode, but without creating a harness
sandbox session — use it to provision a workspace for **other tools** to bind
to. It takes an explicit `workspace` name (`[owner/]workspace`; there is no
`sessionId` to derive one from), an optional `create` block (same shape as
above; `namePrefix`/`owner` are unused), plus `readyTimeoutMs`, `transport`, and
`abortSignal`. A stopped workspace is always started. Without `create`, the
workspace must already exist.

It returns an `EnsuredCoderWorkspace`: the workspace's final (ready) status
snapshot plus `created` (whether this call created it) and — when the transport
reports one — `id`, the workspace UUID. That id is the handle other Coder
packages bind to. `@coder/ai-sdk-agent` is intentionally **not** a dependency of
this package; the two compose by a plain string handoff:

```ts
import { ensureCoderWorkspace } from "@coder/ai-sdk-sandbox";
import { CoderAgent } from "@coder/ai-sdk-agent";

const ws = await ensureCoderWorkspace({
  workspace: "agent-ws",
  create: { template: "docker" },
});

const agent = new CoderAgent({
  baseUrl: process.env.CODER_URL!,
  token: process.env.CODER_SESSION_TOKEN!,
  organizationId: "<org-uuid>",
  workspaceId: ws.id!, // binds the chat's workspace-scoped tools
});
```

The non-null assertion is safe on `coder` CLIs that emit `id` in
`coder list -o json`; old CLIs omit it, so guard
(`if (ws.id === undefined) throw …`) when you can't pin the CLI version.

## Terminal UI

For an interactive chat in your terminal instead of one-shot `generate()` calls,
wrap the same agent with the AI SDK terminal UI ([`@ai-sdk/tui`](https://ai-sdk.dev/v7/docs/ai-sdk-harnesses/terminal-ui)):

```bash
pnpm add @ai-sdk/tui
```

The TUI drives a session-less agent, so adapt the `HarnessAgent` (whose
`generate`/`stream` take a session) by injecting the session for the TUI's
lifetime:

```ts
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { runAgentTUI, type AgentTUIAgent } from "@ai-sdk/tui";
import { createCoderWorkspace } from "@coder/ai-sdk-sandbox";

const agent = new HarnessAgent({
  harness: createClaudeCode({ thinking: { type: "adaptive" } }),
  sandbox: createCoderWorkspace({ workspace: "my-dev-ws" }),
  // or, to create a fresh workspace per session from a template:
  // sandbox: createCoderWorkspace({ create: { template: 'claude-code-test' } }),
});

const toTUIAgent = (agent: HarnessAgent, session: HarnessAgentSession): AgentTUIAgent => ({
  version: "agent-v1",
  id: agent.id,
  tools: agent.tools,
  generate: (request) => agent.generate({ ...request, session }),
  stream: (request) => agent.stream({ ...request, session }),
});

const session = await agent.createSession();
try {
  await runAgentTUI({ title: "Claude Code @ Coder", agent: toTUIAgent(agent, session) });
} finally {
  await session.destroy();
}
```

See [`examples/claude-code-tui.ts`](./examples/claude-code-tui.ts) for a runnable
version: `CODER_WORKSPACE=my-dev-ws npx tsx examples/claude-code-tui.ts` (exit with
Esc or Ctrl+C).

## Workspace requirements

Because the bridge runs inside the workspace, the workspace image must have:

- **Node.js** (the docs use `node24`). The bridge is `node bridge.mjs`.
- **pnpm** available on PATH (e.g. via `corepack enable`) — the adapter uses it to
  bootstrap the bridge.
- **Outbound network access** to the npm registry (the adapter `pnpm install`s
  the bridge's dependencies + the Claude Code CLI on first use) and to the model
  API (`api.anthropic.com` for Claude Code, `api.openai.com` for Codex). Bake the
  dependencies into the image to avoid per-session installs.
- **The model API key** available to the bridge — `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`. Configure it through the adapter's `auth` option or ensure it
  is present in the workspace environment.
- `bash` and `base64` (standard on any Linux dev image).

## Settings

**At least one of `workspace` or `create` is required** (you may set both — see
[Creating workspaces on demand](#creating-workspaces-on-demand)).

```ts
import {
  createCoderWorkspace,
  CoderCliTransport,
  CoderNativeTransport,
} from "@coder/ai-sdk-sandbox";

createCoderWorkspace({
  // One of these is required (TypeScript enforces it):
  workspace: "my-ws", // fixed name, or (sessionId) => `agent-${sessionId}`
  create: undefined, // create from a template; see "Creating workspaces"

  readyTimeoutMs: 300_000, // wait budget for the agent to become ready
  ports: [4000], // exposed ports; ports[0] is the bridge port
  defaultWorkingDirectory: "/home/coder", // default: resolved from $HOME, else /home/coder
  ownsLifecycle: false, // see "Lifecycle modes" below
  ensureStarted: false, // run `coder start` before attaching

  // Transport. Defaults to an ambient-login CoderCliTransport. Configure the CLI
  // transport (binary paths, url/token, env, login shell, wait mode) — or supply
  // a non-CLI/test transport — by constructing one explicitly:
  transport: new CoderCliTransport({
    // coderBinary: 'coder', sshBinary: 'ssh',
    // url: process.env.CODER_URL, token: process.env.CODER_SESSION_TOKEN,
    // env: {}, loginShell: true, waitMode: 'no',
  }),

  // Or connect directly to Coderd with no host CLI/OpenSSH dependency:
  // transport: new CoderNativeTransport({
  //   url: process.env.CODER_URL,
  //   token: process.env.CODER_SESSION_TOKEN,
  // }),
});
```

### Lifecycle modes

- **Wrap an existing workspace (default when there's no `create`,
  `ownsLifecycle: false`).** `stop()` and `destroy()` only release host-side
  resources (port-forwards); the workspace keeps running. The natural fit for
  long-lived dev workspaces.
- **Own the workspace (`ownsLifecycle: true`).** `stop()` runs `coder stop` and
  `destroy()` runs `coder delete`.
- **Create mode (`create` set).** `ownsLifecycle` defaults to `true`, so a
  workspace the provider creates is deleted on `destroy()` and `onFirstCreate`
  runs as its bootstrap hook. As a safety measure, a workspace the provider only
  _attached_ to (an explicitly-named, pre-existing one) is **never** deleted —
  only ones it actually created. A per-session derived name is always treated as
  owned. Set `ownsLifecycle: false` for "create-if-missing but never delete".

### Ports

The adapter binds its bridge to a port and resolves it from
`createClaudeCode({ port })` or, by default, `sandbox.ports[0]`. Expose that port
via `ports` (default `[4000]`); `getPortUrl` asks the configured transport for a
local TCP forward and returns a loopback `ws://` URL. The CLI transport uses
OpenSSH `-L`; the native transport multiplexes TCP over its Coderd WebSocket.
The forward is plaintext on loopback, so `https`/`wss` requests resolve to their
`http`/`ws` loopback equivalent.

## How it works

A `HarnessAgent` doesn't run the agent CLI directly. For bridge-backed adapters
(Claude Code, Codex) it installs a small Node "bridge" program **inside the
sandbox**, spawns it, and talks to it over an **authenticated WebSocket**. The
bridge runs the vendor SDK in-workspace and streams events back to the host.

This provider maps that contract onto Coder primitives:

| Harness contract                            | CLI transport                                      | Native transport                                          |
| ------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `run` / `spawn`                             | OpenSSH over `coder ssh --stdio`                   | versioned process relay over Coderd's agent PTY WebSocket |
| `readFile` / `writeFile` / `read*`/`write*` | base64 over SSH                                    | base64 over the native process relay                      |
| `getPortUrl({ port, protocol })`            | OpenSSH `-L`                                       | multiplexed TCP channels over the relay                   |
| `createSession` / `resumeSession` / `id`    | CLI workspace lookup                               | Coderd v2 REST API                                        |
| `stop` / `destroy`                          | `coder stop` / `coder delete` when lifecycle-owned | Coderd workspace-build transitions                        |

**Why OpenSSH and not `coder ssh <ws> -- cmd`?** `coder ssh` allocates a PTY for
the command, which rewrites newlines to CRLF, merges stdout and stderr onto one
stream, and does not reliably propagate exit codes — all fatal for programmatic
use and for the bridge's stdout parsing. `coder ssh`'s own help recommends
`coder config-ssh` "for users who need the full functionality of SSH"; this
provider does the programmatic equivalent, running real OpenSSH over a
`coder ssh --stdio` ProxyCommand. That yields clean, separated streams and
correct exit codes (verified against a live workspace).

**How the native relay stays byte-clean.** Coderd's browser-terminal endpoint
is a PTY, which by itself merges stdout/stderr and has no process exit-code
channel. The native transport uses it only as a carrier: it bootstraps a small,
dependency-free Node relay, switches the PTY to raw/no-echo mode, and exchanges
versioned newline-delimited frames with base64 byte payloads. The relay launches
commands with separate pipes and also opens TCP sockets for `getPortUrl`. It
does not bind a workspace port or persist credentials/files; one relay is cached
per selected workspace agent and `transport.close()` tears it down.

The WebSocket the harness opens against `getPortUrl(...)` is the critical path,
and it needs no wildcard access URLs — the host running `HarnessAgent` is already
a Coder client. We forward via OpenSSH `-L` rather than `coder port-forward`:
the bridge sends an _unprompted_ `bridge-hello` frame immediately after the WS
upgrade, and in testing a freshly-created `coder port-forward` tunnel did not
reliably deliver that first server-initiated frame to the first WS client,
whereas SSH local forwarding does. This path is verified end-to-end against a
real workspace — both a synthetic WebSocket round-trip (`scripts/verify-real.ts`)
and a full Claude Code turn with tool use (`scripts/e2e-claude.ts`).

## Limitations & notes

- `setNetworkPolicy` is not implemented (omitted) — egress is governed by your
  Coder template/deployment, not this provider.
- `bridgePorts` is intentionally left undefined: this provider binds one
  workspace per session rather than leasing ports from a shared sandbox.
- File reads buffer the whole file (binary content moves as base64). Fine for
  bootstrap-sized files; not intended for streaming very large files.
- `CoderNativeTransport` currently targets POSIX workspaces with `bash`, `stty`,
  `base64`, and Node.js. Its default relay executable is `node`; override
  `relayNodeCommand` when Node lives at a fixed nonstandard path.
- A workspace with multiple agents must be selected as `workspace.agent`; the
  native transport refuses to guess.
- `@ai-sdk/sandbox-just-bash` cannot expose ports and is rejected by bridge-backed
  adapters — this provider exists precisely to provide that port.
- To run Claude Code / Codex, the **workspace** image needs Node.js (the adapter
  installs the bridge + CLI on first use) and egress to the npm registry and the
  model API. Provide the API key via the adapter's `auth` option.

## Development

```bash
pnpm install
pnpm typecheck   # tsc against the real harness types
pnpm test        # vitest: unit + local integration (fake `coder` + `ssh`)
pnpm build       # tsup → dist/ (ESM + d.ts)

# Formatting & linting (root-level scripts, run from the repo root):
pnpm format      # oxfmt (apply formatting)
pnpm lint        # oxlint (report lint issues)
pnpm check       # format check + lint + typecheck (CI gate)

# End-to-end against a real workspace (needs the coder CLI + a running workspace):
pnpm verify:real my-ws

# The same contract through Coderd directly. The CLI is used only to mint a
# token for this shell; CoderNativeTransport never invokes it:
CODER_URL=https://coder.example.com \
  CODER_SESSION_TOKEN="$(coder tokens create --name ai-sdk-sandbox)" \
  pnpm verify:native my-ws

# End-to-end of create mode (creates a throwaway workspace, then deletes it):
pnpm verify:create docker
```

The local integration tests exercise the real transport (argument building,
stdin, base64 file round-trips, streaming, the port-forward lifecycle, and the
create/status/presets JSON paths) against fake `coder`/`ssh` executables that run
commands locally — no Coder deployment needed. `scripts/verify-real.ts` runs the
same surface — plus a real WebSocket-over-SSH round-trip — against an actual
workspace; `scripts/verify-create.ts` creates a throwaway workspace from a
template, waits for readiness, runs a command in it, and deletes it.

## License

Apache-2.0
