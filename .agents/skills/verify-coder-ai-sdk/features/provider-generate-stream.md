# Call a model through AI Gateway

`createCoder({ baseURL, apiKey })` from `@coder/ai-sdk-provider` returns an AI SDK provider that calls models through the deployment's AI Gateway with the user's Coder token, so the caller needs no provider API key. `generateText()` returns a whole reply, and `streamText()` yields it in parts.

## Sub-features

- `gateway-generate` returns text, finish reason `stop`, and usage from `generateText()`.
- `gateway-stream` yields text from `streamText().textStream` and reports usage at the end.
- `gateway-auth` authenticates with the Coder token alone.

## How to get to it (user POV)

- Call `generateText({ model: coder("claude-sonnet-4-6"), prompt })` or `streamText(...)` with `const coder = createCoder({ baseURL, apiKey })`.
- Run `pnpm tsx examples/01-generate.ts` or `pnpm tsx examples/02-stream.ts` in `packages/provider`.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` prints `token valid`.
- The deployment's AI Gateway serves the model in `VERIFY_PROVIDER_MODEL` (default `claude-sonnet-4-6`).

- **Generate.** Ask the one-sentence question. Run `.agents/skills/verify-coder-ai-sdk/verify.sh drive provider-generate-stream`. `PASS generateText returned text`, `PASS finish reason is stop`, and `PASS usage reports output tokens` appear.
- **Stream.** Ask for the haiku in `examples/02-stream.ts`, in the same drive. `PASS textStream produced text` and `PASS stream usage reports output tokens` appear. `streamed-text.txt` holds the haiku.
- **Proof.** Keep `01-generate.clean.txt`, `02-stream.clean.txt`, `streamed-text.txt`, and `checks.txt`.

## Gotchas

- This feature has no second view. The gateway's interception log is not available to a normal user (`GET /api/v2/aibridge/interceptions` returns 404 on dogfood), and the provider creates no chat. The proof is the API result and its usage.
- **CAUTION: Call the gateway only through the examples. Do not send your Coder token to other gateway routes by hand.**
- The examples read `CODER_API_TOKEN` before `CODER_SESSION_TOKEN`. A stale `CODER_API_TOKEN` in the environment wins.
