# @coder/ai-sdk-effect

> [!WARNING]
> **Experimental spike (Phase 1 of
> [coder/ai-sdk#144](https://github.com/coder/ai-sdk/issues/144)).** This
> package is `private: true`, is **not published to npm**, and is excluded from
> release-please. Its API will change without notice until the spike review
> concludes.

An [Effect](https://effect.website) bridge for the Coder AI SDK: exposes
`@coder/ai-sdk-provider` (Coder AI Gateway) and `@coder/ai-sdk-sandbox`
(workspace sandboxes) through Effect-native abstractions — an `@effect/ai`
`LanguageModel` service, typed `AiError` failures, Effect Schema interop with
the Vercel AI SDK, and scoped `Layer`s for workspace lifecycle.

## Pinned surface

Effect's AI packages move fast, so the spike pins exact versions and codes
against their concrete API shapes:

| Dependency               | Version  | Surface used                                                                                               |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `effect`                 | `3.22.1` | `Effect`, `Layer`, `Stream`, `Schema`, `Context`, `Data`                                                   |
| `@effect/ai`             | `0.37.0` | `LanguageModel.make` (`ProviderOptions` → encoded response parts), `AiError`, `Prompt`, `Response`, `Tool` |
| `@ai-sdk/provider`       | `4.0.9`  | `LanguageModelV4` spec types (same pin as `@coder/ai-sdk-provider`)                                        |
| `@coder/ai-sdk-provider` | `0.4.5`  | `createCoder`, `CoderProviderSettings` (published release, not `workspace:*` — see below)                  |
| `@coder/ai-sdk-sandbox`  | `0.4.8`  | `ensureCoderWorkspace`, `createCoderWorkspace`, `CoderTransport`                                           |

The spike depends on the _published_ `@coder/ai-sdk-*` releases rather than
`workspace:*` so that repo-wide `typecheck`/`test` need no cross-package build
ordering. Switching to `workspace:*` is part of the Phase 2 publishing
decision.

## What exists (Phase 1)

### `LanguageModel` over Coder AI Gateway

`CoderLanguageModel.layer(modelId, source)` implements `@effect/ai`'s
`LanguageModel` service on top of the gateway. `source` is either
`CoderProviderSettings` or `{ provider }` for an existing `CoderProvider`, so
both auth modes (centralized and BYOK) work unchanged. `generateText`,
`generateObject`, and `streamText` are supported; structured outputs derive
their JSON schema from the Effect Schema you pass. Generation controls
(`maxOutputTokens`, `temperature`, `topP`, `topK`, penalties, `stopSequences`,
`seed`, `reasoning`) are set at construction time via an optional third
`GenerationOptions` argument and forwarded on every call.

```ts
import * as LanguageModel from "@effect/ai/LanguageModel";
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

The bridge core (`CoderLanguageModel.fromModel`) adapts any AI SDK
`LanguageModelV4`, which is also how the unit tests exercise it without HTTP.

### Typed error taxonomy

`@effect/ai`'s `AiError` is a **closed union**, so the bridge cannot add its
own error classes to the `LanguageModel` failure channel (a delta from the
tracking issue's sketch). Instead, failures are mapped losslessly into that
union (`HttpResponseError` keeps status, headers, and body) and `classifyError`
recovers the Coder-oriented taxonomy — `auth`, `rate-limit`,
`provider-unavailable`, `malformed-response`, `transport`, `unknown` — from
either an `AiError` or a raw AI SDK error. `isTransient` composes with
`Effect.retry`:

```ts
import * as LanguageModel from "@effect/ai/LanguageModel";
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

### Effect Schema → Vercel AI SDK schemas

AI SDK v7 accepts Standard Schema V1 values, but deriving the wire JSON schema
requires the optional `~standard.jsonSchema` converter, which
`Schema.standardSchemaV1` does not emit — passing a bare Effect standard
schema throws `Standard schema vendor 'effect' does not support JSON Schema
conversion`. `toAiSdkSchema` bridges the gap: the JSON schema is derived from
the Effect Schema (same derivation `@effect/ai` uses) and validation decodes
through it, so `tool()` inputs arrive fully decoded and typed:

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

### Scoped sandbox `Layer`s

`acquireWorkspace` / `layerWorkspace` wrap `ensureCoderWorkspace` in
`Effect.acquireRelease`: the workspace is provisioned (get-or-create, start,
agent-readiness wait) when the scope opens and torn down when it closes —
including when the fiber is interrupted after acquisition. The teardown policy
(`delete-if-created` by default) never touches a workspace the acquisition
merely attached to. `acquireSession` / `layerSession` do the same for
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

## Spike caveats

Honest limitations, chosen to keep the core small and correct. Unsupported
_inputs_ fail loudly with `MalformedInput`; response parts with no `@effect/ai`
equivalent are dropped:

- **Provider-defined tools** and the **`oneOf` tool-choice mode** are not
  expressible in `LanguageModelV4` call options → `MalformedInput`.
- Response parts of type `custom`, `reasoning-file`, and
  `tool-approval-request`, and file payloads that are not raw data (URL /
  provider-reference / inline-text), are dropped.
- `Prompt` provider options (per-part metadata) are not forwarded, and
  generation controls are fixed at model construction — a per-call override
  channel (an Effect config service, as `@effect/ai`'s own providers use) is
  Phase 2.
- Workspace acquisition is uninterruptible (standard `acquireRelease`
  semantics); a slow `ensureCoderWorkspace` cannot be cancelled mid-flight.
  A workspace created by an acquisition that then fails (e.g. readiness
  timeout) is rolled back best-effort per the teardown policy.
- Telemetry: the `ProviderOptions.span` is not wired into request headers.

## Phase 2 (not in this package yet)

- `LanguageModel` over `CoderAgent`/chatd (`TurnTranslator` → `Effect.Stream`,
  fiber interruption → `agent.interrupt()`).
- Retryable error tagging aligned with the agent package's
  `CoderStreamError.isRetryable`.
- Publishing decision: versioning, `peerDependency` policy on
  `effect`/`@effect/ai`, release-please wiring, `workspace:*` deps.

## Examples

Runnable against a real deployment (see each file's header):

- [`examples/01-generate.ts`](./examples/01-generate.ts) — text generation.
- [`examples/02-structured.ts`](./examples/02-structured.ts) — structured
  output via Effect Schema.
- [`examples/03-sandbox.ts`](./examples/03-sandbox.ts) — scoped workspace
  acquisition.

## License

Apache-2.0
