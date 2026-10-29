# examples

## Overview

Runnable examples that drive Claude Code inside a Coder workspace through the AI SDK
`HarnessAgent` and `createCoderWorkspace` from `../src/index.js`. They are not published
(release-please ignores `packages/*/examples`), but the package tsconfig includes them, so
`typecheck` compiles them. No package script runs them. The `template` child holds a sample
Coder template and workspace image for these sessions.

## Interface

- `claude-code.ts`: sends one prompt to Claude Code in an existing workspace and prints
  `result.text`. The prompt is `process.argv[2]`, default
  `"Create a short TODO.md in the repository root with three improvement ideas."`. The
  header gives the run command
  `CODER_WORKSPACE=my-dev-ws npx tsx examples/claude-code.ts "Summarize this repo"`.
  [claude-code.ts:main]
- `claude-code-tui.ts`: an interactive terminal chat through `runAgentTUI` from
  `@ai-sdk/tui`, in an existing workspace. The header gives the run command
  `CODER_WORKSPACE=my-dev-ws npx tsx examples/claude-code-tui.ts`.
  [claude-code-tui.ts:main]
- `toTUIAgent` (internal) adapts a `HarnessAgent` and one session into an `AgentTUIAgent`
  by adding `session` to every `generate` and `stream` request.
  [claude-code-tui.ts:toTUIAgent]
- `create-workspace.ts`: create mode. It calls
  `createCoderWorkspace({ create: { template, useParameterDefaults: true } })` without a
  `workspace`, so the provider derives the name from the harness session id. The prompt is
  `process.argv[2]`, default `"Print the OS and kernel version, then list the home directory."`.
  The header gives the run command
  `CODER_TEMPLATE=claude-code-test npx tsx examples/create-workspace.ts "Summarize this repo"`.
  [create-workspace.ts:main]
- Env vars read: `CODER_WORKSPACE` (`claude-code.ts`, `claude-code-tui.ts`) and
  `CODER_TEMPLATE` (`create-workspace.ts`), with no defaults. `CODER_URL` and
  `CODER_SESSION_TOKEN` appear only in a commented-out line. [claude-code.ts:main]
- Child: [template](./template/EGM.md) - Coder Terraform template (`main.tf`) and
  `Dockerfile` that pre-bakes the Claude Code bridge bootstrap.

## Invariants

- `claude-code.ts` and `claude-code-tui.ts` throw
  `"Set CODER_WORKSPACE to the workspace to use, e.g. CODER_WORKSPACE=my-dev-ws"` before
  they build the agent when `CODER_WORKSPACE` is unset or empty. [claude-code.ts:main]
- `create-workspace.ts` throws when `CODER_TEMPLATE` is unset or empty.
  [create-workspace.ts:main]
- After `agent.createSession()` succeeds, each `main` calls `session.destroy()` in a
  `finally` block. [create-workspace.ts:main]
- A rejection from `main` is logged with `console.error` and sets `process.exitCode = 1`.
  [claude-code-tui.ts:main]

## Side Effects

- `claude-code.ts` and `claude-code-tui.ts` run commands in an existing workspace. A comment
  in `claude-code.ts` says `ownsLifecycle` defaults to `false` for a wrapped workspace, so
  `destroy` leaves it alone. [claude-code.ts:main]
- `create-workspace.ts` creates a workspace from `CODER_TEMPLATE`. A comment says
  `session.destroy()` deletes the workspace that this session created.
  [create-workspace.ts:main]
- The header prerequisites list the `coder` CLI logged in, outbound access to the npm
  registry and `api.anthropic.com`, and `ANTHROPIC_API_KEY` available to the bridge. The
  examples do not read `ANTHROPIC_API_KEY` themselves. [claude-code.ts:main]
- `claude-code-tui.ts` takes over the terminal until Esc or Ctrl+C. [claude-code-tui.ts:main]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-sandbox typecheck`
