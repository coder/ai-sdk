# @coder/ai-sdk-effect examples (`examples`)

## Overview

Three runnable scripts that show the bridge against a live Coder deployment. They import
the effect source through `../src/index.js` under `tsx`, so the effect package itself
needs no build. The sibling packages resolve to their `dist/`, so run `pnpm -r build`
first. The package does not publish them: `package.json` `files` lists only `dist` and
`README.md`. The package `tsconfig.json` includes `examples`, so `typecheck` checks them.

## Interface

- `01-generate.ts` generates text with `LanguageModel.generateText` over
  `CoderLanguageModel.layer(modelId, { baseURL, apiKey })`. It logs the text, the finish
  reason and the usage. Run it with `pnpm --filter @coder/ai-sdk-effect example:generate`
  [./01-generate.ts:program].
- `02-structured.ts` generates an object with `LanguageModel.generateObject` and
  `objectName: "city"`, over the same `CoderLanguageModel.layer`. It logs the decoded
  value as JSON. Run it with `pnpm --filter @coder/ai-sdk-effect example:structured`
  [./02-structured.ts:program].
- `City` is the example's Effect Schema: `name` (string), `country` (string) and
  `population` (finite number) [./02-structured.ts:City].
- `03-sandbox.ts` reads the `CoderWorkspace` service from
  `layerWorkspace({ workspace: "effect-bridge-example", ... })` and logs the workspace
  `name`, `created` and `id`. Run it with `pnpm --filter @coder/ai-sdk-effect example:sandbox`
  [./03-sandbox.ts:program].

## Invariants

- `01-generate.ts` and `02-structured.ts` read the model id from `CODER_MODEL`, with the
  default `"gpt-5.1"` [./01-generate.ts:modelId] [./02-structured.ts:modelId].
- `01-generate.ts` and `02-structured.ts` pass `baseURL: process.env.CODER_URL ??
  "https://coder.example.com"` and `apiKey: process.env.CODER_SESSION_TOKEN` (no default)
  to `CoderLanguageModel.layer` in the top-level `program.pipe(...)` call
  [./01-generate.ts:program] [./02-structured.ts:program].
- `03-sandbox.ts` reads the template from `CODER_TEMPLATE`, with the default `"docker"`,
  and passes `teardown: "delete-if-created"`. It passes no `transport`, so
  `acquireWorkspace` uses a new `CoderCliTransport` (see `packages/effect/src/sandbox.ts`).
  The script comment says it needs an ambient `coder` CLI login [./03-sandbox.ts:program].

## Side Effects

- `01-generate.ts` makes one text generation request to the Coder AI Gateway and writes
  three `Effect.log` lines [./01-generate.ts:program].
- `02-structured.ts` makes one structured generation request and writes one
  `Effect.log` line [./02-structured.ts:program].
- `03-sandbox.ts` runs the `coder` CLI to find or create the workspace
  `effect-bridge-example`, start it if stopped, and wait for agent readiness. If
  acquisition fails after this run created the workspace, `acquireWorkspace` tries to delete
  it, ignores a delete failure, and rethrows the acquisition error (see
  `packages/effect/src/sandbox.ts`). When the scope closes, `releaseWorkspace`
  deletes the workspace only when the returned `workspace.created` is true
  [./03-sandbox.ts:program].
- Each script runs with `Effect.runPromise` and no `.catch`, so a failure rejects the
  promise [./01-generate.ts:program] [./02-structured.ts:program]
  [./03-sandbox.ts:program].

## Verification

The package `tsconfig.json` includes `examples`. Typecheck needs `pnpm -r build` first:

```sh
pnpm -r build
pnpm --filter @coder/ai-sdk-effect typecheck
```

Running an example needs a live Coder deployment. Environment variables each example reads,
copied from the code:

| Script               | Env vars                                          |
| -------------------- | ------------------------------------------------- |
| `example:generate`   | `CODER_MODEL`, `CODER_URL`, `CODER_SESSION_TOKEN` |
| `example:structured` | `CODER_MODEL`, `CODER_URL`, `CODER_SESSION_TOKEN` |
| `example:sandbox`    | `CODER_TEMPLATE` (plus an ambient `coder` login)  |

```sh
pnpm --filter @coder/ai-sdk-effect example:generate
pnpm --filter @coder/ai-sdk-effect example:structured
pnpm --filter @coder/ai-sdk-effect example:sandbox
```
