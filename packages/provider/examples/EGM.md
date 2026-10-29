# @coder/ai-sdk-provider examples (`examples`)

## Overview

This directory holds three runnable scripts that call a live Coder deployment through
`createCoder`. They import from `../src/index.js`, so `tsx` runs them against the source,
not against `dist/`. They are not published: `package.json:files` lists only `dist`, `docs`
and `README.md`. For setup and run steps written for humans, see [README.md](./README.md).

## Interface

- `ExampleEnv` is `{ baseURL: string; apiKey: string; model: string }`
  [_shared.ts:ExampleEnv]
- `loadEnv()` reads the connection details from the environment and returns an
  `ExampleEnv` [_shared.ts:loadEnv]
- `heading(title)` prints `=== <title> ===` in bold cyan to stdout [_shared.ts:heading]
- `01-generate.ts` calls `generateText` with `coder(model)`, the routed bare call. Script:
  `example:generate` [01-generate.ts:coder]
- `02-stream.ts` calls `streamText` with `coder(model)` and streams `textStream` to stdout.
  Script: `example:stream` [02-stream.ts:result]
- `03-anthropic.ts` calls `generateText` with `coder.anthropic(model)`, which pins the
  Anthropic surface for any model id. Script: `example:anthropic`
  [03-anthropic.ts:model]

## Invariants

- Environment variables read by `loadEnv`:
  - `CODER_URL`, default `"https://dogfood.cdr.dev"`. One trailing `/` is removed.
  - `CODER_API_TOKEN ?? CODER_SESSION_TOKEN`. `CODER_SESSION_TOKEN` is used only when
    `CODER_API_TOKEN` is unset, so an empty `CODER_API_TOKEN` does not fall back.
  - `CODER_MODEL`, default `"claude-sonnet-4-6"`.

  [_shared.ts:loadEnv]

- When the resolved token is empty, `loadEnv` throws nothing. It prints a help text to
  stderr and calls `process.exit(1)` [_shared.ts:loadEnv]
- Each example calls `loadEnv()` at module top level before `createCoder`, so a missing
  token exits before any network call [01-generate.ts:coder]
- `03-anthropic.ts` ignores `loadEnv().model`. It reads `CODER_ANTHROPIC_MODEL`, default
  `"claude-sonnet-4-6"`, so `CODER_MODEL` has no effect there [03-anthropic.ts:model]

## Side Effects

- `loadEnv` reads `process.env` and can end the process with exit code 1
  [_shared.ts:loadEnv]
- `01-generate.ts` sends one generate request and prints `Answer`, `Finish reason` and
  `Usage` lines to stdout [01-generate.ts:coder]
- `02-stream.ts` sends one streaming request, writes each text delta to stdout, then prints
  a `Usage` line [02-stream.ts:result]
- `03-anthropic.ts` sends one generate request to the Anthropic surface and prints the
  text [03-anthropic.ts:model]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-provider typecheck` (the package `tsconfig.json`
  includes `examples`)
- Live run (needs a deployment with AI Gateway enabled): set `CODER_API_TOKEN` (or
  `CODER_SESSION_TOKEN`), and optionally `CODER_URL`, `CODER_MODEL` and
  `CODER_ANTHROPIC_MODEL`. Then run one of these from the repo root:

```sh
pnpm --filter @coder/ai-sdk-provider example:generate
pnpm --filter @coder/ai-sdk-provider example:stream
pnpm --filter @coder/ai-sdk-provider example:anthropic
```
