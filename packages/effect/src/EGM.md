# @coder/ai-sdk-effect source (`src`)

## Overview

This directory holds the whole bridge from Coder's Vercel AI SDK packages to
Effect 4 (`effect/ai`). It has four parts:

1. `language-model.ts` adapts any AI SDK `LanguageModelV4` to an `effect/ai`
   `LanguageModel` service, and binds it to a Coder AI Gateway model through
   `@coder/ai-sdk-provider` (`packages/provider/src/index.ts`).
2. `agent-model.ts` builds a scoped `LanguageModel` service over one Coder
   Agents chat through `@coder/ai-sdk-agent` (`packages/agent/src/index.ts`).
3. `errors.ts` maps AI SDK and Coder Agents errors to `AiError` values and
   classifies them for retry decisions.
4. `sandbox.ts` wraps `@coder/ai-sdk-sandbox` (`packages/sandbox/src/index.ts`)
   workspaces and sessions as scoped Effect resources and `Layer`s.

`schema.ts` converts Effect Schemas to draft-07 JSON Schema and to AI SDK
schemas. `index.ts` is the only published entry point.

## Interface

Entry point (`index.ts`):

- `CoderLanguageModel` namespace: `export * as` of `language-model.ts`. Top-level type
  exports: `CoderFinishMetadata`, `GenerationOptions`, `ProviderSource`
  [./index.ts:CoderLanguageModel].
- `CoderAgentModel` namespace: `export * as` of `agent-model.ts`. Top-level type exports:
  `AgentModelSettings`, `AgentOptions` [./index.ts:CoderAgentModel].
- Named exports from `errors.ts`: `classifyError`, `classifyStatus`, `isTransient`,
  `toAiError`, and the types `ClassifiableError`, `CoderErrorMetadata`, `ErrorReason`
  [./index.ts:classifyError].
- Named exports from `sandbox.ts`: `acquireSession`, `acquireWorkspace`,
  `CoderSandboxError`, `CoderSession`, `CoderWorkspace`, `layerSession`, `layerWorkspace`,
  and the types `AcquireSessionOptions`, `AcquireWorkspaceOptions`, `SessionTeardown`,
  `WorkspaceTeardown` [./index.ts:acquireSession].
- Named exports from `schema.ts`: `toAiSdkSchema`, `toJsonSchema`. `index.ts` does not
  re-export `toDraft07` [./index.ts:toJsonSchema].

AI Gateway model (`CoderLanguageModel.*`):

- `fromModel(model, generation = {})` builds a `LanguageModel` service from any
  `LanguageModelV4`. It performs no HTTP itself [./language-model.ts:fromModel].
- `layerFromModel(model, generation)` is `fromModel` as a `Layer` that provides
  `LanguageModel.LanguageModel` [./language-model.ts:layerFromModel].
- `make(modelId, source, generation = {})` resolves `provider.languageModel(modelId)` from
  `source.provider`, or from `createCoder(source)` when `source` has no `provider` key
  [./language-model.ts:make].
- `layer(modelId, source, generation)` is `make` as a `Layer` [./language-model.ts:layer].
- `GenerationConfig` is a `Context.Service` with the key
  `"@coder/ai-sdk-effect/GenerationConfig"` that holds per-call `GenerationOptions`
  overrides [./language-model.ts:GenerationConfig].
- `withGenerationOptions(self, overrides)` (dual) provides `GenerationConfig` to `self`,
  merged over any outer value [./language-model.ts:withGenerationOptions].
