# @coder/ai-sdk-provider

[![CI](https://github.com/coder/ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-provider.svg)](https://www.npmjs.com/package/@coder/ai-sdk-provider)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A Vercel AI SDK provider that routes requests through your Coder deployment's
[AI Gateway](https://coder.com/docs/ai-coder/ai-gateway) (formerly "AI Bridge").
Use any model your deployment proxies, the same way you'd use
[OpenRouter](https://ai-sdk.dev/providers/community-providers/openrouter) or any
other provider.

```ts
import { generateText } from "ai";
import { createCoder } from "@coder/ai-sdk-provider";

const coder = createCoder({
  baseURL: "https://coder.example.com",
  apiKey: process.env.CODER_API_TOKEN!,
});

const { text } = await generateText({
  model: coder("claude-sonnet-4-6"),
  prompt: "What is Coder?",
});
```

**Why:** in centralized mode (the default), developers authenticate with their
Coder token and never handle raw provider keys. AI Gateway authenticates each
request against a Coder identity, injects the centrally managed keys for the
upstream providers (Anthropic, OpenAI, Bedrock, Copilot, …), and audits usage
per user. In bring-your-own-key mode, developers supply their own upstream key
instead (see [Authentication](#authentication)). The deployment decides
which models and providers are available.

> [!TIP]
> This package is for **plain model calls**: `generateText`, `streamText`, and
> `generateObject` (schema-constrained structured output). For Coder's
> **server-side agent** (multi-step tool loop, built-in tools, MCP servers,
> workspace file/shell tools), use [`@coder/ai-sdk-agent`](../agent). They
> compose: provider for pure text/JSON steps, Agent for tool-driven ones.

## Install

```bash
pnpm add @coder/ai-sdk-provider ai zod
```

Requirements:

- Node ≥ 22 and `ai` v7.
- A Coder deployment with **AI Gateway enabled**: stable since Coder **v2.29**,
  GA in v2.30, on by default in v2.34. Requires the AI Governance Add-On.

## Named providers and the two wire protocols

Coder admins define AI Gateway **providers**: named routes on the deployment
(`/api/v2/aibridge/<name>/v1/…`). Each speaks one of two wire protocols,
set by its admin-configured type:

| Wire protocol            | Provider types behind it                                                        | Default name |
| ------------------------ | ------------------------------------------------------------------------------- | ------------ |
| **OpenAI-compatible**    | `openai`, `azure`, `google`, `copilot`, `openai-compat`, `openrouter`, `vercel` | `openai`     |
| **Anthropic-compatible** | `anthropic` (native Claude), `bedrock` (Bedrock-hosted Claude)                  | `anthropic`  |

Routing is **by URL path, not by model id**: the provider name in the URL
decides which upstream handles the request.

`createCoder` fronts the default `openai` / `anthropic` pair. The bare call
`coder(modelId)` picks one by heuristic: ids starting with `claude` or
`anthropic` go to the Anthropic-protocol provider, everything else to the
OpenAI-protocol one. Explicit accessors override the heuristic, e.g. to reach
Claude through a Copilot-typed provider on the OpenAI protocol:

```ts
coder("gpt-4o"); // → `openai` provider
coder("claude-sonnet-4-6"); // → `anthropic` provider (heuristic)
coder.openai("claude-sonnet-4"); // → `openai` provider (e.g. Copilot)
coder.anthropic("claude-opus-4-5"); // → `anthropic` provider (explicit)
```

Model ids pass through **unchanged** to the upstream provider (no
`vendor/model` namespacing). Use whatever ids your deployment's providers
accept.

### Custom-named providers

Provider names are admin-chosen and match `^[a-z0-9]+(-[a-z0-9]+)*$`. A
deployment may expose, say, an Azure-backed `azure-openai` next to a
Bedrock-backed `anthropic-bedrock`. There are two ways to reach them.

**Sub-provider accessors.** `openaiProvider(name)` / `anthropicProvider(name)`
return a full sub-provider bound to that gateway provider, so one `createCoder`
instance can target any number of providers. Pick the accessor that matches the
provider's wire protocol:

```ts
const azure = coder.openaiProvider("azure-openai"); // OpenAI-compatible type
const bedrock = coder.anthropicProvider("anthropic-bedrock"); // Anthropic-compatible type

await generateText({ model: azure("gpt-4o"), prompt: "Hi" });
await generateText({ model: bedrock("claude-sonnet-4-6"), prompt: "Hi" });
```

| Name                                         | Fails with                                     |
| -------------------------------------------- | ---------------------------------------------- |
| Outside the gateway's grammar                | AI SDK `InvalidArgumentError` at accessor time |
| Well-formed but not configured on deployment | The gateway's 404 at request time              |

A name outside the grammar can never be registered, so it fails early.

**Re-pointing the defaults.** If your deployment just names its one
OpenAI/Anthropic pair differently, override the names once and keep using the
bare call and the `openai` / `anthropic` accessors:

```ts
const renamed = createCoder({
  baseURL: "https://coder.example.com",
  apiKey: process.env.CODER_API_TOKEN!,
  providers: { openai: "azure-openai", anthropic: "anthropic-bedrock" },
});
```

**Ask your Coder admins for provider names.** Discovery is admin-only
server-side: `GET /api/v2/ai/providers` returns `403` for regular users, and
the models endpoint does not attribute models to providers.

### Embeddings are not supported yet

`coder.textEmbeddingModel(id)` and the embedding accessors on `coder.openai`
throw the AI SDK's `NoSuchModelError` immediately.

<details>
<summary>Why embeddings throw instead of sending a request</summary>

AI Gateway does not intercept `/v1/embeddings`, so a request would be rejected
with a 404. Throwing up front avoids emitting it. The accessors stay so they
can light up without a breaking change once the gateway adds an embeddings
route. See [coder/ai-sdk#69](https://github.com/coder/ai-sdk/issues/69).

</details>

## Authentication

| Mode                      | Set                                                    | Upstream provider key                      |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| **Centralized** (default) | `apiKey`: your Coder API token                         | Held by AI Gateway, which brokers the call |
| **Bring-your-own-key**    | `coderToken`: Coder token; `apiKey`: your upstream key | Yours, forwarded to the upstream           |

Centralized mode is all most apps need:

```ts
createCoder({ baseURL: "https://coder.example.com", apiKey: coderToken });
```

BYOK sends `coderToken` in the `X-Coder-AI-Governance-Token` header to
authenticate you to the gateway, and forwards `apiKey` to the upstream:

```ts
createCoder({
  baseURL: "https://coder.example.com",
  coderToken, // authenticates you to AI Gateway
  apiKey: upstreamKey, // your own OpenAI/Anthropic key
});
```

## Configuration

| Option          | Type                      | Default                | Description                                                                                                          |
| --------------- | ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `baseURL`       | `string`                  | — (required)           | Your Coder deployment URL, e.g. `https://coder.example.com`. The AI Gateway path is appended for you.                |
| `apiKey`        | `string`                  | —                      | Coder API token (centralized) or upstream key (BYOK).                                                                |
| `coderToken`    | `string`                  | —                      | Enables BYOK mode; sent in `X-Coder-AI-Governance-Token`.                                                            |
| `headers`       | `Record<string,string>`   | —                      | Extra headers merged into every request.                                                                             |
| `aiGatewayPath` | `string`                  | `/api/v2/aibridge`     | Override if your deployment uses a different mount path. Use the canonical `/api/v2/ai-gateway` with Coder v2.35.0+. |
| `providers`     | `{ openai?, anthropic? }` | `openai` / `anthropic` | Re-point the default pair at differently-named providers.                                                            |
| `fetch`         | `typeof fetch`            | global `fetch`         | Custom fetch (testing / middleware).                                                                                 |

## Enterprise governance & security

The full reference for security reviewers is in
[`docs/security.md`](./docs/security.md): data flow, credential isolation,
audit capture, required permissions, and a security FAQ.

Key points:

- **Client vs. gateway.** What this package puts on the wire is verifiable in
  [`src/provider.ts`](./src/provider.ts). Key custody, audit capture, and
  retention are enforced server-side by your Coder deployment.
- **One destination.** The package only initiates requests to your `baseURL`.
  It never contacts upstream vendors directly and adds no telemetry.
- **Use HTTPS outside trusted local environments.** The client does not
  enforce `https://`; an `http://` URL sends tokens, keys, and prompts in
  plaintext.
- **Redirects are followed by default.** A cross-origin redirect would resend
  the prompt body and non-`Authorization` headers (in BYOK mode, including
  `x-api-key` and the governance token) to the redirect target. Pass
  `fetch: (url, init) => fetch(url, { ...init, redirect: "error" })` to forbid
  it.
- **Coder tokens are not AI-only.** A token grants the user's full Coder API
  permissions. Treat a leak as a Coder account compromise (revoke the token)
  and prefer short-lived, dedicated tokens for AI workloads.
- **Audit.** Every request is attributed to the authenticating Coder user. The
  Gateway stores the last user prompt, tool calls (name and arguments),
  reasoning content when present, token usage, and metadata. Response text is
  discarded. Retention defaults to 60 days and is configurable.

## Examples

Runnable scripts live in [`examples/`](./examples); see its
[README](./examples/README.md) for setup.

```bash
pnpm example:generate    # non-streaming generateText
pnpm example:stream      # streaming streamText
pnpm example:anthropic   # the Anthropic surface (native Claude)
```

## License

[Apache-2.0](./LICENSE) © Coder Technologies, Inc.
