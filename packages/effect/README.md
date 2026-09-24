# @coder/ai-sdk-effect

> [!WARNING]
> **Experimental spike: not published to npm.** Phase 1 of
> [coder/ai-sdk#144](https://github.com/coder/ai-sdk/issues/144). The package
> is `private: true` and excluded from release-please. Its API will change
> without notice until the spike review concludes.

An [Effect](https://effect.website) bridge for `@coder/ai-sdk-provider` (Coder
AI Gateway) and `@coder/ai-sdk-sandbox` (workspace sandboxes):

| Feature                                                                              | API                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`@effect/ai` `LanguageModel` over AI Gateway](#languagemodel-over-coder-ai-gateway) | `CoderLanguageModel.layer`, `CoderLanguageModel.fromModel`               |
| [Typed `AiError` failures](#typed-error-taxonomy)                                    | `classifyError`, `isTransient`                                           |
| [Effect Schema → Vercel AI SDK schemas](#effect-schema--vercel-ai-sdk-schemas)       | `toAiSdkSchema`                                                          |
| [Scoped workspace `Layer`s](#scoped-sandbox-layers)                                  | `acquireWorkspace` / `layerWorkspace`, `acquireSession` / `layerSession` |

## `LanguageModel` over Coder AI Gateway

`CoderLanguageModel.layer(modelId, source, generation?)` implements `@effect/ai`'s
`LanguageModel` service on top of the gateway.

- **`source`:** `CoderProviderSettings`, or `{ provider }` for an existing
  `CoderProvider`. Both auth modes (centralized and BYOK) work unchanged.
- **Supported calls:** `generateText`, `generateObject`, and `streamText`.
  Structured outputs derive their JSON schema from the Effect Schema you pass.
- **`generation` (`GenerationOptions`):** `maxOutputTokens`, `temperature`,
  `topP`, `topK`, penalties, `stopSequences`, `seed`, `reasoning`. Set at
  construction time and forwarded on every call.

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

`CoderLanguageModel.fromModel` (the bridge core) adapts any AI SDK
`LanguageModelV4`; unit tests use it to run without HTTP.

## Typed error taxonomy

`classifyError` maps an `AiError` or a raw AI SDK error to one of: `auth`,
`rate-limit`, `provider-unavailable`, `malformed-response`, `transport`,
`unknown`. `isTransient` composes with `Effect.retry`:

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

<details>
<summary>Why there are no Coder-specific error classes</summary>

`@effect/ai`'s `AiError` is a **closed union**, so the bridge cannot add its
own error classes to the `LanguageModel` failure channel (a delta from the
tracking issue's sketch). Failures are mapped losslessly into that union
(`HttpResponseError` keeps status, headers, and body), and `classifyError`
recovers the Coder-oriented taxonomy.

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
requires the optional `~standard.jsonSchema` converter. `Schema.standardSchemaV1`
does not emit it, so passing a bare Effect standard schema throws
`Standard schema vendor 'effect' does not support JSON Schema conversion`.

`toAiSdkSchema` derives the JSON schema from the Effect Schema (the same
derivation `@effect/ai` uses), and validation decodes through it.

</details>

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

## Spike caveats

Unsupported _inputs_ fail loudly with `MalformedInput`; response parts with no
`@effect/ai` equivalent are dropped.

| Limitation                                                                                                                                               | Behavior                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Provider-defined tools; the `oneOf` tool-choice mode (not expressible in `LanguageModelV4` call options)                                                 | `MalformedInput`                                           |
| Response parts of type `custom`, `reasoning-file`, `tool-approval-request`; file payloads that are not raw data (URL / provider-reference / inline-text) | Dropped                                                    |
| `Prompt` provider options (per-part metadata)                                                                                                            | Not forwarded                                              |
| Generation controls                                                                                                                                      | Fixed at model construction (per-call override is Phase 2) |
| `ProviderOptions.span` (telemetry)                                                                                                                       | Not wired into request headers                             |

Workspace acquisition is uninterruptible (standard `acquireRelease`
semantics): a slow `ensureCoderWorkspace` cannot be cancelled mid-flight. If an
acquisition creates a workspace and then fails (e.g. readiness timeout), the
workspace is rolled back best-effort per the teardown policy.

<details>
<summary>Phase 2 (not in this package yet)</summary>

- `LanguageModel` over `CoderAgent`/chatd (`TurnTranslator` → `Effect.Stream`,
  fiber interruption → `agent.interrupt()`).
- Retryable error tagging aligned with the agent package's
  `CoderStreamError.isRetryable`.
- A per-call override channel for generation controls (an Effect config
  service, as `@effect/ai`'s own providers use).
- Publishing decision: versioning, `peerDependency` policy on
  `effect`/`@effect/ai`, release-please wiring, `workspace:*` deps.

</details>

## Pinned surface

Effect's AI packages move fast, so the spike pins exact versions and codes
against their concrete API shapes.

<details>
<summary>Pinned versions and the API surface used</summary>

| Dependency               | Version  | Surface used                                                                                               |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------- |
| `effect`                 | `3.22.2` | `Effect`, `Layer`, `Stream`, `Schema`, `Context`, `Data`                                                   |
| `@effect/ai`             | `0.37.0` | `LanguageModel.make` (`ProviderOptions` → encoded response parts), `AiError`, `Prompt`, `Response`, `Tool` |
| `@ai-sdk/provider`       | `4.0.17` | `LanguageModelV4` spec types (same pin as `@coder/ai-sdk-provider`)                                        |
| `@coder/ai-sdk-provider` | `0.4.20` | `createCoder`, `CoderProviderSettings` (published release, not `workspace:*`)                              |
| `@coder/ai-sdk-sandbox`  | `0.4.23` | `ensureCoderWorkspace`, `createCoderWorkspace`, `CoderTransport`                                           |

The spike depends on the _published_ `@coder/ai-sdk-*` releases rather than
`workspace:*`, so repo-wide `typecheck`/`test` need no cross-package build
ordering. Switching to `workspace:*` is part of the Phase 2 publishing
decision.

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
