# @coder/ai-sdk-effect

> [!WARNING]
> **Experimental spike: not published to npm.** Phase 1 of
> [coder/ai-sdk#144](https://github.com/coder/ai-sdk/issues/144). The package
> is `private: true` and excluded from release-please. Its API will change
> without notice until the spike review concludes.

An [Effect](https://effect.website) bridge for `@coder/ai-sdk-provider` (Coder
AI Gateway), `@coder/ai-sdk-agent` (Coder Agents), and `@coder/ai-sdk-sandbox`
(workspace sandboxes):

| Feature                                                                              | API                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [`@effect/ai` `LanguageModel` over AI Gateway](#languagemodel-over-coder-ai-gateway) | `CoderLanguageModel.layer`, `CoderLanguageModel.fromModel`               |
| [`@effect/ai` `LanguageModel` over Coder Agents](#languagemodel-over-coder-agents)   | `CoderAgentModel.layer`, `CoderAgentModel.withAgentOptions`              |
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
  `topP`, `topK`, penalties, `stopSequences`, `seed`, `reasoning`,
  `providerOptions`. Set at construction time and forwarded on every call.
- **Per-call overrides:** `CoderLanguageModel.withGenerationOptions(overrides)`
  provides the `GenerationConfig` service to one effect. Its keys win over the
  construction options; nested overrides merge, innermost first.

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

```ts
import * as LanguageModel from "@effect/ai/LanguageModel";
import { CoderLanguageModel } from "@coder/ai-sdk-effect";

const deterministic = LanguageModel.generateText({ prompt: "Name a color." }).pipe(
  CoderLanguageModel.withGenerationOptions({ temperature: 0, seed: 1 }),
);
```

`CoderLanguageModel.fromModel` (the bridge core) adapts any AI SDK
`LanguageModelV4`; unit tests use it to run without HTTP.

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
- **Tools.** Toolkit tools run client-side: `@effect/ai` resolves the tool
  calls, and the next call sends the results back to the same chat. chatd's
  server-side tools are reported in the finish part's
  `metadata.coder.serverToolCalls`.
  chatd registers client tools only when the chat is created, so the toolkit
  cannot change afterwards, and only the `auto` tool choice is supported.
  Other cases fail with `MalformedInput`. `toolChoice` governs toolkit tools
  only; chatd's server-side tools come from `settings` (`workspaceId`,
  `mcpServerIds`). A chat resumed with `settings.chatId` keeps the client
  tools it was created with, and the layer cannot verify them: pass the same
  toolkit, and set `requestTimeoutMs`.
- **Structured output.** `generateObject` fails with `MalformedInput`: chatd
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
  `MalformedInput`, because chatd chooses them.

```ts
import * as LanguageModel from "@effect/ai/LanguageModel";
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
`@coder/ai-sdk-agent` error to one of: `auth`, `rate-limit`,
`provider-unavailable`, `malformed-response`, `transport`, `timeout`,
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

<details>
<summary>How <code>@coder/ai-sdk-agent</code> errors map</summary>

| Agent error                                   | `AiError`                             | Reason                                     | `isTransient`   |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------ | --------------- |
| `CoderApiError`                               | `HttpResponseError` (status, path)    | from the status, like gateway errors       | from the reason |
| `CoderStreamError`                            | `HttpRequestError` (error as `cause`) | `transport`                                | `isRetryable`   |
| `CoderChatError` with `kind: "timeout"`       | `UnknownError` (error as `cause`)     | `timeout`                                  | `retryable`     |
| `CoderChatError` with `kind: "stream_closed"` | `UnknownError` (error as `cause`)     | `transport`                                | `retryable`     |
| Any other `CoderChatError`                    | `UnknownError` (error as `cause`)     | from `statusCode` if present, or `unknown` | `retryable`     |

An explicit verdict wins over the reason. The agent sets
`CoderStreamError.isRetryable` to `false` when replaying the prompt would
repeat server-side effects, so such a failure is not transient even though
its reason is `transport`. Fiber interruption stays Effect interruption; it
never becomes an `AiError`.

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

| Limitation                                                                                                                                               | Behavior                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provider-defined tools; the `oneOf` tool-choice mode (not expressible in `LanguageModelV4` call options)                                                 | `MalformedInput`                                            |
| Response parts of type `custom`, `reasoning-file`, `tool-approval-request`; file payloads that are not raw data (URL / provider-reference / inline-text) | Dropped                                                     |
| Provider-executed tool calls and results for tools outside the call's toolkit (`@effect/ai` types tool parts by toolkit)                                 | Moved to the finish part's `metadata.coder.serverToolCalls` |
| `Prompt` provider options (per-part metadata)                                                                                                            | Not forwarded                                               |
| `ProviderOptions.span` (telemetry)                                                                                                                       | Not wired into request headers                              |

Workspace acquisition is uninterruptible (standard `acquireRelease`
semantics): a slow `ensureCoderWorkspace` cannot be cancelled mid-flight. If an
acquisition creates a workspace and then fails (e.g. readiness timeout), the
workspace is rolled back best-effort per the teardown policy.

<details>
<summary>Phase 2 (not in this package yet)</summary>

- Publishing decision: versioning, `peerDependency` policy on
  `effect`/`@effect/ai`, release-please wiring, `workspace:*` deps.

</details>

## Pinned surface

Effect's AI packages move fast, so the spike pins exact versions and codes
against their concrete API shapes.

<details>
<summary>Pinned versions and the API surface used</summary>

| Dependency               | Version  | Surface used                                                                                                            |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `effect`                 | `3.22.2` | `Effect`, `Layer`, `Stream`, `Schema`, `Context`, `Data`, `Option`, `Function.dual`                                     |
| `@effect/ai`             | `0.37.0` | `LanguageModel.make` (`ProviderOptions` → encoded response parts), `AiError`, `Prompt`, `Response`, `Tool`              |
| `@ai-sdk/provider`       | `4.0.18` | `LanguageModelV4` spec types (same pin as `@coder/ai-sdk-provider`)                                                     |
| `@coder/ai-sdk-provider` | `0.4.24` | `createCoder`, `CoderProviderSettings` (published release, not `workspace:*`)                                           |
| `@coder/ai-sdk-sandbox`  | `0.4.27` | `ensureCoderWorkspace`, `createCoderWorkspace`, `CoderTransport`                                                        |
| `@coder/ai-sdk-agent`    | `0.12.2` | `CoderLanguageModel` (+ `chatId`, `lastSeenMessageId`, dispose), `CoderChatClient`, `classifyTurnAction`, error classes |

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
