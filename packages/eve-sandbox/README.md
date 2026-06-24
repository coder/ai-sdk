# @coder/ai-sdk-eve-sandbox

A [Coder](https://coder.com) workspace sandbox **backend** for Vercel's [eve](https://github.com/vercel/eve) agent framework. It lets an eve agent run its sandbox (the `bash`, `read_file`, `write_file`, `glob`, `grep` tools) inside a real, long-lived Coder workspace instead of an ephemeral cloud microVM.

It implements eve's public `SandboxBackend` contract, so you pass it to `defineSandbox` exactly like the built-in `docker()` / `vercel()` backends:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { createCoderSandboxBackend } from "@coder/ai-sdk-eve-sandbox";

export default defineSandbox({
  // One Coder workspace per eve session, provisioned from a template:
  backend: createCoderSandboxBackend({
    create: { template: "docker", preset: "Large" },
  }),
});
```

Or attach to a single, pre-existing workspace:

```ts
defineSandbox({
  backend: createCoderSandboxBackend({ workspace: "my-dev-workspace" }),
});
```

> **Status:** experimental, and tracks a fast-moving target. eve is in public beta (`eve@0.11.5` at time of writing) and its sandbox interfaces may change before GA. Pin versions and expect churn.

## Install

```bash
pnpm add @coder/ai-sdk-eve-sandbox eve
```

`eve` is a peer dependency (your app provides it). The package reaches Coder through the [`coder` CLI](https://coder.com/docs/install) over SSH by default, so an authenticated `coder login` (or an explicit `url`/`token`) must be available wherever the agent runs.

> Because this package builds on `@coder/ai-sdk-sandbox`, your package manager may report `@ai-sdk/harness` and `@ai-sdk/provider-utils` as unmet peers. They are **type-only** there and are not needed at runtime; install them only if you typecheck against this package's internals.

## How it maps onto Coder

eve's sandbox abstraction and `@coder/ai-sdk-sandbox` both build their I/O surface on the Vercel AI SDK's `Experimental_SandboxSession`, so the file/exec layer maps over directly. This backend reuses `@coder/ai-sdk-sandbox` for workspace orchestration (get-or-create, wait-for-ready, `$HOME` resolution, preset validation) and adapts the result to eve's `SandboxSession`.

| eve `SandboxBackend`                       | Coder mapping                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create({ sessionKey, existingMetadata })` | Get-or-create a workspace (per-session name derived from `sessionKey`, or your fixed `workspace`); `existingMetadata` ⇒ reattach. Waits for the agent to be ready. |
| `SandboxSession.run` / `spawn`             | `coder ssh` exec / streamed process                                                                                                                                |
| `SandboxSession.read*/write*File`          | base64 over `coder ssh`                                                                                                                                            |
| `SandboxSession.removePath`                | `rm` over `coder ssh`                                                                                                                                              |
| `SandboxSession.resolvePath`               | anchors relative paths at the workspace working directory (see caveats)                                                                                            |
| `handle.captureState()`                    | `{ backendName: "coder", metadata: { workspace }, sessionKey }`                                                                                                    |
| `handle.dispose()`                         | per `dispose` policy — keep / stop / delete (default **keep**)                                                                                                     |

## Settings

`createCoderSandboxBackend(settings)`:

- `workspace?` — attach to an existing `[owner/]workspace[.agent]` (fixed string or a resolver from the session key). With `create`, it is get-or-created.
- `create?` — provision from a Coder template (`template`, `preset`, `parameters`, …). Without an explicit `workspace`, eve gets **one workspace per session**.
- `transport?` — defaults to a `CoderCliTransport` over an ambient `coder login`. Use `new CoderCliTransport({ url, token })` (re-exported from this package) for explicit auth.
- `defaultWorkingDirectory?` — defaults to the workspace `$HOME`.
- `readyTimeoutMs?` — agent-readiness timeout (default `300000`).
- `dispose?` — `"keep"` (default), `"stop"`, or `"delete"`. `"stop"`/`"delete"` apply only to per-session workspaces this backend provisions (create mode without an explicit `workspace`); an explicitly named workspace is treated as borrowed and never stopped/deleted. **At least one of `workspace` or `create` is required.**
- `allowUnsafeNetworkPolicy?` — see below.

## Caveats specific to Coder

These follow from eve's model meeting Coder's, not from missing work:

- **`prewarm` is a near no-op.** Coder templates are provisioned server-side (Terraform), so there is no build-time template snapshot to capture, and eve `seedFiles` are **not** baked in. Bake setup into your Coder template, or write files from a sandbox `onSession` hook.
- **`setNetworkPolicy` is not enforceable.** Egress is governed by your Coder template/deployment, not this backend. Anything other than `"allow-all"` **throws** by default (rather than implying containment that isn't there). Pass `allowUnsafeNetworkPolicy: true` to treat it as a no-op — but note that eve features relying on firewall **credential brokering** (e.g. the GitHub channel injecting auth headers via `setNetworkPolicy`) then silently do _not_ broker, so those flows are unsupported here.
- **Per-session workspaces have provisioning latency.** A fresh workspace is a Terraform build (minutes); set `readyTimeoutMs` accordingly. Reattach to an already-running workspace is fast — which is why `dispose` defaults to **keep**.
- **Relative paths anchor at the workspace working directory** (`$HOME` by default), not eve's `/workspace` root. eve features that write to _absolute_ `/workspace` paths (e.g. skill injection, attachment staging) require that path to exist and be writable in your Coder workspace image.

## License

Apache-2.0
