# scripts

## Overview

Manual end-to-end checks of `@coder/ai-sdk-sandbox` against a real Coder deployment. They
run through `tsx`, import from `../src`, and print one line per check. The package tsconfig
includes `scripts`, so `typecheck` compiles them. CI does not run them.

## Interface

- `verify-real.ts` runs against an existing workspace. It tests the transport directly
  (exec, exit codes 0/1/42, `workingDirectory`, `env`, stdin, separate stdout and stderr,
  spawn streaming). It tests the `file-io` helpers (text and binary round-trips, a
  line-range read, a missing file returning `null`). Then it tests `createCoderWorkspace`:
  session id, `defaultWorkingDirectory === "/home/coder"`, `session.run`, and a WebSocket
  echo through `getPortUrl`. Package scripts: `verify:real` and `verify:native`
  (`CODER_TRANSPORT=native tsx scripts/verify-real.ts`). [verify-real.ts:main]
- `verify-real.ts` argument: the first argv entry that is not `--`, default
  `"aisdk-sandbox-test"`. [verify-real.ts:WS]
- `verify-real.ts` env: `CODER_TRANSPORT`. The value `"native"` selects
  `new CoderNativeTransport({})`, which reads `CODER_URL` and `CODER_SESSION_TOKEN` (see
  `packages/sandbox/src/native-transport.ts`). Any other value selects
  `new CoderCliTransport({})`. [verify-real.ts:main]
- `verify-create.ts`: tests create mode with a throwaway workspace. Package script
  `verify:create`. Header usage: `npx tsx scripts/verify-create.ts [template] [presetTemplate]`.
  It reads no env vars. [verify-create.ts:main]
- `verify-create.ts` arguments: `process.argv[2]` template, default `"docker"`, and
  `process.argv[3]` preset template, default `"tasks-realworld"`.
  [verify-create.ts:TEMPLATE] [verify-create.ts:PRESET_TEMPLATE]
- `e2e-claude.ts`: one real Claude Code turn through `HarnessAgent`. It has no package
  script. The header gives the run command
  `E2E_WORKSPACE=aisdk-claude-e2e npx tsx scripts/e2e-claude.ts "<prompt>"`.
  [e2e-claude.ts:session]
- `e2e-claude.ts` env: `E2E_WORKSPACE` (default `"aisdk-claude-e2e"`), `E2E_PORT` (bridge
  port override), `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` (used only when
  `ANTHROPIC_API_KEY` is set). The prompt is `process.argv[2]`.
  [e2e-claude.ts:workspace] [e2e-claude.ts:auth]

## Invariants

- `verify-real.ts` and `verify-create.ts` exit with `process.exit(failed === 0 ? 0 : 1)`.
  An error thrown from `main` is logged and exits 1. [verify-create.ts:main]
  [verify-real.ts:main]
- `verify-create.ts` names its workspace `aisdk-create-<8 hex chars>`, so it does not touch a
  pre-existing workspace. [verify-create.ts:WS]
- `verify-create.ts` expects the unknown preset `"definitely-not-a-real-preset-xyz"` to be
  rejected before any workspace exists. It checks that `${WS}-never` has no status.
  [verify-create.ts:main]
- `verify-create.ts` calls `transport.destroy(WS)` in `finally` only if
  `provider.createSession()` returned and the workspace status is not `null` and not
  `"deleted"`. A `createSession()` throw skips this cleanup, so a workspace it created
  before the throw stays behind. [verify-create.ts:main]
- `verify-real.ts` cleans up (kills the echo server, stops the session, removes its temp
  folder) in straight-line code, not in `finally`. A throw before cleanup leaves them behind.
  [verify-real.ts:main]
- `e2e-claude.ts` calls `session.destroy()` in `finally`. It does not call `process.exit`.
  [e2e-claude.ts:session]

## Side Effects

- `verify-create.ts` creates a workspace from the template, runs `uname -sr` in it, deletes
  it, and polls status every 3000 ms for up to 120000 ms until it is gone.
  [verify-create.ts:main]
- `verify-real.ts` writes `/tmp/aisdk-verify-<timestamp>/` files in the workspace, starts a
  Python WebSocket echo server on workspace port 4000, and opens a local forward to it.
  [verify-real.ts:PORT] [verify-real.ts:WS_SERVER_PY]
- `e2e-claude.ts` installs the Claude Code bridge in the workspace on first use and calls
  the Anthropic API through it. [e2e-claude.ts:session]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-sandbox typecheck`
- Live (needs a Coder deployment; the CLI transport needs the `coder` CLI on PATH and
  logged in, and an OpenSSH client (`ssh`) on PATH):
  - `pnpm --filter @coder/ai-sdk-sandbox verify:real` (reads `CODER_TRANSPORT`)
  - `pnpm --filter @coder/ai-sdk-sandbox verify:native` (needs `CODER_URL` and
    `CODER_SESSION_TOKEN`)
  - `pnpm --filter @coder/ai-sdk-sandbox verify:create` (reads no env vars)
