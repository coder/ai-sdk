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

## Install

```bash
pnpm add @coder/ai-sdk-provider ai zod
```

Requires Node ≥ 20, `ai` v6, and a Coder deployment with **AI Gateway enabled**
(stable since Coder **v2.29**, GA in v2.30, on by default in v2.34; requires the
AI Governance Add-On).

## The two surfaces

AI Gateway exposes **two provider-namespaced surfaces** on your deployment, and
routing is **by URL path, not by model id** — so each surface reaches a fixed set
of upstreams:

| Surface                                                 | Reaches                                                                                               | Accessor                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **OpenAI-compatible** (`/api/v2/aibridge/openai/v1`)    | OpenAI, Azure, Google, OpenRouter, Vercel, openai-compat — and **Copilot** (incl. Claude via Copilot) | `coder.openai(id)` / `coder.chat(id)`        |
| **Anthropic-compatible** (`/api/v2/aibridge/anthropic`) | **native Claude** + **Bedrock-hosted Claude**                                                         | `coder.anthropic(id)` / `coder.messages(id)` |

The bare call `coder(modelId)` picks a surface by heuristic — model ids starting
with `claude`/`anthropic` go to the Anthropic surface, everything else to the
OpenAI surface. Use the explicit accessors to override (e.g. to reach Claude
through a Copilot-typed provider on the OpenAI surface):

```ts
coder("gpt-4o"); // → OpenAI surface
coder("claude-sonnet-4-6"); // → Anthropic surface (heuristic)
coder.openai("claude-sonnet-4"); // → OpenAI surface (e.g. Copilot)
coder.anthropic("claude-opus-4-5"); // → Anthropic surface (explicit)
coder.textEmbeddingModel("text-embedding-3-small"); // → OpenAI surface
```

Model ids are passed through **unchanged** to the upstream provider (no
`vendor/model` namespacing) — use whatever ids your deployment's providers accept.

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
| `providers`     | `{ openai?, anthropic? }` | `openai` / `anthropic` | Override the admin-configured provider path segments.                                                 |
| `fetch`         | `typeof fetch`            | global `fetch`         | Custom fetch (testing / middleware).                                                                  |

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
