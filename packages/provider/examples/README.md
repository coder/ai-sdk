# Examples

Runnable scripts for `@coder/ai-sdk-provider`. They import from `../src/index.js`
so you can run them straight against the source with [`tsx`](https://tsx.is).

## Setup

```bash
export CODER_URL=https://coder.example.com
export CODER_API_TOKEN=$(coder tokens create --name ai-sdk-provider-example)

# Optional:
export CODER_MODEL=claude-sonnet-4-6     # any model id your deployment proxies
export CODER_ANTHROPIC_MODEL=claude-sonnet-4-6    # used by 03-anthropic.ts
```

Your deployment must have **AI Gateway enabled** and at least one provider
configured. The default model ids assume Anthropic is configured; override them
with the env vars above to match what your deployment proxies.

## Run

```bash
pnpm example:generate    # 01-generate.ts  — non-streaming generateText()
pnpm example:stream      # 02-stream.ts    — streaming streamText()
pnpm example:anthropic   # 03-anthropic.ts — the Anthropic surface explicitly
```
