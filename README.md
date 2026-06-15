# @coder/ai-sdk-sandbox

A [Coder](https://coder.com) workspace sandbox provider for the Vercel AI SDK v7
**HarnessAgent**. It lets you run CLI coding agents — Claude Code, Codex — inside
a real Coder workspace instead of an ephemeral cloud sandbox.

It implements the `HarnessV1SandboxProvider` contract from `@ai-sdk/harness`, so
you pass it as the `sandbox` to a `HarnessAgent` exactly like
`@ai-sdk/sandbox-vercel`.

> **Status:** experimental. The AI SDK harness packages are published under the
> `@canary` tag and their APIs can change between releases. This provider tracks
> `@ai-sdk/harness@1.0.0-canary.11`.

## How it works

A `HarnessAgent` doesn't run the agent CLI directly. For bridge-backed adapters
(Claude Code, Codex) it installs a small Node "bridge" program **inside the
sandbox**, spawns it, and talks to it over an **authenticated WebSocket**. The
bridge runs the vendor SDK in-workspace and streams events back to the host.

This provider maps that contract onto Coder primitives:

| Harness contract | Coder implementation |
| --- | --- |
| `run` / `spawn` | OpenSSH `bash -lc '…'` over a `coder ssh --stdio` ProxyCommand |
| `readFile` / `writeFile` / `read*`/`write*` | base64 piped over the SSH connection (binary-safe) |
| `getPortUrl({ port, protocol })` | OpenSSH `-L <local>:127.0.0.1:<port>` over the same ProxyCommand → `ws://127.0.0.1:<local>` |
| `ports` / `setPorts` | the workspace's exposed port set |
| `createSession` / `resumeSession` / `id` | attach to a workspace by name |
| `stop` / `destroy` | `coder stop` / `coder delete` (only when it owns the lifecycle) |

**Why OpenSSH and not `coder ssh <ws> -- cmd`?** `coder ssh` allocates a PTY for
the command, which rewrites newlines to CRLF, merges stdout and stderr onto one
stream, and does not reliably propagate exit codes — all fatal for programmatic
use and for the bridge's stdout parsing. `coder ssh`'s own help recommends
`coder config-ssh` "for users who need the full functionality of SSH"; this
provider does the programmatic equivalent, running real OpenSSH over a
`coder ssh --stdio` ProxyCommand. That yields clean, separated streams and
correct exit codes (verified against a live workspace).

The WebSocket the harness opens against `getPortUrl(...)` is the critical path,
and it needs no wildcard access URLs — the host running `HarnessAgent` is already
a Coder client. We forward via OpenSSH `-L` rather than `coder port-forward`:
the bridge sends an *unprompted* `bridge-hello` frame immediately after the WS
upgrade, and in testing a freshly-created `coder port-forward` tunnel did not
reliably deliver that first server-initiated frame to the first WS client,
whereas SSH local forwarding does. This path is verified end-to-end against a
real workspace — both a synthetic WebSocket round-trip (`scripts/verify-real.ts`)
and a full Claude Code turn with tool use (`scripts/e2e-claude.ts`).

## Install

```bash
npm add @coder/ai-sdk-sandbox @ai-sdk/harness@canary @ai-sdk/harness-claude-code@canary
```

On the host you also need:

- the [`coder` CLI](https://coder.com/docs/install) on PATH and authenticated
  (`coder login`), or pass `url` + `token` to `createCoderSandbox`;
- an **OpenSSH client** (`ssh`) on PATH — exec runs through it (see "How it works").

## Quick start

Wrap an existing, running workspace and run Claude Code in it:

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCoderSandbox } from '@coder/ai-sdk-sandbox';

const agent = new HarnessAgent({
  harness: createClaudeCode({ thinking: 'adaptive' }),
  sandbox: createCoderSandbox({ workspace: 'my-dev-workspace' }),
  instructions: 'You are a careful coding assistant.',
});

const session = await agent.createSession();
try {
  const result = await agent.generate({
    session,
    prompt: 'Create a short TODO.md in the repo root.',
  });
  console.log(result.text);
} finally {
  await session.destroy();
}
```

See [`examples/claude-code.ts`](./examples/claude-code.ts) for a runnable version.

## Creating workspaces on demand

Instead of pointing at an existing workspace, you can have the provider **create
one from a template** — with parameters and/or a preset — and tear it down when
the session ends. Add a `create` block:

```ts
const agent = new HarnessAgent({
  harness: createClaudeCode({ thinking: 'adaptive' }),
  sandbox: createCoderSandbox({
    create: {
      template: 'docker',                 // required: the template to create from
      preset: 'Large',                    // optional: a template version preset
      parameters: { cpus: 8, region: 'us-west-2' },
      useParameterDefaults: true,         // accept template defaults for the rest
      stopAfter: '8h',                    // auto-stop TTL
    },
  }),
});
```

By default this is **fresh-per-session**: the workspace name is derived from the
harness `sessionId` (e.g. `agent-1a2b3c4d5e6f`), so each session gets its own
workspace, and `session.destroy()` deletes it. `resumeSession` re-derives the
same name and reattaches. The provider waits for the workspace agent to finish
connecting and running its startup script (`lifecycle_state: ready`) before the
harness runs — a successful *build* is not enough on its own.

You can also **get-or-create a named workspace** by combining `workspace` with
`create`: if it exists the provider attaches to it (and never deletes it); if it
doesn't, the provider creates it (and, by default, owns it).

```ts
createCoderSandbox({
  workspace: 'my-agent-ws',
  create: { template: 'docker', ifExists: 'attach' }, // 'attach' (default) | 'error'
})
```

**Parameters vs. presets.** A preset's parameter values take precedence over an
overlapping `parameters` entry of the same name (this is Coder's behavior), so
set a given value via the preset *or* `parameters`, not both. Required
parameters (those without a template default) must be supplied via `parameters`,
`parameterFile`, a `preset`, or `useParameterDefaults` — otherwise creation
fails (it can't prompt non-interactively). If you set a `preset`, the provider
preflight-validates the name against the template's presets and fails fast with
the available names (set `validate: false` to skip).

### Create settings

```ts
createCoderSandbox({
  create: {
    template: 'docker',           // required
    templateVersion: undefined,   // default: the template's active version
    preset: undefined,            // 'none' forces no preset
    parameters: {},               // { name: value }; numbers/bools stringified
    parameterFile: undefined,     // path to a YAML rich-parameter file
    useParameterDefaults: false,  // accept template defaults where unset
    ephemeralParameters: {},      // one-time build parameters
    stopAfter: undefined,         // e.g. '8h' (auto-stop TTL)
    automaticUpdates: undefined,  // 'always' | 'never'
    org: undefined,               // --org, for ambiguous template names
    owner: undefined,             // owner for a derived name (owner/name)
    ifExists: 'attach',           // 'attach' | 'error'
    namePrefix: 'agent',          // prefix for the derived per-session name
    validate: true,               // preflight-check the preset name
  },
  readyTimeoutMs: 300_000,        // wait budget for the agent to become ready
})
```

## Workspace requirements

Because the bridge runs inside the workspace, the workspace image must have:

- **Node.js** (the docs use `node24`). The bridge is `node bridge.mjs`.
- **Outbound network access** to the npm registry (the adapter `pnpm install`s
  the bridge's dependencies + the Claude Code CLI on first use) and to the model
  API (`api.anthropic.com` for Claude Code, `api.openai.com` for Codex). Bake the
  dependencies into the image to avoid per-session installs.
- **The model API key** available to the bridge — `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`. Configure it through the adapter's `auth` option or ensure it
  is present in the workspace environment.
- `bash` and `base64` (standard on any Linux dev image).

## Settings

```ts
createCoderSandbox({
  // Which workspace to use: a fixed name, or a resolver from the harness sessionId.
  // In create mode, omit it to derive a fresh per-session name; otherwise it
  // falls back to using the sessionId as the workspace name.
  workspace: 'my-ws',                       // or: (sessionId) => `agent-${sessionId}`

  create: undefined,                        // create from a template; see "Creating workspaces"
  readyTimeoutMs: 300_000,                  // wait budget for the agent to become ready

  ports: [4000],                            // exposed ports; ports[0] is the bridge port
  defaultWorkingDirectory: '/home/coder',   // default: resolved from $HOME, else /home/coder
  ownsLifecycle: false,                     // see "Lifecycle modes" below
  ensureStarted: false,                     // run `coder start` before attaching

  // coder CLI options (used by the default transport):
  coderBinary: 'coder',
  url: process.env.CODER_URL,               // sets CODER_URL; else ambient `coder login`
  token: process.env.CODER_SESSION_TOKEN,   // sets CODER_SESSION_TOKEN
  env: {},                                  // extra env for every `coder` call
  loginShell: true,                         // remote commands run via `bash -lc`

  // Advanced: inject your own transport (tests / non-CLI backends).
  transport: undefined,
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
  *attached* to (an explicitly-named, pre-existing one) is **never** deleted —
  only ones it actually created. A per-session derived name is always treated as
  owned. Set `ownsLifecycle: false` for "create-if-missing but never delete".

### Ports

The adapter binds its bridge to a port and resolves it from
`createClaudeCode({ port })` or, by default, `sandbox.ports[0]`. Expose that port
via `ports` (default `[4000]`); `getPortUrl` opens a `coder port-forward` tunnel
to it on demand and returns a loopback `ws://` URL. A `--tcp` tunnel is plaintext,
so `https`/`wss` requests resolve to their `http`/`ws` loopback equivalent.

## Limitations & notes

- `setNetworkPolicy` is not implemented (omitted) — egress is governed by your
  Coder template/deployment, not this provider.
- `bridgePorts` is intentionally left undefined: this provider binds one
  workspace per session rather than leasing ports from a shared sandbox.
- File reads buffer the whole file (binary content moves as base64). Fine for
  bootstrap-sized files; not intended for streaming very large files.
- `@ai-sdk/sandbox-just-bash` cannot expose ports and is rejected by bridge-backed
  adapters — this provider exists precisely to provide that port.
- To run Claude Code / Codex, the **workspace** image needs Node.js (the adapter
  installs the bridge + CLI on first use) and egress to the npm registry and the
  model API. Provide the API key via the adapter's `auth` option.

## Development

```bash
npm install
npm run typecheck   # tsc against the real canary harness types
npm test            # vitest: unit + local integration (fake `coder` + `ssh`)
npm run build       # tsup → dist/ (ESM + d.ts)

# End-to-end against a real workspace (needs the coder CLI + a running workspace):
npm run verify:real -- my-ws

# End-to-end of create mode (creates a throwaway workspace, then deletes it):
npm run verify:create -- docker
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
