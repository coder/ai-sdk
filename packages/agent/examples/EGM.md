# examples

## Overview

This directory holds runnable example scripts for `@coder/ai-sdk-agent`. They import the package
from `../src/index.js`, run under `tsx`, and are not published. The package tsconfig includes
this directory, so `typecheck` covers the examples. `_shared.ts` reads the Coder connection
settings from env vars and detects the organization when it is not set. Each numbered script
builds one `CoderAgent`, shows one feature, prints the result and archives the chat in a `finally`
block. The human guide is [README.md](./README.md).

## Interface

- `ExampleEnv` (interface): `baseUrl`, `token`, `organizationId`, `model`, and `toolModel` (the
  model for the tool-calling examples 03 and 06) [_shared.ts:ExampleEnv]
- `loadEnv` (function): resolves `ExampleEnv` from `process.env` [_shared.ts:loadEnv]
- `heading` (function): prints a bold cyan `=== title ===` heading [_shared.ts:heading]
- `01-generate.ts` (script `example:generate`): one `agent.generate()` call, then logs the text,
  finish reason, step count, usage and chat id [01-generate.ts:agent]
- `02-stream.ts` (script `example:stream`): `agent.stream()`, writing each `textStream` delta to
  stdout [02-stream.ts:agent]
- `03-custom-tool.ts` (script `example:tool`): a client-executed `rollDice` tool with a Zod input
  schema, run through `generate()` with `toolModel` [03-custom-tool.ts:agent]
- `04-multi-turn.ts` (script `example:multi-turn`): two `generate()` calls on one agent and one
  chat [04-multi-turn.ts:agent]
- `05-file-upload.ts` (script `example:file`): `agent.attach()` of the file at `process.argv[2]`,
  or of an in-memory `"q3-report.md"`, then `generate()` with `file.toFilePart()`
  [05-file-upload.ts:agent]
- `MEDIA_TYPES` (const in `05-file-upload.ts`): file extension to media type map. Unknown
  extensions use `"application/octet-stream"` [05-file-upload.ts:MEDIA_TYPES]
- `06-structured-output.ts` (script `example:structured`): `structuredOutput(schema, opts)` adds a
  `structured_output` tool and returns `agentOpts` plus `ask(agent, prompt)`, which returns the
  validated tool input. The tool's `execute` returns the `ACK` string. `agentOpts` also sets
  `stopWhen: isStepCount(opts.maxSteps ?? 6)` [06-structured-output.ts:structuredOutput]
- The script's agent in `06-structured-output.ts` sets `requestTimeoutMs: 120_000` and uses
  `toolModel` [06-structured-output.ts:agent]
- `archiveQuietly` (function in `06-structured-output.ts`): archives the chat and retries 409 and
  abort errors until a 15 s deadline, without throwing [06-structured-output.ts:archiveQuietly]
- `TriageSchema` (const in `06-structured-output.ts`): Zod schema with `severity`
  (`critical`, `major`, `minor`), `component`, `summary`, `reproSteps`
  [06-structured-output.ts:TriageSchema]

## Invariants

- `loadEnv` prints setup help to stderr and calls `process.exit(1)` when `CODER_SESSION_TOKEN` is
  unset or empty [_shared.ts:loadEnv]
- With `CODER_ORG_ID` unset or empty, `loadEnv` takes the first entry of `organization_ids` from
  `/api/v2/users/me`. It calls `process.exit(1)` on a non-OK response or an empty list
  [_shared.ts:loadEnv]
- `loadEnv` uses `??` for `CODER_URL`, `CODER_SESSION_TOKEN` and `CODER_ORG_ID`, and `||` for
  `CODER_MODEL` and `CODER_TOOL_MODEL`, so empty model values use the defaults
  [_shared.ts:loadEnv]
- `loadEnv` removes one trailing `/` from `baseUrl`. An empty `CODER_URL` gives an empty
  `baseUrl` (no default) [_shared.ts:loadEnv]
- Scripts 01 to 05 call `agent.archive()` in a `finally` block. Script 06 calls
  `archiveQuietly(agent)` there instead [06-structured-output.ts:archiveQuietly]
- `structuredOutput` throws if `opts.tools` already defines `structured_output`
  [06-structured-output.ts:structuredOutput]
- `ask()` sends the prompt. If the turn finished with `"tool-calls"`, it submits the last step's
  local client tool results, and interrupts the chat when the submit fails or a pending call has
  no local outcome. It returns the last `structured_output` input that passes
  `schema.safeParse`. It sends `NUDGE` once, only when the first turn finished with `"stop"` and
  the settle succeeded. Otherwise it throws [06-structured-output.ts:structuredOutput]
- Settle, interrupt and archive requests in script 06 use `AbortSignal.timeout` of at most
  `REQUEST_TIMEOUT_MS` (`8_000`) [06-structured-output.ts:REQUEST_TIMEOUT_MS]

## Side Effects

- Reads the env vars `CODER_URL` (default `"https://dogfood.cdr.dev"`), `CODER_SESSION_TOKEN`
  (required), `CODER_ORG_ID` (optional, detected when unset), `CODER_MODEL` (default `"haiku"`)
  and `CODER_TOOL_MODEL` (default `"sonnet"`) [_shared.ts:loadEnv]
- `loadEnv` sends `GET ${baseUrl}/api/v2/users/me` with the `Coder-Session-Token` header only when
  `CODER_ORG_ID` is unset or empty [_shared.ts:loadEnv]
- Every numbered script calls a live Coder deployment through `CoderAgent`. Script 05 first
  uploads a file with `attach()`. Each script then runs generate or stream and archives the chat
  [01-generate.ts:agent] [05-file-upload.ts:agent] [06-structured-output.ts:archiveQuietly]
- `05-file-upload.ts` reads `process.argv[2]` and, when set, opens that file with `openAsBlob`
  [05-file-upload.ts:path]
- `06-structured-output.ts` calls `client.submitToolResults`, `client.interruptChat` and
  `client.archiveChat`, and sleeps 1 s between archive retries
  [06-structured-output.ts:archiveQuietly]
- Scripts print to `console.log`, `console.warn`, `console.error` and `process.stdout`
  [_shared.ts:heading] [_shared.ts:loadEnv] [02-stream.ts:agent]
  [06-structured-output.ts:archiveQuietly]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Running an example needs a live Coder deployment. Set `CODER_SESSION_TOKEN` and optionally
  `CODER_URL`, `CODER_ORG_ID`, `CODER_MODEL` and `CODER_TOOL_MODEL`. Then run
  `pnpm --filter @coder/ai-sdk-agent <script>` from the repo root, where `<script>` is one of
  `example:generate`, `example:stream`, `example:tool`, `example:multi-turn`, `example:file` or
  `example:structured`.
