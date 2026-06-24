# @coder/ai-sdk-agent

[![CI](https://github.com/coder/ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A **Vercel AI SDK–compliant agent backed by Coder Agents** — Coder's server‑side
agent runtime. Call `new CoderAgent(...)` and get back an object that implements the
AI SDK's [`Agent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/agent) interface
(`generate()` / `stream()`). Script it, stream from it, and attach your own tools —
exactly like the SDK's own `ToolLoopAgent`.

> Status: works end‑to‑end against Coder's experimental chat API (`/api/experimental/chats`).
> Both the Coder API and this package are pre‑1.0; expect change.

## Why

**Coder Agents** runs a complete agent loop **server‑side** — the multi‑step tool
loop, built‑in tools, MCP, sub‑agents, multi‑provider model routing, and automatic
context compaction. The Vercel AI SDK runs its loop **client‑side**. This package
bridges the two, so a Coder agent looks and feels like a native AI SDK agent without
re‑implementing the loop.

## Agent vs. provider — which package?

Two packages, two jobs:

- **`@coder/ai-sdk-agent` (this package)** — Coder's **server‑side agent**: the
  multi‑step tool loop, built‑in tools, MCP servers, workspace‑scoped file/shell
  tools, sub‑agents, and compaction all run on the deployment. Each `CoderAgent`
  is one server chat ("session") and may provision a workspace. Reach for it when
  you need **server‑side tools, MCP, or a workspace**.
- **[`@coder/ai-sdk-provider`](../provider)** — **plain model calls** through
  Coder's AI Gateway. A normal AI SDK provider: `generateText`, `streamText`, and
  **`generateObject` for schema‑constrained structured output**. No chat, no
  workspace, natively cancelable. Reach for it when you just need **a model**
  (plan / extract / summarize / classify) with no server‑side tools.

Rule of thumb: **need server‑side tools, MCP, or a workspace → Agent; need a model
→ provider.** They compose — a multi‑step pipeline often uses the provider for its
pure text/JSON steps and the Agent only for the steps that touch tools.

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
  organizationId: "703f72a1-…", // your org UUID
  model: "claude-sonnet-4-6", // hint: UUID, provider:model, model id, or display-name substring
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
`.usage`, etc. all work). Because `CoderAgent` _is_ an `Agent`, it composes with the rest
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
pnpm example:file         # attach a file to a chat (optional: pass a path)
```

Each example creates a new chat and archives it when done — it never touches workspaces. See
[`examples/README.md`](./examples/README.md) for details.

## Custom tools

Tools you pass are registered with Coder Agents as **client‑executed** ("dynamic") tools.
When the model calls one, the run pauses on the server; the AI SDK runs your tool's
`execute`, this package submits the result back, and the run resumes. This is the standard
AI SDK tool loop — your `execute` runs in your process.

- Give tools an `execute` for scripting use (the loop runs to completion automatically).
- Coder's own server‑side tools (file editing, shell, MCP, …) still run on the server and
  appear in the transcript as `providerExecuted` tool calls/results — you observe them, you
  don't execute them.

## Files

There are two distinct ways to get a file to the agent, depending on whether the model should
**read** it or **operate on** it.

**Chat attachments** — content for the model to read (a PDF, image, CSV…). Drop a native AI SDK
`file` part into a message and it's uploaded transparently:

```ts
import { readFile } from "node:fs/promises";

await agent.generate({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this report." },
        {
          type: "file",
          data: await readFile("report.pdf"),
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    },
  ],
});
```

Or upload once and reuse across turns with `attach()` — which also accepts a `Blob`/`File` or
stream (use `fs.openAsBlob` to avoid reading the whole file into memory):

```ts
const file = await agent.attach({
  content: await openAsBlob("report.pdf"),
  mediaType: "application/pdf",
});
await agent.generate({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "List the risks." },
        file.toFilePart(), // references the upload by id — no re-upload
      ],
    },
  ],
});
```

Attachments are capped at **10 MiB** and restricted to a narrow media‑type allowlist
(`application/pdf`, `application/json`, `text/{plain,markdown,csv}`, `image/{png,jpeg,gif,webp}`).
Oversized or unsupported files throw a clear error up front.

**Workspace files** — material for the agent to operate on (a zip of assets, a dataset, a
binary — anything outside the allowlist or over the cap). Write it onto the workspace filesystem
and let the agent's tools take over. This needs a `workspaceFiles` adapter (the agent core stays
dependency‑free; whoever holds a workspace connection supplies a few‑line adapter):

```ts
const agent = new CoderAgent({ /* … */ workspaceId: ws.id, workspaceFiles });
const { path } = await agent.uploadToWorkspace({
  content: await openAsBlob("assets.zip"),
  path: "assets.zip",
});
// Then ask the agent to `unzip assets.zip` — uploadToWorkspace writes bytes as-is; it does not unpack.
```

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

One `CoderAgent` instance maps to one chat ("session") on the Coder server. The chat is
created on the first turn and reused for subsequent `generate()`/`stream()` calls (multi‑turn
conversation with server‑side history). `agent.chatId` is the current chat id.

- `agent.resetSession()` — start a fresh chat on the next turn (reuse one instance for sequential turns; you don't need a new agent per turn).
- `agent.interrupt()` — interrupt an in‑flight generation.
- `agent.archive()` — archive the underlying chat (cleanup; see [Cleanup](#cleanup)).
- `agent.listModels()` — list the deployment's model configs, so you don't have to guess the `model` hint.
- Resume a prior chat: `new CoderAgent({ …, chatId: "…" })`.

A single instance is **single‑flight** — don't run concurrent generations against it. For concurrency, use one instance per session (and see [Workspaces & quota](#workspaces--quota)).

## Timeouts & cancellation

Pass an `abortSignal` to `generate()`/`stream()` to cancel a turn. Aborting
**interrupts the server‑side run** (not just the local socket), so the chat stops
generating and releases its resources instead of running on, orphaned. Tearing
down a `stream()` early (cancelling the stream) interrupts the run too.

For a hard ceiling, set `requestTimeoutMs`. If a segment runs longer (e.g. the
server is wedged, or a workspace can't be scheduled), the run is interrupted and
the call rejects with a retryable `CoderChatError` (`kind: "timeout"`) instead of
hanging:

```ts
const agent = new CoderAgent({ /* … */ requestTimeoutMs: 120_000 });
```

`requestTimeoutMs` bounds **each server segment** — one model round‑trip until it
settles or pauses for a client tool. A multi‑step `generate()` that drives client
tools runs several segments, so it bounds each one, not the whole call. To cap the
**total** wall‑clock of a multi‑step call, pass a deadline as the signal instead:

```ts
await agent.generate({ prompt: "…", abortSignal: AbortSignal.timeout(120_000) });
```

If the event stream drops before the turn settles, the call rejects with
`CoderChatError` (`kind: "stream_closed"`, retryable) rather than returning a
truncated result as if the turn had finished.

## Cleanup

`archive()` soft‑hides the chat (it stays in listings as `archived: true`; there
is no hard delete yet). To make cleanup ride scope exit instead of a `finally` you
have to remember, the agent is an **async disposable**:

```ts
await using agent = new CoderAgent({
  /* … */
});
const { text } = await agent.generate({ prompt: "…" });
// agent.archive() runs automatically when the scope exits (best‑effort).
```

In a request handler that returns before a fire‑and‑forget `archive()` settles, the
archive can be abandoned — `await using` (or an awaited `archive()` in `finally`)
avoids accumulating live chats.

## Handling errors

All errors extend `CoderAgentError`. Two carry structured detail you can branch on:

- **`CoderApiError`** — an HTTP request failed. Fields: `status`, `method`, `path`, `detail`.
- **`CoderChatError`** — a turn ended in an error, timed out, or lost its stream. Fields: `kind`, `retryable`, `statusCode`, `provider`.

```ts
import { CoderApiError, CoderChatError } from "@coder/ai-sdk-agent";

