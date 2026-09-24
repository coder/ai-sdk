# Enterprise governance & security

Reference for security reviewers evaluating `@coder/ai-sdk-provider`.

Two kinds of claims appear below. Keep them apart:

| Claim kind           | Covers                                | Where it is enforced / verifiable                                                                                                                                          |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client behavior**  | What this package puts on the wire    | [`src/provider.ts`](https://github.com/coder/ai-sdk/blob/main/packages/provider/src/provider.ts): ~250 lines, no dependencies beyond the official AI SDK provider packages |
| **Gateway behavior** | Key custody, audit capture, retention | Your Coder deployment, server-side, regardless of what any client does. See the [AI Gateway docs](https://coder.com/docs/ai-coder/ai-gateway)                              |

## Data flow

```text
your app ──HTTP(S)──▶ your Coder deployment ──▶ upstream provider
 (this package)       (AI Gateway intercepts    (Anthropic, OpenAI,
                       /api/v2/aibridge/…)       Bedrock, Copilot, …)
```

### What leaves your app

The only network destination is the `baseURL` you configure. The package never
contacts upstream vendors directly and adds no telemetry of its own. Each
request is exactly what the AI SDK builds for a normal provider call:

- **URL:** `POST <baseURL>/api/v2/aibridge/<provider>/v1/chat/completions`
  (OpenAI surface) or `…/v1/messages` (Anthropic surface). `/api/v2/aibridge`
  is this package's default for compatibility. Use the canonical
  `/api/v2/ai-gateway` path with Coder v2.35.0 or later (see `aiGatewayPath`).
- **Auth headers:** per the [mode matrix](#credential-isolation-centralized-vs-byok).
- **Body:** standard OpenAI-/Anthropic-format JSON: the model id (passed
  through unchanged), your full prompt/message content, tool definitions, and
  sampling parameters. Prompt content is visible to the Gateway; that is what
  enables auditing.
- Anything you add via the `headers` option.

**Transport security follows your `baseURL` scheme.** The client does not
enforce `https://`: an `http://` URL sends tokens, keys, and prompts in
plaintext. Always use an HTTPS deployment URL outside trusted local
environments.

### What the Gateway does before forwarding

_Server-side; see the [authentication docs](https://coder.com/docs/ai-coder/ai-gateway/auth)._

1. Authenticates the token as an active Coder user. A missing or invalid token
   is rejected outright; nothing is forwarded upstream.
2. Strips all Coder credentials from the outbound request.
3. Attaches the upstream credential for the mode in use.

## Credential isolation: centralized vs. BYOK

|                                 | **Centralized (default)**                                             | **BYOK**                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Your app holds                  | Coder API token only                                                  | Coder API token **+** the user's own upstream key                                                                                        |
| On the wire                     | `Authorization: Bearer <Coder token>` (both surfaces)                 | `X-Coder-AI-Governance-Token: <Coder token>`; upstream key in `Authorization: Bearer` (OpenAI surface) / `x-api-key` (Anthropic surface) |
| Upstream provider keys live     | On the deployment, admin-configured — never distributed to developers | With the individual user; forwarded per request, bypassing the deployment's central key pool                                             |
| Coder token forwarded upstream? | **No** — stripped and replaced by the deployment's provider key       | **No** — the governance header is stripped before forwarding                                                                             |
| Admin control                   | Provider and key configuration, rotation, failover                    | Can be disabled deployment-wide (`CODER_AI_GATEWAY_ALLOW_BYOK=false` rejects requests carrying the governance header with `403`)         |

Both modes are audited identically. Audit records store _which credential
kind_ was used (`centralized` / `byok`), not the credential itself.

## Audit capture

_Server-side; see the [audit docs](https://coder.com/docs/ai-coder/ai-gateway/audit)._

Every request is attributed to the Coder user whose token authenticated it:
per user, per request, in both modes. For each intercepted request the Gateway
records:

| Recorded            | Details                                                               |
| ------------------- | --------------------------------------------------------------------- |
| Identity & metadata | Initiating user, provider, model, client, credential kind, timestamps |
| Last user prompt    | Earlier turns and system prompts are not stored                       |
| Token usage         | Input / output / cache counts                                         |
| Tool calls          | Tool name and arguments; tool _results_ are not stored                |
| Model reasoning     | Extended-thinking / reasoning-summary content when present            |

- Model-generated response text is **discarded**, not stored.
- Retention defaults to **60 days** and is configurable
  (`CODER_AI_GATEWAY_RETENTION`; `0` keeps data indefinitely).
- Auditors browse sessions and causal tool-call chains in the deployment
  dashboard under `/ai-gateway/sessions`.

## Required Coder permissions

| To…                                          | You need                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send requests through the Gateway            | An active Coder user with a valid API token — no extra role. (RBAC: members hold create/update on `aibridge_interception`, i.e. recording their own traffic.) |
| Read audit data (prompts, tool calls, usage) | The **Owner** or **Auditor** role. Regular members cannot read interceptions back — not even their own.                                                       |
| Configure providers / keys, toggle BYOK      | Deployment administrator (server flags / deployment configuration).                                                                                           |
| Use the feature at all                       | A deployment licensed for [AI Governance](https://coder.com/docs/ai-coder/ai-governance) — the Gateway is license-gated server-side.                          |

## Security FAQ

### Does prompt data ever go anywhere other than my deployment?

This package only ever _initiates_ requests to `baseURL`. Onward traffic to the
upstream vendor originates from your deployment (or its standalone gateway
replicas), using the providers your admins configured.

**Redirect caveat (standard `fetch`):** redirects are followed by default. A
cross-origin redirect issued by your deployment or an intermediary would
resend the request to the redirect target: the prompt body and
non-`Authorization` headers (in BYOK mode that includes `x-api-key` and the
governance token). To forbid this, supply a custom fetch:

```ts
createCoder({
  baseURL: "https://coder.example.com",
  apiKey: process.env.CODER_API_TOKEN!,
  fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
});
```

### Do developers ever handle raw provider keys?

- **Centralized mode:** no. Developers only ever hold a Coder token.
- **BYOK mode:** they supply their own personal key, which is forwarded per
  request without entering central custody.

### What is the blast radius of a leaked Coder token?

A Coder API token is not an AI-only credential. Until revoked or expired, it
grants the bearer:

- the user's **full Coder API permissions** (workspaces, templates, and
  anything else that user's roles allow), and
- AI usage through your Gateway, fully attributed to that user.

It can _not_ authenticate to upstream vendors. Under normal Gateway forwarding
it is stripped and does not leave your deployment. The exception is the
[cross-origin-redirect caveat](#does-prompt-data-ever-go-anywhere-other-than-my-deployment):
a redirect can resend non-`Authorization` headers, including the governance
header, before the Gateway ever sees them.

Treat a leak as a Coder account compromise: revoke the token. Prefer
short-lived, dedicated tokens for AI workloads.

### Is model-generated content stored?

Partially. Assistant _response text_ is discarded, but two model-generated
artifacts are retained for auditing: reasoning content (extended thinking /
reasoning summaries) and tool-call arguments. The last user prompt and token
counts are retained alongside them.

### Can I verify the client claims myself?

Yes.

- [`src/provider.ts`](https://github.com/coder/ai-sdk/blob/main/packages/provider/src/provider.ts) is the entire wire-facing surface. It
  only selects base URLs and auth headers, then delegates request construction
  to the official AI SDK provider packages.
- [`test/provider.test.ts`](https://github.com/coder/ai-sdk/blob/main/packages/provider/test/provider.test.ts) asserts the request URL,
  auth headers, and model pass-through for the chat/messages routes in both
  auth modes.
- The underlying AI SDK packages add their own protocol headers (e.g.
  `anthropic-version`) and are not re-tested here.
