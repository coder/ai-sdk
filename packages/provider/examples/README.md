# Examples

Runnable scripts for `@coder/ai-sdk-provider`, run against the source
(`../src/index.js`) with [`tsx`](https://tsx.is).

**Prerequisite:** a deployment with **AI Gateway enabled** and at least one
provider configured.

## Setup

```bash
export CODER_URL=https://coder.example.com
export CODER_API_TOKEN=$(coder tokens create --name ai-sdk-provider-example)

# Optional:
export CODER_MODEL=claude-sonnet-4-6     # any model id your deployment proxies
export CODER_ANTHROPIC_MODEL=claude-sonnet-4-6    # used by 03-anthropic.ts
```

Default model ids assume Anthropic is configured; override them to match your
deployment.

## Run

```bash
pnpm example:generate    # 01-generate.ts  — non-streaming generateText()
pnpm example:stream      # 02-stream.ts    — streaming streamText()
pnpm example:anthropic   # 03-anthropic.ts — the Anthropic surface explicitly
```
