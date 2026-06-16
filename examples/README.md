# Examples

Runnable scripts that exercise `CoderAgent` against a real Coder deployment. They run straight
against the source with [`tsx`](https://github.com/privatenumber/tsx) — no build step needed.

In your own project the import is `import { CoderAgent } from "@coder/ai-sdk-agent"`; here the examples
import from `../src/index.js` so they run against the local source.

## Setup

```bash
export CODER_URL=https://dev.coder.com
export CODER_SESSION_TOKEN=$(coder tokens create --name coderagent-example)
# optional:
#   export CODER_ORG_ID=<org-uuid>      # otherwise auto-detected from your user
#   export CODER_MODEL=haiku            # model hint for most examples
#   export CODER_TOOL_MODEL=sonnet      # model used by the tool example
```

Each example **creates a new chat and archives it when done** — it never creates or touches
workspaces.

## Run

```bash
pnpm example:generate     # 01 — non-streaming generate()
pnpm example:stream       # 02 — streaming via textStream
pnpm example:tool         # 03 — custom (client-executed) tool round-trip
pnpm example:multi-turn   # 04 — multi-turn session memory
```

…or directly: `pnpm tsx examples/01-generate.ts`.

| File | Shows |
|---|---|
| `01-generate.ts` | `await agent.generate({ prompt })` → text, finish reason, usage |
| `02-stream.ts` | `await agent.stream({ prompt })` → live `textStream` |
| `03-custom-tool.ts` | a `tool({ inputSchema, execute })` the model must call; the round-trip + final answer |
| `04-multi-turn.ts` | reusing one agent as a session; the model recalls earlier context |
