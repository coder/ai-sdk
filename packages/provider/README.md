# @coder/ai-sdk-provider

[![CI](https://github.com/coder/ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-provider.svg)](https://www.npmjs.com/package/@coder/ai-sdk-provider)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A **Vercel AI SDK provider that routes requests through your Coder deployment's
[AI Gateway](https://coder.com/docs/ai-coder/ai-gateway)** (formerly "AI Bridge" — the URL path is still `aibridge`). Point it
at your deployment URL, hand it a Coder API token, and use any model your
deployment proxies with the AI SDK's `generateText` / `streamText` — the same way
you'd use [OpenRouter](https://ai-sdk.dev/providers/community-providers/openrouter)
or any other provider.

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

## Why

**AI Gateway** is Coder's LLM gateway: it sits between your AI tooling and the
upstream providers (Anthropic, OpenAI, Bedrock, Copilot, …), authenticates each
request against a Coder identity, injects the centrally-managed provider keys, and
audits usage per user. This package lets the Vercel AI SDK speak to it natively, so
your developers never handle raw provider keys — they authenticate with their Coder
token and the deployment decides which models and providers are available.

## Provider vs. Agent

This package is for **plain model calls** — `generateText`, `streamText`, and
`generateObject` (schema‑constrained structured output). If you need Coder's
**server‑side agent** — the multi‑step tool loop, built‑in tools, MCP servers, or
workspace file/shell tools — use **[`@coder/ai-sdk-agent`](../agent)** instead.
Rule of thumb: **need a model → provider; need server‑side tools, MCP, or a
workspace → Agent.** They compose: use the provider for pure text/JSON steps and
the Agent for the tool‑driven ones.

## Install

```bash
pnpm add @coder/ai-sdk-provider ai zod
```

Requires Node ≥ 22, `ai` v7, and a Coder deployment with **AI Gateway enabled**
(stable since Coder **v2.29**, GA in v2.30, on by default in v2.34; requires the
AI Governance Add-On).

## Named providers and the two wire protocols

Your Coder admins define AI Gateway **providers** — named routes on the
deployment (`/api/v2/aibridge/<name>/v1/…`), each speaking one of **two wire
protocols** determined by its admin-configured type:

| Wire protocol            | Provider types behind it                                                        | Default name |
| ------------------------ | ------------------------------------------------------------------------------- | ------------ |
| **OpenAI-compatible**    | `openai`, `azure`, `google`, `copilot`, `openai-compat`, `openrouter`, `vercel` | `openai`     |
| **Anthropic-compatible** | `anthropic` (native Claude), `bedrock` (Bedrock-hosted Claude)                  | `anthropic`  |

Routing is **by URL path, not by model id** — the provider name in the URL
decides which upstream handles the request. `createCoder` fronts the default
`openai` / `anthropic` pair: the bare call `coder(modelId)` picks between them
by heuristic (model ids starting with `claude`/`anthropic` go to the
Anthropic-protocol provider, everything else to the OpenAI-protocol one), and
the explicit accessors override it (e.g. to reach Claude through a
Copilot-typed provider on the OpenAI protocol):

```ts
coder("gpt-4o"); // → `openai` provider
coder("claude-sonnet-4-6"); // → `anthropic` provider (heuristic)
coder.openai("claude-sonnet-4"); // → `openai` provider (e.g. Copilot)
coder.anthropic("claude-opus-4-5"); // → `anthropic` provider (explicit)
```

### Custom-named providers

Provider names are admin-chosen (matching `^[a-z0-9]+(-[a-z0-9]+)*$`), so a
deployment may expose e.g. an Azure-backed `azure-openai` next to a
Bedrock-backed `anthropic-bedrock`. Reach them in two ways:

**Sub-provider accessors** — `openaiProvider(name)` / `anthropicProvider(name)`
return a full sub-provider bound to that gateway provider, so one
`createCoder` instance can target any number of providers. Pick the accessor
matching the provider's wire protocol:

```ts
const azure = coder.openaiProvider("azure-openai"); // OpenAI-compatible type
const bedrock = coder.anthropicProvider("anthropic-bedrock"); // Anthropic-compatible type

await generateText({ model: azure("gpt-4o"), prompt: "Hi" });
await generateText({ model: bedrock("claude-sonnet-4-6"), prompt: "Hi" });
```

A name outside the gateway's grammar throws the AI SDK's
`InvalidArgumentError` at accessor time (such a name can never be registered);
a well-formed name that is not configured on your deployment fails at request
time with the gateway's 404.

**Re-pointing the defaults** — when your deployment simply names its one
OpenAI/Anthropic pair differently, override the names once and keep using the
bare call and the `openai` / `anthropic` accessors:

```ts
const renamed = createCoder({
  baseURL: "https://coder.example.com",
  apiKey: process.env.CODER_API_TOKEN!,
  providers: { openai: "azure-openai", anthropic: "anthropic-bedrock" },
});
```

**Provider names come from your platform team.** Discovery is admin-only
server-side: `GET /api/v2/ai/providers` returns `403` for regular users, and
the models endpoint does not attribute models to providers. Ask your Coder
admins which provider names your deployment defines.

Model ids are passed through **unchanged** to the upstream provider (no
`vendor/model` namespacing) — use whatever ids your deployment's providers accept.

**Embeddings are not supported yet.** AI Gateway does not intercept
`/v1/embeddings`, so `coder.textEmbeddingModel(id)` — and the embedding
accessors on `coder.openai` — throw the AI SDK's `NoSuchModelError`
immediately instead of emitting a request the gateway rejects with a 404. The
accessors stay so they can light up without a breaking change once the gateway
adds an embeddings route — see
[coder/ai-sdk#69](https://github.com/coder/ai-sdk/issues/69).

## Authentication

**Centralized mode (default).** Pass your Coder API token as `apiKey`. AI Gateway
holds the upstream provider keys and brokers the call — this is all you need:

```ts
createCoder({ baseURL: "https://coder.example.com", apiKey: coderToken });
```

**Bring-your-own-key (BYOK) mode.** Set `coderToken` (sent in the
`X-Coder-AI-Governance-Token` header to authenticate you to the gateway) and pass
your _upstream_ provider key as `apiKey` (forwarded to the upstream):

```ts
createCoder({
  baseURL: "https://coder.example.com",
  coderToken, // authenticates you to AI Gateway
  apiKey: upstreamKey, // your own OpenAI/Anthropic key
});
```

## Configuration

| Option          | Type                      | Default                | Description                                                                                           |
| --------------- | ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `baseURL`       | `string`                  | — (required)           | Your Coder deployment URL, e.g. `https://coder.example.com`. The AI Gateway path is appended for you. |
| `apiKey`        | `string`                  | —                      | Coder API token (centralized) or upstream key (BYOK).                                                 |
| `coderToken`    | `string`                  | —                      | Enables BYOK mode; sent in `X-Coder-AI-Governance-Token`.                                             |
| `headers`       | `Record<string,string>`   | —                      | Extra headers merged into every request.                                                              |
| `aiGatewayPath` | `string`                  | `/api/v2/aibridge`     | Override if your deployment uses a different mount path.                                              |
| `providers`     | `{ openai?, anthropic? }` | `openai` / `anthropic` | Re-point the default pair at differently-named providers.                                             |
| `fetch`         | `typeof fetch`            | global `fetch`         | Custom fetch (testing / middleware).                                                                  |

## Enterprise governance & security

Reference for security reviewers evaluating this package. The boundary between
the two kinds of claims below matters: **client behavior** (what this package
puts on the wire) is verifiable in [`src/provider.ts`](./src/provider.ts) —
~250 lines with no dependencies beyond the official AI SDK provider packages —
while **gateway behavior** (key custody, audit capture, retention) is a
property of your Coder deployment, enforced server-side regardless of what any
client does, and documented in the
[AI Gateway docs](https://coder.com/docs/ai-coder/ai-gateway).

### Data flow

```text
your app ──HTTP(S)──▶ your Coder deployment ──▶ upstream provider
 (this package)       (AI Gateway intercepts    (Anthropic, OpenAI,
                       /api/v2/aibridge/…)       Bedrock, Copilot, …)
```

**What leaves your app.** This package's only network destination is the
`baseURL` you configure. It never contacts upstream vendors directly and adds
no telemetry of its own; each request is exactly what the AI SDK builds for a
normal provider call:

- **URL** — `POST <baseURL>/api/v2/aibridge/<provider>/v1/chat/completions`
  (OpenAI surface) or `…/v1/messages` (Anthropic surface). `/api/v2/aibridge`
  is this package's
  default; deployments also serve the post-rename alias `/api/v2/ai-gateway`
  (see `aiGatewayPath`).
- **Auth headers** — per the mode matrix below.
- **Body** — standard OpenAI-/Anthropic-format JSON: the model id (passed
  through unchanged), your full prompt/message content, tool definitions, and
  sampling parameters. Prompt content is visible to the Gateway — that is what
  enables auditing.
- Anything you add via the `headers` option.

Transport security follows the scheme of your `baseURL` — the client does not
enforce `https://` (an `http://` URL sends tokens, keys, and prompts in
plaintext). Always use an HTTPS deployment URL outside trusted local
environments.

**What the Gateway does before forwarding** _(server-side —
[authentication docs](https://coder.com/docs/ai-coder/ai-gateway/auth))_: it
authenticates the token as an active Coder user and rejects the request
outright when it is missing or invalid (nothing is forwarded upstream), strips
all Coder credentials from the outbound request, and attaches the upstream
credential for the mode in use.

### Credential isolation: centralized vs. BYOK

|                                 | **Centralized (default)**                                             | **BYOK**                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Your app holds                  | Coder API token only                                                  | Coder API token **+** the user's own upstream key                                                                                        |
| On the wire                     | `Authorization: Bearer <Coder token>` (both surfaces)                 | `X-Coder-AI-Governance-Token: <Coder token>`; upstream key in `Authorization: Bearer` (OpenAI surface) / `x-api-key` (Anthropic surface) |
| Upstream provider keys live     | On the deployment, admin-configured — never distributed to developers | With the individual user; forwarded per request, bypassing the deployment's central key pool                                             |
| Coder token forwarded upstream? | **No** — stripped and replaced by the deployment's provider key       | **No** — the governance header is stripped before forwarding                                                                             |
| Admin control                   | Provider and key configuration, rotation, failover                    | Can be disabled deployment-wide (`CODER_AI_GATEWAY_ALLOW_BYOK=false` rejects requests carrying the governance header with `403`)         |

Both modes are audited identically: audit records store _which credential
kind_ was used (`centralized` / `byok`), not the credential itself.

### Audit capture

Every request is attributed to the Coder user whose token authenticated it —
per user, per request, in both modes. Per intercepted request the Gateway
records _(server-side —
[audit docs](https://coder.com/docs/ai-coder/ai-gateway/audit))_:

- **Identity & metadata** — initiating user, provider, model, client,
  credential kind, timestamps.
- **Last user prompt** — earlier turns and system prompts are not stored.
- **Token usage** — input / output / cache counts.
- **Tool calls** — tool name and arguments; tool _results_ are not stored.
- **Model reasoning** — extended-thinking / reasoning-summary content when
  present.

Model-generated response text is **discarded**, not stored. Retention defaults
to **60 days** and is configurable (`CODER_AI_GATEWAY_RETENTION`; `0` keeps
data indefinitely). Auditors browse sessions and causal tool-call chains in
the deployment dashboard under `/ai-gateway/sessions`.

### Required Coder permissions

| To…                                          | You need                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send requests through the Gateway            | An active Coder user with a valid API token — no extra role. (RBAC: members hold create/update on `aibridge_interception`, i.e. recording their own traffic.) |
| Read audit data (prompts, tool calls, usage) | The **Owner** or **Auditor** role. Regular members cannot read interceptions back — not even their own.                                                       |
| Configure providers / keys, toggle BYOK      | Deployment administrator (server flags / deployment configuration).                                                                                           |
| Use the feature at all                       | A deployment licensed for [AI Governance](https://coder.com/docs/ai-coder/ai-governance) — the Gateway is license-gated server-side.                          |

### Security FAQ

- **Does prompt data ever go anywhere other than my deployment?** This package
  only ever _initiates_ requests to `baseURL`; onward traffic to the upstream
  vendor originates from your deployment (or its standalone gateway replicas),
  using the providers your admins configured. One standard-`fetch` caveat:
  redirects are followed by default, so a cross-origin redirect issued by your
  deployment or an intermediary would resend the request — prompt body and
  non-`Authorization` headers (in BYOK mode that includes `x-api-key` and the
  governance token) — to the redirect target. To forbid this, supply a custom
  fetch: `fetch: (url, init) => fetch(url, { ...init, redirect: "error" })`.
- **Do developers ever handle raw provider keys?** Centralized mode: no —
  developers only ever hold a Coder token. BYOK mode: they supply their own
  personal key, which is forwarded per request without entering central custody.
- **What is the blast radius of a leaked Coder token?** A Coder API token is
  not an AI-only credential — it grants the bearer the user's **full Coder API
  permissions** (workspaces, templates, and anything else that user's roles
  allow), and, until revoked or expired, AI usage through your Gateway (fully
  attributed to that user). What it can _not_ do is authenticate to upstream
  vendors: under normal Gateway forwarding it is stripped and does not leave
  your deployment (the cross-origin-redirect caveat above is the exception —
  a redirect can resend non-`Authorization` headers, including the governance
  header, before the Gateway ever sees them). Treat a leak as a Coder account
  compromise — revoke the token — and prefer short-lived, dedicated tokens
  for AI workloads.
- **Is model-generated content stored?** Partially. Assistant _response text_
  is discarded, but two model-generated artifacts are retained for auditing:
  reasoning content (extended thinking / reasoning summaries) and tool-call
  arguments — alongside the last user prompt and token counts.
- **Can I verify the client claims myself?** Yes: [`src/provider.ts`](./src/provider.ts)
  is the entire wire-facing surface — it only selects base URLs and auth
  headers, then delegates request construction to the official AI SDK provider
  packages. [`test/provider.test.ts`](./test/provider.test.ts) asserts the
  request URL, auth headers, and model pass-through for the chat/messages
  routes in both auth modes; the underlying AI SDK packages add their own
  protocol headers (e.g. `anthropic-version`) and are not re-tested here.

## Examples

Runnable scripts live in [`examples/`](./examples) (run against a real deployment via `tsx`):

```bash
export CODER_URL=https://coder.example.com
export CODER_API_TOKEN=$(coder tokens create --name ai-sdk-provider-example)

pnpm example:generate    # non-streaming generateText
pnpm example:stream      # streaming streamText
pnpm example:anthropic   # the Anthropic surface (native Claude)
```

## License

[Apache-2.0](./LICENSE) © Coder Technologies, Inc.
