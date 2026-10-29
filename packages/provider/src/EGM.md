# @coder/ai-sdk-provider source (`src`)

## Overview

This directory holds the whole runtime of `@coder/ai-sdk-provider`. `createCoder` builds a
Vercel AI SDK provider that sends model calls to a Coder deployment's AI Gateway (formerly
"AI Bridge"). The provider fronts two gateway surfaces: an OpenAI-compatible one built with
`@ai-sdk/openai-compatible` and an Anthropic-compatible one built with `@ai-sdk/anthropic`.
It picks a surface per model id. The provider itself sends no request: the composed AI SDK
sub-providers do that when a model is used.

## Interface

- `index.ts` is the package entry point. It re-exports `coder`, `createCoder`,
  `type CoderProvider`, `type CoderProviderSettings` and `isAnthropicModelId` from
  `./provider.js`, where they are defined [provider.ts:coder]
- `createCoder(settings: CoderProviderSettings): CoderProvider` returns a callable
  provider with the members `languageModel`, `openai`, `anthropic`, `chat`, `messages`,
  `openaiProvider`, `anthropicProvider` and `textEmbeddingModel`
  [provider.ts:createCoder]
- `coder` is the same function as `createCoder` (`export const coder = createCoder`). It
  is not a configured provider instance [provider.ts:coder]
- `CoderProviderSettings` has the fields `baseURL` (required), `apiKey`, `coderToken`,
  `headers`, `aiGatewayPath`, `providers: { openai?, anthropic? }` and `fetch`
  [provider.ts:CoderProviderSettings]
- `CoderProvider` is the returned shape: a call signature `(modelId) => LanguageModelV4`
  plus the members listed above [provider.ts:CoderProvider]
- `isAnthropicModelId(modelId)` returns `/^(?:claude|anthropic[./:])/i.test(modelId)`.
  The bare call and `languageModel` use it to pick the surface
  [provider.ts:isAnthropicModelId]
- Internal (not exported): `trimTrailingSlash`, `unsupportedEmbeddingModel`,
  `assertValidProviderName` and the constants `DEFAULT_AI_GATEWAY_PATH`
  (`"/api/v2/aibridge"`), `DEFAULT_OPENAI_PROVIDER` (`"openai"`),
  `DEFAULT_ANTHROPIC_PROVIDER` (`"anthropic"`), `PROVIDER_NAME_PATTERN`
  (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) and `CODER_TOKEN_HEADER`
  (`"X-Coder-AI-Governance-Token"`) [provider.ts:DEFAULT_AI_GATEWAY_PATH]

## Invariants

- `createCoder` throws a plain `Error` when `settings.baseURL` is falsy (this includes the
  empty string). The message starts with ``createCoder: `baseURL` is required``
  [provider.ts:createCoder]
- Each sub-provider base URL is
  `${trimTrailingSlash(baseURL)}${aiGatewayPath ?? "/api/v2/aibridge"}/${name}/v1`.
  Only trailing slashes on `baseURL` are removed. `aiGatewayPath` is not validated or
  normalized [provider.ts:createCoder]
- `openaiProvider(name)` and `anthropicProvider(name)` call `assertValidProviderName`
  first. It throws `InvalidArgumentError` (argument `"name"`) when `name` does not match
  `PROVIDER_NAME_PATTERN` [provider.ts:assertValidProviderName]
- `createCoder` builds the default surfaces through the same two functions, with
  `settings.providers?.openai ?? "openai"` and `settings.providers?.anthropic ??
  "anthropic"`. So an invalid name in `settings.providers` throws inside `createCoder`
  [provider.ts:createCoder]
- Routing: the bare call and `languageModel` send ids that match `isAnthropicModelId` to
  the Anthropic surface and all other ids to the OpenAI-compatible surface. `chat` always
  uses the OpenAI-compatible surface. `messages` always uses the Anthropic surface
  [provider.ts:createCoder]
- BYOK mode is on when `settings.coderToken !== undefined`, so an empty-string
  `coderToken` also turns it on [provider.ts:createCoder]
- `unsupportedEmbeddingModel` always throws `NoSuchModelError` (`modelType:
  "embeddingModel"`), because AI Gateway does not intercept `/v1/embeddings`. It is wired
  to the top-level `textEmbeddingModel` and to `embeddingModel` and `textEmbeddingModel`
  on every OpenAI-compatible sub-provider. The Anthropic sub-provider's embedding
  accessors are not overridden [provider.ts:unsupportedEmbeddingModel]

## Side Effects

- `createCoder` sends no network request. It only constructs the sub-providers. The
  sub-providers send the requests, through `settings.fetch` when it is set
  [provider.ts:createCoder]
- One headers object goes to both surfaces:
  `{ ...(byok ? { "X-Coder-AI-Governance-Token": coderToken } : {}), ...settings.headers }`.
  `settings.headers` is spread last, so it can override the governance-token header
  [provider.ts:createCoder]
- The OpenAI-compatible surface is `createOpenAICompatible` with `name: "coder.<name>"`,
  `apiKey: settings.apiKey` (sent as `Authorization: Bearer`) and `includeUsage: true`, in
  both modes [provider.ts:createCoder]
- The Anthropic surface is `createAnthropic` with `name: "coder.<name>"`. In centralized
  mode it passes `authToken: settings.apiKey`. In BYOK mode it passes
  `apiKey: settings.apiKey` [provider.ts:createCoder]
- `@ai-sdk/openai-compatible` adds `Authorization: Bearer` only when `apiKey` is non-empty.
  `@ai-sdk/anthropic` reads `ANTHROPIC_API_KEY` from the environment at request time when
  the Anthropic surface gets no non-empty `authToken` and no `apiKey` string: centralized
  mode with `apiKey` unset or empty, or BYOK mode with `apiKey` unset. It sends that value
  as `x-api-key` and throws when the variable is unset [provider.ts:createCoder]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-provider test`
- Run: `pnpm --filter @coder/ai-sdk-provider typecheck`
- Unit tests: `packages/provider/test/provider.test.ts`