try {
  await agent.generate({ prompt: "…" });
} catch (err) {
  if (err instanceof CoderChatError && err.retryable) {
    // transient (timeout, stream_closed, an upstream 5xx) — back off and retry
  } else if (err instanceof CoderApiError && err.status === 429) {
    // rate limited
  } else {
    throw err;
  }
}
```

`maxRetries` defaults to `0`: this agent owns server‑side chat state, so an
SDK‑level retry could duplicate a turn. Prefer catching `retryable` errors and
retrying the whole step deliberately.

## Structured output

`CoderAgent` does **not** constrain output to a JSON schema — chatd has no
server‑side `response_format`, so a `responseFormat` / `experimental_output`
request emits a warning and is best‑effort at most. For reliable
schema‑constrained output, use **[`@coder/ai-sdk-provider`](../provider)** with
`generateObject` / `Output.object` (requires AI Gateway enabled on the
deployment). Use the Agent for the steps that need server‑side tools; use the
provider for pure text‑in / JSON‑out steps.

## Workspaces & quota

A `CoderAgent` is one server‑side chat, and — depending on its configuration and
the deployment — a chat may provision a **Coder workspace** to run its tools. A
deployment caps how many workspaces an account may run at once, so **N agents
running concurrently can need N free workspace slots.** Past the cap, a turn can
sit unscheduled and never settle. This is the most important operational fact when
running many agents at once:

- Keep your own concurrency below the deployment's workspace limit.
- Set `requestTimeoutMs` so an unschedulable turn fails loudly instead of hanging.
- `archive()` / `await using` each agent so finished chats stop holding resources.
- For steps that don't need server‑side tools, prefer the provider — it never touches a workspace.

## Configuration

`CoderAgentSettings`:

| field                             | description                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `client` \| (`baseUrl` + `token`) | connection (one or the other)                                                                    |
| `organizationId`                  | org UUID that owns the chat (required)                                                           |
| `model`                           | model hint: UUID, `provider:model`, model id, or display‑name substring                          |
| `instructions`                    | system prompt                                                                                    |
| `tools`                           | AI SDK `ToolSet` (client‑executed)                                                               |
| `workspaceId`                     | bind the chat to a Coder workspace (enables workspace‑scoped tools)                              |
| `workspaceFiles`                  | adapter enabling `uploadToWorkspace()` (write files to the workspace FS)                         |
| `mcpServerIds`                    | server‑side MCP servers to enable                                                                |
| `planMode`                        | enable plan mode (`"plan"`)                                                                      |
| `stopWhen`                        | AI SDK stop condition(s); default `stepCountIs(64)`                                              |
| `maxRetries`                      | default `0` — SDK retries can duplicate server‑side turns; override with care                    |
| `requestTimeoutMs`                | per‑turn time budget (ms); interrupts the run and rejects (`kind: "timeout"`) instead of hanging |
| `chatId`                          | resume an existing chat                                                                          |

## How it works

```
CoderAgent  (implements ai.Agent)
  └─ ToolLoopAgent (ai)            ← inherits generate()/stream(), loop control
       └─ CoderLanguageModel       ← implements @ai-sdk/provider LanguageModelV3
            └─ CoderChatClient      ← REST + WebSocket to /api/experimental/chats
                 └─ Coder Agents     ← runs the agent loop SERVER-side