- `GenerationOptions` picks `maxOutputTokens`, `temperature`, `topP`, `topK`,
  `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `reasoning` and
  `providerOptions` from `LanguageModelV4CallOptions` [./language-model.ts:GenerationOptions].
- `ProviderSource` is `CoderProviderSettings | { readonly provider: CoderProvider }`
  [./language-model.ts:ProviderSource].
- `CoderFinishMetadata` is the shape of the finish part's `metadata.coder`: optional
  `serverToolCalls` and optional `rawUsage` [./language-model.ts:CoderFinishMetadata].

Agents model (`CoderAgentModel.*`):

- `make(settings)` returns `Effect<LanguageModel, AiError, Scope>`. It builds an
  internal `AgentSession` with `Effect.acquireRelease` and wraps it with `fromModel`
  [./agent-model.ts:make].
- `layer(settings)` is `make` as a scoped `Layer` that provides `LanguageModel`
  [./agent-model.ts:layer].
- `withAgentOptions(options)` sends the defined `model` and `reasoningEffort` keys as
  `providerOptions.coder` through `withGenerationOptions` [./agent-model.ts:withAgentOptions].
- `AgentModelSettings` is `CoderLanguageModelConfig` without `client`, plus optional
  `client`, `baseUrl` and `token` [./agent-model.ts:AgentModelSettings].
- `AgentOptions` has optional `model` and `reasoningEffort` [./agent-model.ts:AgentOptions].

Errors:

- `ErrorReason` is one of `"auth"`, `"rate-limit"`, `"quota"`, `"provider-unavailable"`,
  `"malformed-response"`, `"transport"`, `"timeout"`, `"unknown"`
  [./errors.ts:ErrorReason].
- `CoderErrorMetadata` is the `metadata.coder` shape on an `AiError` reason: required
  `classification`, optional `retryable`, `status`, `kind`, `provider`, `chatId`,
  `message` [./errors.ts:CoderErrorMetadata].
- `classifyStatus(status)` maps an HTTP status to an `ErrorReason`
  [./errors.ts:classifyStatus].
- `classifyError(error)` returns an `ErrorReason` for an `AiError`, an `AISDKError` or a
  `CoderAgentError` [./errors.ts:classifyError].
- `isTransient(error)` reports whether a failure is worth retrying
  [./errors.ts:isTransient].
- `toAiError({ module, method, error })` maps an unknown error to an `AiError`
  [./errors.ts:toAiError].
- `ClassifiableError` is `AiError.AiError | AISDKError | CoderAgentError`
  [./errors.ts:ClassifiableError].

Sandbox:

- `CoderWorkspace` is a `Context.Service` with the key `"@coder/ai-sdk-effect/CoderWorkspace"`
  that holds an `EnsuredCoderWorkspace` [./sandbox.ts:CoderWorkspace].
- `acquireWorkspace(options)` acquires a ready workspace through `ensureCoderWorkspace`
  as a scoped resource [./sandbox.ts:acquireWorkspace].
- `layerWorkspace(options)` is `acquireWorkspace` as a `Layer` that provides
  `CoderWorkspace` [./sandbox.ts:layerWorkspace].
- `AcquireWorkspaceOptions` is `EnsureCoderWorkspaceSettings` without `abortSignal`, plus
  optional `teardown` [./sandbox.ts:AcquireWorkspaceOptions].
- `WorkspaceTeardown` is `"delete-if-created" | "stop-if-created" | "keep"`
  [./sandbox.ts:WorkspaceTeardown].
- `CoderSession` is a `Context.Service` with the key `"@coder/ai-sdk-effect/CoderSession"`
  that holds a `CoderWorkspaceSession` [./sandbox.ts:CoderSession].
- `acquireSession(options)` creates a session through
  `createCoderWorkspace(...).createSession({ sessionId })` as a scoped resource
  [./sandbox.ts:acquireSession].
- `layerSession(options)` is `acquireSession` as a `Layer` that provides `CoderSession`
  [./sandbox.ts:layerSession].
- `AcquireSessionOptions` has `settings`, optional `sessionId` and optional `teardown`
  [./sandbox.ts:AcquireSessionOptions].
- `SessionTeardown` is `"stop" | "destroy"` [./sandbox.ts:SessionTeardown].
- `CoderSandboxError` is a `Data.TaggedError("CoderSandboxError")` with `phase`
  (`"acquire"` or `"release"`), `description` and `cause`. Its `message` is
  `` `${phase}: ${description}` `` [./sandbox.ts:CoderSandboxError].

Schema:

- `toJsonSchema(schema)` derives a draft-07 `JSONSchema7` with
  `toDraft07(Tool.getJsonSchemaFromSchema(schema))` [./schema.ts:toJsonSchema].
- `toAiSdkSchema(schema)` wraps an Effect `Schema.Decoder<A>` as an AI SDK `Schema<A>`
  whose validator decodes with `Schema.decodeUnknownResult` [./schema.ts:toAiSdkSchema].
- `toDraft07(schema)` (internal to the package) rewrites a draft-2020-12 schema with
  `$defs` as draft-07 through `JsonSchema.toDocumentDraft07`. It throws on keywords
  draft-07 cannot express [./schema.ts:toDraft07].

## Invariants

AI Gateway model:

- Per-call `GenerationConfig` values are spread over the construction-time options. The
  merge is shallow, so a per-call `providerOptions` replaces the whole outer value
  [./language-model.ts:resolveGeneration].
- Nested `withGenerationOptions` calls merge as `{ ...current, ...overrides }`, so the
  innermost value wins per key [./language-model.ts:withGenerationOptions].
- When provider construction or `languageModel(modelId)` throws, `make` fails with an
  `AiError` whose reason is `InvalidRequestError` and whose method is `"make"`
  [./language-model.ts:make].
- A provider-defined tool fails the call with `InvalidRequestError` (parameter `"tools"`)
  and the message `provider-defined tool "<name>" is not supported by the Coder AI Gateway
  bridge` [./language-model.ts:toolToV4].
- A `"required"` or `"tool"` tool choice with zero tools fails with `InvalidRequestError`
  (parameter `"toolChoice"`). A `oneOf` choice maps to `{ type: mode ?? "auto" }`
  [./language-model.ts:toolChoiceToV4].
- `buildCallOptions` sets `tools` only when the call has tools. It sets `toolChoice` on
  every call. In JSON mode it sets `responseFormat` to `{ type: "json", name, schema }`
  and prepends a system message that starts with `JSON schema:` and contains the schema.
  It converts any throw, including a `toDraft07` throw for a tool or JSON-mode schema,
  with `toAiError` [./language-model.ts:buildCallOptions].
- Assistant `tool-approval-request` prompt parts are dropped. Tool messages keep only
  `tool-result` parts [./language-model.ts:messageToV4].
- A prompt tool result with `isFailure` is sent as `{ type: "error-json" }`. One with
  `modelOutput` is sent as `{ type: "content" }` with text and file items. Any other
  result is sent as `{ type: "json", value: result ?? null }`
  [./language-model.ts:toolResultToV4].
- Tool call input is parsed with `JSON.parse`. Whitespace-only input becomes `{}`.
  Invalid JSON fails with `InvalidOutputError` [./language-model.ts:toolCallPart].
- Response `custom`, `reasoning-file` and `tool-approval-request` parts are dropped. Files
  keep only `data` payloads, as base64 [./language-model.ts:sharedContentToParts].
- Stream `tool-input-*` parts become `tool-params-*`. `stream-start` and `raw` parts are
  dropped [./language-model.ts:streamPartToParts].
- A stream part with `type: "error"` fails the stream with `toAiError`
  [./language-model.ts:streamText].
- In JSON mode, a defined `structuredOutputText` replaces the text parts of a
  `generateText` result [./language-model.ts:generateText].
- Provider-executed tool calls, and tool results, for tools outside the call's toolkit do
  not reach `effect/ai`. They go to `metadata.coder.serverToolCalls` on the finish part.
  In streaming, their `tool-input-*` parts still reach `effect/ai` as `tool-params-*`.
  A call id that changes its tool name fails with `InvalidOutputError`
  [./language-model.ts:ServerToolCalls].
- The unified finish reason `"interrupted"` maps to `"unknown"`. Other reasons pass
  through unchanged [./language-model.ts:toFinishReason].
- The finish part gets `metadata.coder` only when it has `serverToolCalls` or `rawUsage`
  [./language-model.ts:finishPart].

Agents model:

- `turnOptions` rejects any defined per-call `maxOutputTokens`, `temperature`, `topP`,
  `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed` or `reasoning`
  with `InvalidArgumentError` [./agent-model.ts:UNSUPPORTED].
- `turnOptions` rejects `responseFormat.type === "json"`, any `toolChoice` other than
  unset or `"auto"`, and any `providerOptions` namespace other than `"coder"`. It accepts
  `"none"` only when the call has no tools, which is how the bridge forwards a call with
  no toolkit [./agent-model.ts:turnOptions].
- `providerOptions.coder` must decode as optional string `model` and optional string
  `reasoningEffort`, with excess keys rejected [./agent-model.ts:decodeAgentOptions].
- `AgentSession` needs `client`, or both `baseUrl` and `token` after the fallback to the
  `CODER_URL` and `CODER_SESSION_TOKEN` environment variables. Otherwise the constructor
  throws, and `make` maps that to `InvalidRequestError` [./agent-model.ts:AgentSession].
- One session runs one call at a time. A call while another is in flight throws. A model
  or `reasoningEffort` change throws unless the prompt starts a new turn. A toolkit that
  differs from the one recorded for the chat throws [./agent-model.ts:AgentSession].

Errors:

- `classifyStatus` maps 401 and 403 to `"auth"`, 402 to `"quota"`, 429 to `"rate-limit"`,
  and 500 or higher to `"provider-unavailable"`. Every other status maps to `"unknown"`
  [./errors.ts:classifyStatus].
- `classifyError` returns `metadata.coder.classification` when the reason carries it.
  Otherwise it classifies by the reason `_tag`, then by `http.response.status`
  [./errors.ts:classifyError].
- `isTransient` returns `metadata.coder.retryable` when it is set. Otherwise only
  `"rate-limit"`, `"provider-unavailable"`, `"transport"` and `"timeout"` are transient
  [./errors.ts:isTransient].
- `toAiError` returns an existing `AiError` unchanged, wraps a bare `AiError` reason, and
  maps a non-`Error` value to `UnknownError` [./errors.ts:toAiError].
- `toAiError` maps an `Error` by type. `CoderApiError` and an `APICallError` with a
  `statusCode` go through `classifyStatus` and `reasonFor`. An `APICallError` without a
  `statusCode` becomes `NetworkError` (`reason: "TransportError"`). Request details go
  in both `effect/ai` shapes: `request` (effect 4.0) and `method` plus `url` (effect 4.1).
  Each version's reason constructor keeps its own fields and drops the others
  [./errors.ts:requestFields]. `CoderStreamError`
  becomes `UnknownError` with `classification: "transport"` and `retryable:
  error.isRetryable`. `JSONParseError`, `TypeValidationError` and
  `EmptyResponseBodyError` become `InvalidOutputError`. `InvalidArgumentError` becomes
  `InvalidRequestError` with `parameter: error.argument`, and `NoSuchModelError` with
  `parameter: "modelId"`. Any other `Error` becomes `UnknownError` [./errors.ts:toReason].
- The `CoderApiError` and `CoderChatError` guards also match by `error.name`. The
  `CoderStreamError` guard also matches an `APICallError` named `"CoderStreamError"`
  [./errors.ts:isCoderApiError] [./errors.ts:isCoderChatError]
  [./errors.ts:isCoderStreamError].
- `CoderChatError` goes through `reasonFor` with the classification from
  `classifyChatError`: `kind: "timeout"` gives `"timeout"`, `kind: "stream_closed"` gives
  `"transport"`, else the `statusCode` is classified [./errors.ts:classifyChatError].
- `reasonFor` gives `AuthenticationError` with `kind: "InsufficientPermissions"` for 403
  and `"InvalidKey"` for other auth errors. Status 400 with no other matching
  classification gives `InvalidRequestError` [./errors.ts:reasonFor].
- `Retry-After` accepts delay seconds (`/^\d+$/`) or an IMF-fixdate. Any other value gives
  no `retryAfter` [./errors.ts:parseRetryAfter].
- An HTTP method outside `HTTP_METHODS` (or a missing method) is recorded as `"POST"`
  [./errors.ts:httpContext].
- A reason marked `retryable: false` whose `AiError` reason is retryable is downgraded to
  `UnknownError` [./errors.ts:reasonFor].

Sandbox:

- `acquireWorkspace` defaults `teardown` to `"delete-if-created"`. One transport instance
  (`settings.transport ?? new CoderCliTransport()`) runs both acquisition and teardown
  [./sandbox.ts:acquireWorkspace].
- Release does nothing for `"keep"` or when `workspace.created` is false. Otherwise it
  calls `transport.destroy` for `"delete-if-created"` and `transport.stop` for
  `"stop-if-created"`. A release failure is a defect (`Effect.orDie`)
  [./sandbox.ts:releaseWorkspace].
- Rollback after a failed acquisition runs only when this call's own `create` succeeded.
  Rollback errors are swallowed, and the original error is re-thrown
  [./sandbox.ts:trackCreation] [./sandbox.ts:rollbackFailedAcquisition].
- `acquireSession` defaults `teardown` to `"stop"`. When `createSession` fails after this
  call created the workspace and `settings.ownsLifecycle ?? true` holds, it destroys that
  workspace. A session release failure is a defect (`Effect.orDie`)
  [./sandbox.ts:acquireSession].

## Side Effects

- `generateText` calls `model.doGenerate` with Effect's abort signal, so fiber
  interruption aborts the request [./language-model.ts:generateText].
- `streamText` calls `model.doStream` with an `AbortController` that is aborted when the
  stream scope closes [./language-model.ts:streamText].
- `make` constructs a provider with `createCoder(source)` when `source` has no `provider`
  [./language-model.ts:make].
- `AgentSession` reads `CODER_URL` and `CODER_SESSION_TOKEN` from `globalThis.process.env`
  and builds a `CoderChatClient` when no `client` is given. Chat network calls happen in
  the agent package's model [./agent-model.ts:AgentSession].
- A per-call `model` or `reasoningEffort` change disposes the current agent model and
  builds a new one, which resumes the same chat when one exists
  [./agent-model.ts:AgentSession].
- Closing the `make` scope runs `session.dispose()`, which disposes the current agent
  model [./agent-model.ts:make].
- `parseRetryAfter` reads `Date.now()` to compute HTTP-date delays
  [./errors.ts:parseRetryAfter].
- `acquireWorkspace` runs `ensureCoderWorkspace`, which can create or start a workspace.
  Its finalizer can delete or stop it [./sandbox.ts:acquireWorkspace].
- `rollbackFailedAcquisition` calls `transport.destroy` or `transport.stop` outside any
  scope finalizer [./sandbox.ts:rollbackFailedAcquisition].
- `acquireSession` creates a workspace session. Its finalizer calls `session.stop()` or
  `session.destroy()` [./sandbox.ts:acquireSession].

## Verification

`pnpm -r build` first: effect's typecheck and tests resolve the other packages' `dist/`
through `workspace:^`. Then run the package tests and typecheck:

```sh
pnpm -r build
pnpm --filter @coder/ai-sdk-effect test
pnpm --filter @coder/ai-sdk-effect typecheck
```

Unit tests for this directory: `packages/effect/test/language-model.test.ts`,
`packages/effect/test/agent-model.test.ts`, `packages/effect/test/errors.test.ts`,
`packages/effect/test/sandbox.test.ts`, `packages/effect/test/schema.test.ts`.
