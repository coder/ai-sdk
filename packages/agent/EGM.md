# @coder/ai-sdk-agent

## Overview

This is the package root of `@coder/ai-sdk-agent`, an ESM-only npm package. It provides an AI SDK
v7 `Agent` (`CoderAgent`) and a `LanguageModelV4` (`CoderLanguageModel`) backed by Coder Agents,
Coder's server-side agent runtime (chatd). The transport is the Coder chat REST API plus the
per-chat `/stream` and per-user `/watch` WebSockets. tsup builds the single entry `src/index.ts`
into `dist/`. Vitest runs hermetic unit tests and a live e2e suite that skips without
credentials. The human guide is [README.md](./README.md). Topic guides live in `./docs/`:
[durable workflows](./docs/durable-workflows.md), [observability](./docs/observability.md),
[structured output](./docs/structured-output.md) and
[workspaces and quota](./docs/workspaces-and-quota.md).

## Interface

- Child contracts:
  - [src/EGM.md](./src/EGM.md): the package source, entry point `src/index.ts`, shared errors,
    file and transport-event modules, and the `agent`, `coder` and `model` subdirectories.
  - [examples/EGM.md](./examples/EGM.md): runnable `tsx` example scripts (not published).
- Published entry point: `exports["."]` maps `types` to `./dist/index.d.ts` and `import` to
  `./dist/index.js`. There is no `require` condition [package.json:exports]
- `main` and `module` are `./dist/index.js`. `types` is `./dist/index.d.ts`. `type` is `"module"`
  [package.json:main]
- Published files: `dist`, `docs`, `README.md` [package.json:files]
- `sideEffects` is `false` [package.json:sideEffects]
- Runtime dependencies: an exact `@ai-sdk/provider` pin and `ws` [package.json:dependencies]
- Peer dependencies: `ai` `^7.0.0`, and optional `zod` `^3.23.0 || ^4.0.0`
  [package.json:peerDependencies]
- `engines.node` is `>=22` [package.json:engines]
- Scripts: `build` (`tsup`), `typecheck` (`tsc --noEmit`), `test` and `test:unit`
  (`vitest run test/unit`), `test:e2e` (`vitest run test/e2e`), `test:watch` (`vitest`), and the
  `example:*` scripts (`tsx examples/<file>.ts`) [package.json:scripts]
- Build config: `entry` `["src/index.ts"]`, `format` `["esm"]`, `dts` `true`, `sourcemap` `true`,
  `clean` `true`, `target` `"es2022"`, `external` `["ai", "zod", "ws", "@ai-sdk/react"]`
  [tsup.config.ts:default]
- Test config: `include` `["test/**/*.test.ts"]`, `testTimeout` and `hookTimeout` `30_000`
  [vitest.config.ts:default]

## Invariants

- The package is ESM-only: `exports` has one subpath (`"."`) with `types` and `import`
  conditions [package.json:exports]
- The `test` script runs only `test/unit`. The live suite runs through `test:e2e`
  [package.json:scripts]
- The e2e suite uses `describe.skip` unless both `CODER_URL` and `CODER_SESSION_TOKEN` are
  non-empty [test/e2e/agent.e2e.test.ts:suite]
- The package `tsconfig.json` includes `src`, `test` and `examples`, so `typecheck` covers the
  examples [tsconfig.json:include]
- The `typescript` dev dependency is the TypeScript 6 alias
  (`npm:@typescript/typescript6`) for the tsup `.d.ts` build. `typescript-7` is
  `npm:typescript` [package.json:devDependencies]
- `CoderAgent` and `CoderLanguageModel` check the installed `ai` major at construction (see
  [src/EGM.md](./src/EGM.md)) [src/ai-version.ts:assertSupportedAiVersion]

## Side Effects

- `build` cleans and rewrites `dist/` (ESM `.js`, `.d.ts` and sourcemaps)
  [tsup.config.ts:default]
- Runtime network effects (Coder REST and WebSocket calls) live in `src/coder` and are driven by
  `src/model` and `src/agent` (see [src/EGM.md](./src/EGM.md))
  [src/coder/client.ts:CoderChatClient] [src/coder/ws.ts:streamChatEvents]
  [src/coder/ws.ts:watchChatEvents]
- The e2e suite and the example scripts call a live Coder deployment. They read `CODER_URL` and
  `CODER_SESSION_TOKEN`, and optionally `CODER_ORG_ID`, `CODER_MODEL` and `CODER_TOOL_MODEL`
  [examples/_shared.ts:loadEnv]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent test`
- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Optional live check: `pnpm --filter @coder/ai-sdk-agent test:e2e`. The suite self-skips unless
  `CODER_URL` and `CODER_SESSION_TOKEN` are set (`describe.skip` gate in
  `test/e2e/agent.e2e.test.ts`).
- Run: `.agents/skills/verify-agent-stream-exactly-once/check.sh`. It runs the bounded
  exactly-once check of the stream path in `test/formal/`, which `pnpm test` does not run.