```

- One `doStream` call advances the chat until it **settles** (`waiting`/`completed`) or
  **pauses** for a client tool (`requires_action`). The SDK loop and the server‑side loop
  mesh at the client‑tool boundary, so there's no double loop.
- Streaming text is emitted from `message_part` deltas; fast turns that only produce a full
  `message` snapshot are diffed against an emitted‑length cursor — so neither double‑counts.

## Durable workflows (Vercel Workflow, step functions, …)

`CoderAgent` talks to Coder over its own REST + WebSocket client, so it can't ride
a `fetch`‑shim durability layer — each turn must run **inside** a durable step. A
few rules keep it well‑behaved across replays:

- **One turn per step.** Create the agent, run a single `generate()` (not
  `stream()`, so the checkpointed value is the finished result), return.
- **Don't persist the instance across steps.** Persist `agent.chatId` (a string)
  and resume with `new CoderAgent({ …, chatId })` in the next step. Never persist
  or log the token — read it from the environment in each step.
- **Clean up in the step.** `await using` the agent (or `await agent.archive()` in
  a `finally`) so a step that returns early doesn't abandon the chat.
- **Bound each step.** Set `requestTimeoutMs` so a wedged turn fails the step (and
  lets the workflow retry) instead of hanging the whole run.
- **Mind concurrency vs. workspaces.** Keep fan‑out width under the deployment's
  workspace cap — see [Workspaces & quota](#workspaces--quota).
- **Use the provider for pure steps.** Steps that don't need server‑side tools
  (plan / extract / synthesize) are cheaper and natively structured through
  [`@coder/ai-sdk-provider`](../provider) + `generateObject` — no chat, no
  workspace, no cleanup.

## Testing

```bash
pnpm test          # unit tests (hermetic, mocked client)
pnpm typecheck
pnpm lint          # lint with oxlint
pnpm format        # format with oxfmt (or `pnpm format:check` to verify only)
pnpm check         # format check + lint + typecheck (CI gate)
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
- Designed for Node (WebSocket via `ws`); a browser build can inject a `webSocketFactory`.
- A v7 `@ai-sdk/harness` adapter (the conceptually exact fit) is a future direction once that
  experimental API stabilizes.

## License

Apache-2.0
