# @coder/ai-sdk-agent

A **Vercel AI SDK–compliant agent for Coder `chatd`**. Call `new CoderAgent(...)` and
get back an object that implements the AI SDK's [`Agent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/agent)
interface (`generate()` / `stream()`), backed by a remote Coder agent runtime. Script it,
stream from it, and attach your own tools — exactly like the SDK's own `ToolLoopAgent`.

> Status: works end‑to‑end against Coder's experimental chat API (`/api/experimental/chats`).
> Both the Coder API and this package are pre‑1.0; expect change.

## Why

Coder `chatd` is a complete, **server‑side** agent runtime: it runs the multi‑step tool
loop itself, with built‑in tools, MCP, sub‑agents, multi‑provider model routing, and
automatic context compaction. The Vercel AI SDK runs its loop **client‑side**. This package
bridges the two so a Coder agent looks and feels like a native AI SDK agent — without
re‑implementing the loop.

## Install

```bash
pnpm add @coder/ai-sdk-agent ai zod
```

Requires Node ≥ 20 and `ai` v6.

## Quick start

```ts
import { CoderAgent } from "@coder/ai-sdk-agent";
import { tool } from "ai";
import { z } from "zod";

const agent = new CoderAgent({
  baseUrl: "https://dev.coder.com",
  token: process.env.CODER_SESSION_TOKEN!, // Coder API/session token
  organizationId: "703f72a1-…",            // your org UUID
  model: "claude-sonnet-4-6",              // hint: UUID, provider:model, model id, or display-name substring
  instructions: "You are a helpful coding assistant.",
  tools: {
    getWeather: tool({
      description: "Get the weather for a city.",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 21 }),
    }),
  },
});

// Non-streaming
const { text, steps, usage } = await agent.generate({ prompt: "Weather in Paris?" });

// Streaming
const result = await agent.stream({ prompt: "Write a haiku about Coder." });
for await (const delta of result.textStream) process.stdout.write(delta);
```

`generate()` returns a real AI SDK `GenerateTextResult`; `stream()` returns a real
`StreamTextResult` (so `.textStream`, `.fullStream`, `.toUIMessageStream()`, `.steps`,
`.usage`, etc. all work). Because `CoderAgent` *is* an `Agent`, it composes with the rest
of the AI SDK.

## Examples

Runnable scripts live in [`examples/`](./examples) (run against a real deployment via `tsx`):

```bash
export CODER_URL=https://dev.coder.com
export CODER_SESSION_TOKEN=$(coder tokens create --name coderagent-example)

pnpm example:generate     # non-streaming generate()
pnpm example:stream       # streaming via textStream
pnpm example:tool         # custom (client-executed) tool round-trip
pnpm example:multi-turn   # multi-turn session memory
```

Each example creates a new chat and archives it when done — it never touches workspaces. See
[`examples/README.md`](./examples/README.md) for details.

## Custom tools

Tools you pass are registered with chatd as **client‑executed** ("dynamic") tools. When the
model calls one, chatd pauses; the AI SDK runs your tool's `execute`, and this package
submits the result back to chatd, which then resumes. This is the standard AI SDK tool loop —
your `execute` runs in your process.

- Give tools an `execute` for scripting use (the loop runs to completion automatically).
- chatd's own server‑side tools (file editing, shell, MCP, …) still run on the server and
  appear in the transcript as `providerExecuted` tool calls/results — you observe them, you
  don't execute them.

## Auth

Pass a Coder **API token** or **session token** as `token`; it is sent as the
`Coder-Session-Token` header (REST) and used to authenticate the streaming WebSocket. Create
a token with `coder tokens create`, or reuse your CLI session.

You can also pass a pre‑built client:

```ts
import { CoderAgent, CoderChatClient } from "@coder/ai-sdk-agent";
const client = new CoderChatClient({ baseUrl, token });
const agent = new CoderAgent({ client, organizationId });
```

## Sessions

One `CoderAgent` instance maps to one chatd chat ("session"). The chat is created on the
first turn and reused for subsequent `generate()`/`stream()` calls (multi‑turn conversation
with server‑side history). `agent.chatId` is the current chat id.

- `agent.resetSession()` — start a fresh chat on the next turn.
- `agent.interrupt()` — interrupt an in‑flight generation.
- `agent.archive()` — archive the underlying chat (cleanup).
- Resume a prior chat: `new CoderAgent({ …, chatId: "…" })`.

A single instance is **single‑flight** — don't run concurrent generations against it.

## Configuration

`CoderAgentSettings`:

| field | description |
|---|---|
| `client` \| (`baseUrl` + `token`) | connection (one or the other) |
| `organizationId` | org UUID that owns the chat (required) |
| `model` | model hint: UUID, `provider:model`, model id, or display‑name substring |
| `instructions` | system prompt |
| `tools` | AI SDK `ToolSet` (client‑executed) |
| `workspaceId` | bind the chat to a Coder workspace (enables workspace‑scoped tools) |
| `mcpServerIds` | chatd‑side MCP servers to enable |
| `planMode` | chatd plan mode (`"plan"`) |
| `stopWhen` | AI SDK stop condition(s); default `stepCountIs(64)` |
| `maxRetries` | default `0` — SDK retries can duplicate server‑side turns; override with care |
| `chatId` | resume an existing chat |

## How it works

```
CoderAgent  (implements ai.Agent)
  └─ ToolLoopAgent (ai)            ← inherits generate()/stream(), loop control
       └─ CoderLanguageModel       ← implements @ai-sdk/provider LanguageModelV3
            └─ CoderChatClient      ← REST + WebSocket to /api/experimental/chats
                 └─ Coder chatd      ← runs the agent loop SERVER-side
```

- One `doStream` call advances the chat until it **settles** (`waiting`/`completed`) or
  **pauses** for a client tool (`requires_action`). The SDK loop and chatd's loop mesh at the
  client‑tool boundary, so there's no double loop.
- Streaming text is emitted from `message_part` deltas; fast turns that only produce a full
  `message` snapshot are diffed against an emitted‑length cursor — so neither double‑counts.

## Testing

```bash
pnpm test          # unit tests (hermetic, mocked client)
pnpm typecheck
pnpm build
```

End‑to‑end tests run against a live Coder deployment and are opt‑in via env:

```bash
CODER_URL=https://dev.coder.com \
CODER_SESSION_TOKEN=$(coder tokens create --name e2e) \
pnpm test:e2e
```

The e2e suite creates **new chats only** (no workspaces) and archives them afterward.

## Limitations

- The Coder chat API is experimental (`/api/experimental/chats`); wire types may change.
- File/image **inputs** are not yet forwarded to chatd (text prompts only).
- Designed for Node (WebSocket via `ws`); a browser build can inject a `webSocketFactory`.
- A v7 `@ai-sdk/harness` adapter (the conceptually exact fit) is a future direction once that
  experimental API stabilizes.

## License

Apache-2.0
