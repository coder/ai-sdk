# @coder/ai-sdk-effect

[![CI](https://github.com/coder/ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-effect.svg)](https://www.npmjs.com/package/@coder/ai-sdk-effect)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

An [Effect](https://effect.website) bridge for `@coder/ai-sdk-provider` (Coder
AI Gateway), `@coder/ai-sdk-agent` (Coder Agents), and `@coder/ai-sdk-sandbox`
(workspace sandboxes):

| Feature                                                                             | API                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`effect/ai` `LanguageModel` over AI Gateway](#languagemodel-over-coder-ai-gateway) | `CoderLanguageModel.layer`, `CoderLanguageModel.fromModel`               |
| [`effect/ai` `LanguageModel` over Coder Agents](#languagemodel-over-coder-agents)   | `CoderAgentModel.layer`, `CoderAgentModel.withAgentOptions`              |
| [Typed `AiError` failures](#typed-error-taxonomy)                                   | `classifyError`, `isTransient`                                           |
| [Effect Schema → Vercel AI SDK schemas](#effect-schema--vercel-ai-sdk-schemas)      | `toAiSdkSchema`                                                          |
| [Scoped workspace `Layer`s](#scoped-sandbox-layers)                                 | `acquireWorkspace` / `layerWorkspace`, `acquireSession` / `layerSession` |

## Install

```bash
pnpm add @coder/ai-sdk-effect effect@~4.0.0 ai@^7
```

Requires Node ≥ 22, `effect` 4.0.x, and `ai` v7. The package depends on
`@coder/ai-sdk-provider`, `@coder/ai-sdk-agent`, and `@coder/ai-sdk-sandbox`,
so you do not install them separately.

> [!IMPORTANT]
> **Stability.** Effect 4 marks its AI modules (`effect/ai/*`) as unstable,
> and unstable Effect APIs can break in a minor release. The `effect` peer
> range is therefore patch-only (`~4.0.0`). Support for a new `effect` minor
> comes in a new release of this package. This package is pre-1.0, and its own
> API can also change between minor versions.

## `LanguageModel` over Coder AI Gateway

`CoderLanguageModel.layer(modelId, source, generation?)` implements Effect 4's
`effect/ai` `LanguageModel` service on top of the gateway.

- **`source`:** `CoderProviderSettings`, or `{ provider }` for an existing
  `CoderProvider`. Both auth modes (centralized and BYOK) work unchanged.
- **Supported calls:** `generateText`, `generateObject`, and `streamText`.
  Tool parameters and structured outputs derive their JSON schema from the
  Effect Schema you pass (see [JSON Schema dialect](#json-schema-dialect)).
- **`toolChoice`:** forwarded on every call, including `"none"` when there is
  no toolkit. A `oneOf` subset sends only those tools with its `mode`. A
  choice that requires a tool call fails with `InvalidRequestError` when no
  tool is left to call.
- **`generation` (`GenerationOptions`):** `maxOutputTokens`, `temperature`,
  `topP`, `topK`, penalties, `stopSequences`, `seed`, `reasoning`,
  `providerOptions`. Set at construction time and forwarded on every call.
- **Per-call overrides:** `CoderLanguageModel.withGenerationOptions(overrides)`
  provides the `GenerationConfig` service to one effect. Its keys win over the
  construction options; nested overrides merge, innermost first.

```ts
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import { CoderLanguageModel } from "@coder/ai-sdk-effect";

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: "In one sentence, what is Coder AI Gateway?",
  });
  return response.text;
});

program.pipe(
  Effect.provide(
    CoderLanguageModel.layer("gpt-5.1", {
      baseURL: "https://coder.example.com",
      apiKey: process.env.CODER_SESSION_TOKEN,
    }),
  ),
  Effect.runPromise,
);
```

```ts
import * as LanguageModel from "effect/ai/LanguageModel";
import { CoderLanguageModel } from "@coder/ai-sdk-effect";

const deterministic = LanguageModel.generateText({ prompt: "Name a color." }).pipe(
  CoderLanguageModel.withGenerationOptions({ temperature: 0, seed: 1 }),
);
```

`CoderLanguageModel.fromModel` (the bridge core) adapts any AI SDK
`LanguageModelV4`; unit tests use it to run without HTTP.

### Usage metadata

The finish part's `usage` holds the normalized token counts. `effect/ai`'s
`Response.Usage` has no field for the provider's raw usage
(`LanguageModelV4Usage.raw`), so the bridge puts it in the finish part's
`metadata.coder.rawUsage` as plain JSON. The key is present only when the
provider reports raw usage. For the Coder Agents model, it is chatd's wire
usage (snake_case fields such as `input_tokens` and `context_limit`). The
`CoderFinishMetadata` type describes `metadata.coder`, and the same rule
applies on the generate and stream paths.

```ts
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import type { CoderFinishMetadata } from "@coder/ai-sdk-effect";

const rawUsage = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({ prompt: "hello" });
  const finish = response.content.find((part) => part.type === "finish");
  const coder = finish?.metadata.coder as CoderFinishMetadata | undefined;
  return coder?.rawUsage;
});
```

## `LanguageModel` over Coder Agents

`CoderAgentModel.layer(settings)` implements `LanguageModel` on top of a Coder
Agents chat (chatd) through `@coder/ai-sdk-agent`'s `CoderLanguageModel`. The
agent loop runs server-side; the layer adapts it to Effect.

- **`settings`:** the agent's `CoderLanguageModelConfig` (`organizationId`,
  `model`, `reasoningEffort`, `workspaceId`, `chatId`, `requestTimeoutMs`,
  ...) plus `client`, or `baseUrl` + `token` (default: `CODER_URL` +
  `CODER_SESSION_TOKEN`).
- **One chat per layer.** chatd keeps the history. Each call sends only the
  prompt's newest user message, or the results of client tools. System
  messages apply when the chat is created. Calls are single-flight.
- **Tools.** Toolkit tools run client-side: `effect/ai` resolves the tool
  calls, and the next call sends the results back to the same chat. chatd's
  server-side tools are reported in the finish part's
  `metadata.coder.serverToolCalls`.
  chatd registers client tools only when the chat is created, so the toolkit
  cannot change afterwards, and only the `auto` tool choice is supported.
  Other cases fail with `InvalidRequestError`. `toolChoice` governs toolkit tools
  only; chatd's server-side tools come from `settings` (`workspaceId`,
  `mcpServerIds`). A chat resumed with `settings.chatId` keeps the client
  tools it was created with, and the layer cannot verify them: pass the same
  toolkit, and set `requestTimeoutMs`.
- **Structured output.** `generateObject` fails with `InvalidRequestError`: chatd
  enforces no schema. Use the AI Gateway model for structured output.
- **Interruption.** Interrupting the fiber aborts the call. The agent then
  interrupts the chat's run server-side, exactly once.
- **Scope.** Closing the layer's scope disposes the model and closes its
  event stream. The chat is not archived. To archive chats, collect their ids
  from `segment:*` events in `onTransportEvent`.
- **Per-call options.** `CoderAgentModel.withAgentOptions({ model, reasoningEffort })`
  changes these for one call on the same chat. A change is refused while
  client tool results are submitted, because that continues a turn in
  progress.
- **Generation options.** Sampling controls (`temperature`,
  `maxOutputTokens`, ...) and `providerOptions` other than `coder` fail with
  `InvalidRequestError`, because chatd chooses them.

```ts
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import { CoderAgentModel } from "@coder/ai-sdk-effect";

const program = Effect.gen(function* () {
  const first = yield* LanguageModel.generateText({ prompt: "Summarize the repo README." });
  const second = yield* LanguageModel.generateText({ prompt: "Now in one line." }).pipe(
    CoderAgentModel.withAgentOptions({ reasoningEffort: "high" }),
  );
  return [first.text, second.text];
});

program.pipe(
  Effect.provide(
    CoderAgentModel.layer({ organizationId: "<org-uuid>", model: "claude-sonnet-4-5" }),
  ),
  Effect.runPromise,
);
```

## Typed error taxonomy

`classifyError` maps an `AiError`, a raw AI SDK error, or a raw
`@coder/ai-sdk-agent` error to one of: `auth`, `rate-limit`, `quota`,
`provider-unavailable`, `malformed-response`, `transport`, `timeout`,
`unknown`. `isTransient` composes with `Effect.retry`:

```ts
import * as LanguageModel from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isTransient } from "@coder/ai-sdk-effect";

const resilient = LanguageModel.generateText({ prompt: "hello" }).pipe(
  Effect.retry({
    while: (error) => isTransient(error),
    schedule: Schedule.exponential("250 millis"),
    times: 3,
  }),
);
```

`effect/ai` fails with one `AiError` class whose `reason` is one of a closed
set of tagged classes, so the bridge maps every failure onto those reasons
instead of adding its own error classes:

- HTTP failures keep the request method and URL, the response status and
  headers, and the body in the reason's `http` field.
- A `RateLimitError` from an AI Gateway response sets `retryAfter` from a
  valid `Retry-After` header (delay-seconds, or an HTTP-date). Read it as
  `error.retryAfter`, for example to pick a retry delay.
- HTTP 402 means the account's quota or billing limit is exhausted. It maps
  to `QuotaExhaustedError` and the `quota` classification, which is not
  transient: a retry cannot succeed until someone raises the limit. HTTP 429
  stays a transient `rate-limit`.
- The reason's `metadata.coder` records the classification and, when the
  source error has them, the HTTP `status`, the Coder Agents `retryable`
  verdict, the chat error's `kind` and `provider`, and the stream's `chatId`.
- An explicit Coder Agents verdict decides `isTransient`. The agent sets
  `CoderStreamError.isRetryable` to `false` when replaying the prompt would
  repeat server-side effects.
- A `false` verdict turns a reason that Effect calls retryable into an
  `UnknownError`, so the reason's own `isRetryable` never invites that retry.
- Fiber interruption stays Effect interruption. It never becomes an `AiError`.

<details>
<summary>How source errors map to <code>AiError</code> reasons</summary>

| Source error                                                      | `AiError` reason                                                 | `classifyError`                   | `isTransient` | Reason `isRetryable`            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | ------------- | ------------------------------- |
| `APICallError` or `CoderApiError`, status 401 / 403               | `AuthenticationError` (`InvalidKey` / `InsufficientPermissions`) | `auth`                            | `false`       | `false`                         |
| status 402                                                        | `QuotaExhaustedError`                                            | `quota`                           | `false`       | `false`                         |
| status 429                                                        | `RateLimitError` (`retryAfter` from `Retry-After`)               | `rate-limit`                      | `true`        | `true`                          |
| status 5xx                                                        | `InternalProviderError`                                          | `provider-unavailable`            | `true`        | `true`                          |
| status 400                                                        | `InvalidRequestError`                                            | `unknown`                         | `false`       | `false`                         |
| any other status                                                  | `UnknownError`                                                   | `unknown`                         | `false`       | `false`                         |
| `APICallError` without a status (network failure)                 | `NetworkError` (`TransportError`)                                | `transport`                       | `true`        | `true`                          |
| `CoderStreamError`                                                | `UnknownError`                                                   | `transport`                       | `isRetryable` | `false`                         |
| `CoderChatError` with `kind: "timeout"`                           | `UnknownError`                                                   | `timeout`                         | `retryable`   | `false`                         |
| `CoderChatError` with `kind: "stream_closed"`                     | `UnknownError`                                                   | `transport`                       | `retryable`   | `false`                         |
| any other `CoderChatError`                                        | from `statusCode` as above, else `UnknownError`                  | from `statusCode`, else `unknown` | `retryable`   | `false` if `retryable` is false |
| `JSONParseError`, `TypeValidationError`, `EmptyResponseBodyError` | `InvalidOutputError`                                             | `malformed-response`              | `false`       | `true` (Effect's view)          |
| `NoSuchModelError`, `InvalidArgumentError`                        | `InvalidRequestError`                                            | `unknown`                         | `false`       | `false`                         |
| anything else                                                     | `UnknownError`                                                   | `unknown`                         | `false`       | `false`                         |

`classifyError` reads `metadata.coder.classification`. For an `AiError` that
`effect/ai` raised itself (no `metadata.coder`), it classifies by the reason
tag, and `isTransient` follows the classification.

</details>

## Effect Schema → Vercel AI SDK schemas

`toAiSdkSchema` makes an Effect Schema usable in AI SDK APIs such as `tool()`,
with inputs fully decoded and typed:

```ts
import * as Schema from "effect/Schema";
import { tool } from "ai";
import { toAiSdkSchema } from "@coder/ai-sdk-effect";

const getWeather = tool({
  description: "Look up the current weather",
  inputSchema: toAiSdkSchema(Schema.Struct({ city: Schema.String })),
  execute: async ({ city }) => ({ city, temperature: 21 }),
});
```

<details>
<summary>Why a bare Effect standard schema fails</summary>

AI SDK v7 accepts Standard Schema V1 values, but deriving the wire JSON schema
requires the optional `~standard.jsonSchema` converter. `Schema.toStandardSchemaV1`
does not emit it, so passing a bare Effect standard schema throws
`Standard schema vendor 'effect' does not support JSON Schema conversion`.

`toAiSdkSchema` derives the JSON schema from the Effect Schema (the same
derivation `effect/ai` uses), and validation decodes through it.

</details>

### JSON Schema dialect

Effect 4 derives JSON Schema draft 2020-12. The AI SDK's `JSONSchema7` type is
draft-07, so the bridge converts every schema it sends (tool parameters,
structured outputs, `toJsonSchema`, `toAiSdkSchema`) with Effect's
`JsonSchema.toDocumentDraft07`. The conversion moves `$defs` to `definitions`
and rewrites tuples to array `items`. It throws on keywords draft-07 cannot
express.

Two effects of Effect 4's derivation show on the wire:

- Objects set `additionalProperties: true`, which matches the decoder's
  default of ignoring extra keys.
- `Schema.Number` also accepts the strings `"Infinity"`, `"-Infinity"`, and
  `"NaN"`. Use `Schema.Finite` (or `Schema.Int`) for plain JSON numbers.

## Scoped sandbox `Layer`s

`acquireWorkspace` / `layerWorkspace` wrap `ensureCoderWorkspace` in
`Effect.acquireRelease`:

- **Scope opens:** the workspace is provisioned (get-or-create, start,
  agent-readiness wait).
- **Scope closes:** it is torn down, including when the fiber is interrupted
  after acquisition.
- **Teardown policy:** `delete-if-created` by default. It never touches a
  workspace the acquisition merely attached to.

`acquireSession` / `layerSession` do the same for
`createCoderWorkspace(...).createSession()`.

```ts
import * as Effect from "effect/Effect";
import { CoderWorkspace, layerWorkspace } from "@coder/ai-sdk-effect";

const program = Effect.gen(function* () {
  const workspace = yield* CoderWorkspace;
  yield* Effect.log(`workspace ${workspace.name} ready`);
});

program.pipe(
  Effect.provide(
    layerWorkspace({
      workspace: "agent-sandbox",
      create: { template: "docker" },
    }),
  ),
  Effect.runPromise,
);
```

## Limitations

Unsupported _inputs_ fail loudly with `InvalidRequestError`; response parts with
no `effect/ai` equivalent are dropped.

| Limitation                                                                                                                                               | Behavior                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provider-defined tools (not expressible in `LanguageModelV4` call options)                                                                               | `InvalidRequestError`                                       |
| Response parts of type `custom`, `reasoning-file`, `tool-approval-request`; file payloads that are not raw data (URL / provider-reference / inline-text) | Dropped                                                     |
| Provider-executed tool calls and results for tools outside the call's toolkit (`effect/ai` types tool parts by toolkit)                                  | Moved to the finish part's `metadata.coder.serverToolCalls` |
| Provider raw usage (`effect/ai`'s `Response.Usage` has no field for it)                                                                                  | Moved to the finish part's `metadata.coder.rawUsage`        |
| Tool approval parts in the prompt (`effect/ai` resolves and strips them before the call)                                                                 | Not forwarded                                               |
| `Prompt` provider options (per-part metadata)                                                                                                            | Not forwarded                                               |
| `ProviderOptions.span` (telemetry)                                                                                                                       | Not wired into request headers                              |

Workspace acquisition is uninterruptible (standard `acquireRelease`
semantics): a slow `ensureCoderWorkspace` cannot be cancelled mid-flight. If an
acquisition creates a workspace and then fails (e.g. readiness timeout), the
workspace is rolled back best-effort per the teardown policy.

## Dependencies and the API surface used

<details>
<summary>Version ranges and the API surface the bridge codes against</summary>

| Dependency               | Range                                        | Surface used                                                                                                            |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `effect` (peer)          | `~4.0.0`                                     | `Effect`, `Layer`, `Stream`, `Schema`, `JsonSchema`, `Result`, `Context`, `Data`, `Option`, `Function.dual`             |
| `effect` (`effect/ai/*`) | `~4.0.0`                                     | `LanguageModel.make` (`ProviderOptions` → encoded response parts), `AiError`, `Prompt`, `Response`, `Tool`              |
| `ai` (peer)              | `^7.0.0`                                     | `jsonSchema` (for `toAiSdkSchema`)                                                                                      |
| `@ai-sdk/provider`       | exact (same pin as `@coder/ai-sdk-provider`) | `LanguageModelV4` spec types                                                                                            |
| `@coder/ai-sdk-provider` | `^` its current release                      | `createCoder`, `CoderProviderSettings`                                                                                  |
| `@coder/ai-sdk-sandbox`  | `^` its current release                      | `ensureCoderWorkspace`, `createCoderWorkspace`, `CoderTransport`                                                        |
| `@coder/ai-sdk-agent`    | `^` its current release                      | `CoderLanguageModel` (+ `chatId`, `lastSeenMessageId`, dispose), `CoderChatClient`, `classifyTurnAction`, error classes |

In this repository the `@coder/ai-sdk-*` dependencies are `workspace:^`. pnpm
replaces each one with `^<version>` when it publishes, where `<version>` is
the sibling package's version in the released commit.

</details>

## Examples

Runnable against a real deployment (see each file's header):

- [`examples/01-generate.ts`](./examples/01-generate.ts): text generation.
- [`examples/02-structured.ts`](./examples/02-structured.ts): structured
  output via Effect Schema.
- [`examples/03-sandbox.ts`](./examples/03-sandbox.ts): scoped workspace
  acquisition.

## License

Apache-2.0
