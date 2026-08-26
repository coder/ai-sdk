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
pnpm add @coder/ai-sdk-agent ai@^7 zod
```

Requires Node ≥ 22 and `ai` v7 — the constructors throw an actionable error when
another `ai` major is detected (the guard fails open when the installed version
can't be resolved), instead of failing cryptically mid‑generation.

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
pnpm example:structured   # typed structured output via the structured_output tool
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

Migration note: since v0.2.1 server‑executed tools stream with `dynamic: true`
(they aren't in your `ToolSet`, and the AI SDK only accepts unknown tool names on
dynamic calls). In UI message streams they therefore surface as `dynamic-tool`
parts rather than `tool-{name}` parts — key off `toolName`, not `part.type`, when
rendering them.

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

When `baseUrl`/`token` are not passed, they default from the `CODER_URL` and
`CODER_SESSION_TOKEN` environment variables (the same convention as
`@coder/ai-sdk-sandbox`'s transports); explicit settings win over the
environment. With the variables set, connection config disappears entirely:

```ts
const agent = new CoderAgent({ organizationId }); // uses CODER_URL + CODER_SESSION_TOKEN
```

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
- `agent.interrupt({ signal? })` — interrupt an in‑flight generation.
- `agent.archive({ signal? })` — archive the underlying chat (cleanup; see [Cleanup](#cleanup)).
- `agent.listModels()` — list the deployment's model configs, so you don't have to guess the `model` hint.
- Resume a prior chat: `new CoderAgent({ …, chatId: "…" })` — see
  [Durable workflows](#durable-workflows-persist-resume-recover) for the full
  resumption how‑to.

Interrupting is asynchronous on the server: `interrupt()` resolves as soon as the
interrupt is acknowledged, and the run keeps winding down for a few seconds
afterwards. The client‑level `client.interruptChat(chatId, { wait: true })` sends
`?wait=true` to ask the server to hold the response until the run has stopped —
current Coder servers ignore the unknown parameter and still return immediately,
so confirm completion via the event stream (e.g. [`watchChats`](#watching-chats))
rather than relying on it.

A single instance is **single‑flight** — don't run concurrent generations against it. For concurrency, use one instance per session (and see [Workspaces & quota](#workspaces--quota)).

## Rehydrating chat history

Chat history lives on the server. To render an existing chat in a UI (e.g. after
a reload), fetch its messages with the `CoderChatClient` (`agent.client`, or one
you construct — see [Auth](#auth)) and convert them with
`chatMessagesToUIMessages` — the mapping mirrors what a live‑streamed transcript
of the same turn looks like:

```ts
import { chatMessagesToUIMessages } from "@coder/ai-sdk-agent";

const { messages } = await client.getMessages(chatId);
const uiMessages = chatMessagesToUIMessages(messages);
// e.g. in React: useChat({ messages: uiMessages })
```

The converter sorts by message id, so the endpoint's newest‑first default page
order (and any pagination order) is safe to pass straight in — `useChat` always
receives a chronological transcript.

Tool calls become `dynamic-tool` parts with their results folded in, `source`
parts become `source-url` parts, and unknown part kinds are skipped silently, so
history written by newer Coder servers degrades gracefully. One caveat: history
does not record which tool names were client (`ToolSet`) tools, so _every_ tool
call rehydrates as `dynamic-tool` — live, client tools stream as statically
typed `tool-{name}` parts. Render tools by name (ai's
`isToolOrDynamicToolUIPart` and `getToolOrDynamicToolName`) rather than by
exact `part.type` and the difference disappears. Persisted `file`
parts carry only a `file_id` (no bytes, usually no URL), so pass a `fileUrl`
resolver to keep attachments visible — download the bytes with
`client.getChatFile(fileId)` and return a data:/object/proxy URL; parts that end
up without a URL are skipped:

```ts
chatMessagesToUIMessages(messages, {
  fileUrl: (part) => (part.file_id ? `/api/files/${part.file_id}` : undefined),
});
```

## Watching chats

`client.watchChats({ signal })` yields lifecycle events (status/title changes,
creation, deletion, …) for **every chat visible to the authenticated user** as an
async iterable, backed by the `/api/experimental/chats/watch` WebSocket:

```ts
for await (const event of client.watchChats({ signal })) {
  if (event.kind === "status_change") console.log(event.chat.id, event.chat.status);
}
```

Unlike the per‑chat event stream, this is a long‑lived subscription: dropped
connections are redialed automatically with exponential backoff (1s doubling to
a 30s cap, reset once an event arrives). Iteration ends only when the signal
aborts, or with a terminal `CoderApiError` when the server rejects the upgrade
with a 4xx — bad/expired token, or an older Coder server without the endpoint
(404). For custom plumbing (own client, browser sockets), the standalone
`watchChatEvents({ baseUrl, token, signal, webSocketFactory })` export provides
the same stream without a `CoderChatClient`.

## Observability

`onTransportEvent` receives typed transport events — HTTP exchanges, the
per‑chat stream's WebSocket lifecycle, and turn‑segment boundaries — so timing
and tracing need no `fetch`/`webSocketFactory` wrapping and no re‑parsing of
stream frames. Pass it on `CoderAgentSettings` (it reaches both the client and
the model), on `CoderChatClientOptions`, or on `CoderLanguageModelConfig`:

```ts
import { CoderAgent, type CoderTransportEvent } from "@coder/ai-sdk-agent";

const events: CoderTransportEvent[] = [];
const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  onTransportEvent: (ev) => events.push(ev),
});

await agent.generate({ prompt: "…" });

// e.g. attribute where the turn spent its time:
for (const ev of events) {
  if (ev.type === "http:response")
    console.log(
      `${ev.op}: ${ev.method} ${ev.path} → ${ev.status} in ${ev.durationMs.toFixed(0)}ms`,
    );
  if (ev.type === "ws:event" && ev.event.type === "action_required")
    console.log(`tool calls arrived at +${ev.timestamp - events[0]!.timestamp}ms`);
  if (ev.type === "segment:settle")
    console.log(`segment ${ev.segment}: ${ev.status} in ${ev.durationMs.toFixed(0)}ms`);
}
```

`CoderTransportEvent` is a discriminated union on `type`. Every event carries
`timestamp` (`Date.now()` at observation — comparable to server‑side timestamps
such as a message's `created_at`, for delivery‑lag measurements):

| event            | when                                                | payload (besides `timestamp`)                                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http:request`   | a REST request is sent                              | `id` (correlates the pair), `op` (the client operation, e.g. `"createChatMessage"`), `method`, `path`                                                                                                                                                                             |
| `http:response`  | response headers arrive (incl. non‑2xx, `ok:false`) | `id`, `op`, `method`, `path`, `status`, `ok`, `durationMs`                                                                                                                                                                                                                        |
| `http:error`     | the fetch itself rejects (network failure, abort)   | `id`, `op`, `method`, `path`, `message`, `durationMs`                                                                                                                                                                                                                             |
| `ws:dial`        | a stream connection attempt starts                  | `chatId`, `reader` (identifies the `streamChatEvents` call), `attempt` (1‑based per reader, increments per redial), `url`                                                                                                                                                         |
| `ws:open`        | the WebSocket handshake completes                   | `chatId`, `reader`, `attempt`                                                                                                                                                                                                                                                     |
| `ws:event`       | a decoded stream event arrives                      | `chatId`, `reader`, `attempt`, `event` (the decoded `ChatStreamEvent`, by reference — don't mutate), `forwarded` (the reader's replay verdict)                                                                                                                                    |
| `ws:close`       | the connection ends (exactly one per dial)          | `chatId`, `reader`, `attempt`, `code`/`reason` when the server/network closed it; absent when the reader closed it (settle, teardown, redial)                                                                                                                                     |
| `ws:error`       | a socket error or unparseable frame                 | `chatId`, `reader`, `attempt`, `message`                                                                                                                                                                                                                                          |
| `ws:redial`      | a dropped connection is about to be redialed        | `chatId`, `reader`, `attempt` (the ended connection), `consecutiveFailures`, `maxConsecutiveFailures`, `backoffMs`                                                                                                                                                                |
| `segment:start`  | a turn segment (one model round‑trip) starts        | `segment` (1‑based per model instance), `chatId` (absent before the first turn creates the chat)                                                                                                                                                                                  |
| `segment:settle` | the segment ends (exactly one per start)            | `segment`, `chatId`, `reader` (the reader that served the segment; absent if none was acquired), `durationMs`, and: `status` + `finishReason` on a clean settle, `error` (`{name, message}`, plus `status` if the run still settled terminally) on failure, neither on a teardown |

Semantics worth knowing:

- **Isolation** — exceptions thrown by the handler are swallowed; they can never
  alter transport behavior or a turn's outcome.
- **Zero overhead** — without a handler, no event objects are allocated and no
  extra socket listeners are registered.
- **No secrets** — events carry no headers and no tokens (auth travels in the
  `Coder-Session-Token` header, which is deliberately excluded); `path`/`url`
  never contain credentials.
- `http:*` events name their operation: `op` is the public `CoderChatClient`
  method performing the exchange (`"createChat"`, `"createChatMessage"`,
  `"getMessages"`, `"submitToolResults"`, … — the `CoderClientOperation`
  union), so per‑operation classification never has to reverse‑engineer
  `path`. `method`/`path` stay for generic consumers; `archiveChat` stamps its
  own `op` even though it issues the same `PATCH` as `updateChat`.
- `ws:event` fires at arrival: after a redial, chatd's replay of the
  in‑progress episode is visible here (correlate with `reader`/`attempt`),
  stamped with the reader's own replay verdict — `forwarded: false` exactly on
  the duplicate deltas the reader suppresses from the turn, so subscribers
  never re‑derive the episode filter.
- `forwarded` does **not** reflect snapshot dedup: repeated or revised
  `message` snapshots are always `forwarded: true`, because reconciling them
  is deliberately the consumer's job past the transport layer —
  `TurnTranslator`'s per‑message ledger decides what a revision re‑emits, and
  that disposition is not stamped on transport frames. Use `ws:event` for
  span pairing and replay accounting; subscribers needing content fidelity
  must consume model output (or `TurnTranslator`), not transport frames.
- Every `ws:*` event carries `reader` — a monotonic id for the
  `streamChatEvents` call (reader) behind the connection, allocated from one
  process‑wide counter so it stays unique across model and client instances.
  `attempt` restarts at 1 per reader, so identify a connection as
  `(chatId, reader, attempt)`, never `(chatId, attempt)` alone: a client‑tool
  pause the caller abandons is closed fire‑and‑forget when the next turn dials
  its replacement, and the superseded reader's late `ws:close` (or a raced‑in
  frame) can emit after the new reader's `ws:dial` — the reader id is what
  tells them apart. `segment:settle` names the reader that served the segment;
  `segment:start` predates stream acquisition and carries none.
- A multi‑step turn that drives client tools emits one `segment:start`/
  `segment:settle` pair per round‑trip, all riding **one** `ws:dial`ed
  connection — the stream is retained across `requires_action` pauses. A pause
  settles with `status: "requires_action"`, `finishReason: "tool-calls"`; the
  final settle carries the terminal status (`waiting`/`completed`/`error`).
- `ws:*` events cover the per‑chat `/stream` reader (turn transport). The
  `watchChats` subscription is not instrumented.
- With a pre‑built `client` in `CoderAgentSettings`, HTTP/WS events come from
  the hook given to **that client's** options; the agent‑level hook then only
  receives `segment:*` events.

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

If the event stream drops mid‑turn, the agent redials it automatically with
exponential backoff, replaying the turn's events from its starting cursor and
deduplicating them on receipt — the server keeps generating during the gap, so
a transient drop costs nothing and the run is **not** interrupted. Only when the stream cannot be re‑established (several
consecutive failed attempts, ~15s) is the server run interrupted and the call
rejected with a `CoderStreamError` — an AI SDK `APICallError`. When the failed
turn had just created its chat AND had no external effects a replay would
repeat — no `workspaceId`, no `mcpServerIds`, and no freshly uploaded inline
attachments (pre‑uploaded `fileId` references are fine) — the dead session is
discarded and the error is `isRetryable: true`, so `generate()` calls with
`maxRetries` set retry the whole turn on a fresh chat automatically. Otherwise
the error is `isRetryable: false` and retrying is the caller's deliberate
decision: on a chat with prior state (resumed sessions, later turns,
tool‑result segments) a re‑invocation would resubmit the same prompt as a new
user turn, workspace/MCP tools may already have executed side effects, and
inline attachments would upload again. (For `stream()`, a mid‑stream failure
surfaces on the stream itself, outside the SDK's retry wrapper — handle it in
your consumption loop.)
A non‑transient 4xx upgrade rejection (bad/expired token,
deleted chat) fails fast with a `CoderApiError` instead of retrying; 408/425/429
consume the redial budget like any other transient failure.

## Cleanup

`archive()` soft‑hides the chat (it stays in listings as `archived: true`; there
is no hard delete yet). A freshly interrupted chat keeps winding down server‑side
for a few seconds, during which archiving 409s — `archive()` retries those 409s
(~1s apart, up to ~15s overall; tune with `settleDeadlineMs` /
`settleRetryDelayMs`) and rethrows the last one if the chat never settles. Any
other failure, including your own abort, rethrows immediately.

`archive()` and `interrupt()` target the session's chat — or, after the session
was dropped (`resetSession()`, or the automatic discard after a fresh‑chat
stream failure — see [Handling errors](#handling-errors)), the **last‑known
chat id** (`agent.lastKnownChatId`), so a stranded chat is still cleaned up
instead of leaking. Generation never uses the last‑known id: a turn after a
drop creates a fresh chat as always. Every chat stranded by an _automatic_
discard is also recorded on a ledger (`agent.strandedChatIds`, oldest first) —
with `maxRetries` several failed attempts can strand one chat each while only
the final attempt's error surfaces — and one `archive()` retires them all,
oldest first, alongside its primary target. Both methods report what they
acted on instead of silently no‑oping: `archive()` resolves
`{ archived: true, chatId, archivedChatIds }` (each archived id is cleared as
a cleanup target) or `{ archived: false }` when no chat exists at all;
`interrupt()` resolves `{ interrupted: true, chatId }` /
`{ interrupted: false }` the same way. Deliberate abandonment is different:
`resetSession()` does **not** add to the ledger (you may want that chat kept),
so after a manual reset the old chat is targetable only until a new chat
supersedes `lastKnownChatId`.

To make cleanup ride scope exit instead of a `finally` you have to remember, the
agent is an **async disposable**:

```ts
await using agent = new CoderAgent({/* … */});
const { text } = await agent.generate({ prompt: "…" });
// agent.interrupt() + agent.archive() run automatically when the scope exits.
```

Disposal interrupts any in‑flight run, then archives. It is **bounded and never
throws** (~15s overall, best‑effort): disposal errors are swallowed so they can't
mask the scope's own error. Call `archive()` directly when you need guaranteed
cleanup.

In a request handler that returns before a fire‑and‑forget `archive()` settles, the
archive can be abandoned — `await using` (or an awaited `archive()` in `finally`)
avoids accumulating live chats.

## Handling errors

All errors extend `CoderAgentError`, except `CoderStreamError` (below). Two
carry structured detail you can branch on:

- **`CoderApiError`** — an HTTP request failed. Fields: `status`, `method`, `path`, `detail`.
- **`CoderChatError`** — a turn ended in an error, timed out, or lost its stream. Fields: `kind`, `retryable`, `statusCode`, `provider`.
- **`CoderStreamError`** — the event stream dropped and could not be re‑established
  within its redial budget. Extends the AI SDK's `APICallError` (not
  `CoderAgentError`), so `generate()`'s `maxRetries` machinery recognizes it.
  `isRetryable` is `true` only when the failed turn created its chat (the dead
  session is discarded, so a retry starts fresh) and had no external effects to
  repeat (workspace/MCP tooling, fresh attachment uploads); otherwise it is
  `false` — a retry would resubmit the prompt as a new user turn and could
  duplicate those effects. A failure mid‑`stream()` surfaces on the stream,
  outside the retry wrapper. The last transport failure is in `cause`, and
  `chatId` names the chat the failed turn had created or attached to (absent
  when it failed before a chat existed) — after the fresh‑chat discard the
  chat still exists server‑side, and `archive()` keeps targeting it via
  `agent.lastKnownChatId` ([Cleanup](#cleanup)).

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

## Usage & cost

Results carry normalized token usage in `usage`. A chatd turn runs several
model steps server‑side (one per server tool round), each reporting its own
usage — the SDK **sums every step**, and the AI SDK adds up the steps of a
turn that paused for client tools, so `result.usage` reflects what the whole
turn actually consumed. `inputTokens` is the full prompt size: Coder
normalizes the wire `input_tokens` to the _uncached_ count (cache reads/writes
are separate fields), so the SDK adds them back into the total and exposes the
split via `inputTokenDetails` (`noCacheTokens`, `cacheReadTokens`,
`cacheWriteTokens`).

The snake_case wire usage lives **per step** at `result.steps[i].usage.raw`
(the AI SDK does not carry `raw` onto the summed `result.usage`) for fields
the normalized shape has no slot for (`context_limit`, cost, runtime, and any
newer wire fields, which pass through newest‑value‑wins). `raw` keeps the wire
convention (`input_tokens` = uncached only) with counters summed over that
step's server‑side model steps and `context_limit` from the newest one — so
don't divide `raw`'s summed counters by `context_limit` to estimate context
fullness; they are turn consumption, not a prompt‑size snapshot. When the
server reports them, `total_cost_micros` (micro‑USD) and `total_runtime_ms`
are mirrored the same way under each step's `providerMetadata.coder`
(`result.providerMetadata` reflects only the final step — sum
`result.steps[*].providerMetadata.coder` for whole‑turn cost when client tools
ran). Both are **absence‑tolerant mirrors**: on servers that don't send them
(cost is otherwise only on the aggregate cost endpoints,
`/api/experimental/chats/cost/*`), nothing is emitted.

Forward usage to a UI via message metadata:

```ts
const result = await agent.stream({ prompt: "…" });
return result.toUIMessageStream({
  messageMetadata: ({ part }) =>
    part.type === "finish-step"
      ? { usage: part.usage, coder: part.providerMetadata?.coder }
      : undefined,
});
```

## Sources

Model configs with web search enabled emit `source` parts. These flow through to
`result.sources` and, in UI message streams, `source-url` parts (pass
`sendSources: true` to `toUIMessageStream` — the AI SDK omits them by default).
Earlier releases dropped them.

## Structured output

Coder Agents has no server‑side `response_format`, so `CoderAgent` cannot
constrain what the model **says** to a JSON schema — a `responseFormat` /
`experimental_output` request emits a warning and is best‑effort at most. Pick
by what the step needs:

- **Pure text‑in / JSON‑out, no server‑side tools** → use
  **[`@coder/ai-sdk-provider`](../provider)** with `generateObject` /
  `Output.object` (schema‑constrained; requires AI Gateway on the deployment).
- **The answer must come out of an agent run** (server‑side tools, MCP, a
  workspace) → use the **`structured_output` tool pattern** below. What the
  model _says_ isn't schema‑constrained, but what it passes **into a tool** is
  typed — so have it submit its answer by _calling a tool_ whose `inputSchema`
  is your Zod schema. The answer arrives as the tool call's typed `input`; no
  fishing JSON out of prose.

```ts
import { stepCountIs, tool } from "ai";
import { z } from "zod";

const Answer = z.object({ severity: z.enum(["critical", "major", "minor"]), summary: z.string() });

const agent = new CoderAgent({
  /* … */
  instructions: "… Submit your final answer by calling the structured_output tool exactly once.",
  tools: {
    structured_output: tool({
      description:
        "Submit your final structured answer as JSON. Call this exactly once, when your work is complete.",
      inputSchema: Answer, // your schema IS the tool's input schema
      // Ack instead of stopping the turn: the model finishes naturally and can
      // wind down anything it still has running (dev servers, watchers, …).
      execute: async () =>
        "Output received. Wind down and end your turn. Do not call structured_output again.",
    }),
  },
  stopWhen: stepCountIs(6), // happy path is 2 steps: file + ack, wind down
});

const result = await agent.generate({ prompt: "…" });
// toolCalls only holds the LAST step's calls — scan all steps. Take the last call
// that VALIDATES: a schema-invalid re-file must not shadow a valid answer (rule 2).
const filed = result.steps
  .flatMap((s) => s.toolCalls)
  .filter((c) => c.toolName === "structured_output");
let answer: z.infer<typeof Answer> | undefined;
for (const call of filed.reverse()) {
  const parsed = Answer.safeParse(call.input);
  if (parsed.success) {
    answer = parsed.data; // typed: { severity: "critical" | "major" | "minor"; summary: string }
    break;
  }
}
if (answer === undefined)
  throw new Error("no valid structured_output call — nudge once on an idle chat (rule 3)");
```

Rules that keep it robust — each guards against a failure mode observed live:

1. **Don't force `toolChoice`, don't stop on the call.** `toolChoice` is
   construction‑time and applies to _every_ segment, so after the ack it would
   force the tool again and again up to the step ceiling (and it blocks any
   other tools the step needs). A `hasToolCall` stop is worse: the server only
   receives a client tool result as a side effect of the _next_ loop segment,
   so ending the loop on the call strands the chat in `requires_action` —
   follow‑up messages queue forever and `archive()` 409s. Instructions plus the
   tool's own description are enough; models file unprompted most of the time.
2. **Validate client‑side.** The schema is not enforced server‑side —
   `schema.safeParse` on the tool input is the real gate. (Schema‑invalid calls
   that the AI SDK catches in‑loop are automatically answered with a
   `tool-error` result the model retries against.)
3. **Nudge at most once, and only an idle chat.** If the turn ends in prose
   (`finishReason: "stop"`) without a valid call, send one typed re‑prompt
   ("Call the structured_output tool now …"), then fail into your normal error
   handling. Never re‑prompt a chat that isn't idle — the message would queue
   behind whatever the server is still doing.
4. **Settle a turn that stopped on a tool call.** If the loop stops on a
   tool‑call step — e.g. your `stopWhen` ceiling lands exactly on the
   `structured_output` call (`finishReason: "tool-calls"`) — the tool results
   ran locally but never reached the server. Guard on `agent.chatId` (it is
   `undefined` until the first turn creates the chat), then submit the
   stranded step's (`result.steps.at(-1)`) locally‑executed client outcomes
   directly via
   `agent.client.submitToolResults(chatId, { results: [{ tool_call_id, output, is_error }] }, AbortSignal.timeout(8_000))`
   before touching the chat again, or it strands as in rule 1. Read the
   outcomes off the step's **content parts**: a `tool-result` part is a
   success, a `tool-error` part (the tool's `execute` threw) must be submitted
   with `is_error: true` — mirroring what the resume path would have sent. If
   a pending call has no local outcome (or the submit fails), end the stranded
   turn with `agent.client.interruptChat(chatId, AbortSignal.timeout(8_000))`
   instead. **Bound every one of these recovery requests with an
   `AbortSignal`** — they target a server that may already be stalled, and the
   bare `agent.interrupt()` / `agent.archive()` helpers carry no timeout. A
   settled chat resumes its wind‑down server‑side for a few seconds, so retry
   a 409ing archive (`agent.client.archiveChat(chatId, signal)`, per‑attempt
   bound) under a short deadline instead of giving up.

[`examples/06-structured-output.ts`](./examples/06-structured-output.ts) packages
all four rules into a small copyable helper — `structuredOutput(schema)` returns
`agentOpts` to spread into the constructor plus a typed `ask(agent, prompt)`
that runs the settle + one‑nudge ladder and returns a `z.infer<typeof schema>`.
Compose additional client tools through the helper —
`structuredOutput(schema, { tools: { myTool } })` merges them into one ToolSet —
rather than passing `tools:` to the constructor next to the spread, where the
later key silently clobbers the other map.

## Workspace previews

When the agent is bound to a workspace (the `workspaceId` setting), you can
resolve — and share — the browser URL where a port on that workspace is served,
e.g. the dev server the agent just started:

```ts
const { url } = await agent.getPreview({ port: 3000 });
// → https://3000--main--dev--alice.apps.example.com (private to the workspace owner)

const shared = await agent.sharePreview({ port: 3000, shareLevel: "authenticated" });
// shared.url is now reachable by any logged-in user; shared.shareLevel is the level in effect
```

Both are built on the stable v2 workspace APIs (workspace lookup + the wildcard
apps host; `sharePreview` adds a port‑share upsert), so they work against old
Coder servers — no experimental endpoints.

- `getPreview({ port, agentName?, protocol?, signal? })` composes the subdomain
  URL. The URL honors the port's current share level — private to the workspace
  owner unless shared. `agentName` is optional when the workspace has exactly one
  agent (with several, the error lists the candidates); `protocol: "https"` means
  the app speaks TLS _inside the workspace_ (it adds the `s` label suffix,
  `3000s--…`) and does not affect the browser scheme.
- `sharePreview({ port, shareLevel?, … })` additionally upserts the port's share
  level (re‑invoking updates it in place) and returns the level in effect.
  `shareLevel` is `"authenticated"` (any logged‑in user; the default),
  `"organization"` (members of the workspace's organization; requires a newer
  Coder server), or `"public"` (no auth at all — mind what the port serves).
  Reverting to owner‑only means deleting the share; `"owner"` is not accepted on
  upsert.
- Clear failures instead of broken URLs: a deployment without a wildcard access
  URL (`--wildcard-access-url`) yields an explanatory error, and a server that
  predates port sharing (< Coder v2.9) yields a 404 `CoderApiError` saying so.
  Ports below 1000 are rejected up front for the same reason — Coder subdomain
  URLs only encode 4–5 digit ports, so `80--agent--…` would be parsed as an app
  named "80" and never resolve; serve the preview on a higher port.

The preview helpers call non‑chat endpoints, so they need `baseUrl` + `token`
credentials — pass them alongside `client` if you construct one yourself (or
let them default from `CODER_URL`/`CODER_SESSION_TOKEN`).

## Workspaces & quota

A `CoderAgent` is one server‑side chat, and — depending on its configuration and
the deployment — a chat may be backed by a **Coder workspace** that runs its
tools. Workspaces are the scarce resource: a deployment budgets how many an
account may run at once, so **N agents running concurrently can need N
schedulable workspaces.** Past that bound, a turn can sit unscheduled and never
settle. This section is the operational guide for running fleets of agents:
how the binding works, how to size concurrency, what to clean up, and how to
diagnose a chat that is stuck.

### How a chat binds to a workspace

- **One chat, at most one workspace, fixed at creation.** `workspaceId` is sent
  as `workspace_id` when the chat is created; nothing can rebind it afterwards —
  message and update requests carry no workspace field. To move work to another
  workspace, start a new agent/chat.
- **This SDK never provisions workspaces.** A `workspaceId` you pass must be an
  existing workspace (provision one with
  [`@coder/ai-sdk-sandbox`](../sandbox)'s `ensureCoderWorkspace`, the CLI, or
  the v2 API). A chat created _without_ `workspaceId` can still come back
  workspace‑backed — deployments may assign one server‑side; the SDK reads the
  created chat's `workspace_id` and treats the chat as workspace‑backed from
  then on (which matters for retry ownership, below).
- **Chat cleanup does not release the workspace.** `archive()` soft‑hides the
  chat only; the workspace keeps running until template autostop or an explicit
  stop — and stopping releases only stop‑scoped quota; persistent resources
  (disks, volumes) keep consuming their cost until the workspace is deleted.

### Sizing a fleet

The structural rule: **workspaces that must be running concurrently ≤
schedulable workspaces.** With one workspace per chat — the common fleet shape,
and what a deployment that auto‑assigns workspaces produces — that means
concurrent chats ≤ schedulable workspaces. Chats explicitly bound to a shared
`workspaceId` count that workspace once, so their concurrency is not
quota‑bound — at the price of sharing one filesystem and tool environment,
which is only acceptable within a single tenant / trust boundary.
What counts as "schedulable" is a deployment property, not an SDK knob —
whichever of these binds first:

- **Workspace quota (premium deployments).** Templates declare per‑resource
  costs; a user's budget is the sum of their groups' quota allowances, enforced
  when a workspace build starts or stops. A start that would exceed the budget
  **fails the build** (error code `INSUFFICIENT_QUOTA`, "insufficient quota"),
  so the turn never gets its workspace — see
  [resource quotas](https://coder.com/docs/admin/users/quotas). Note that a
  _stopped_ workspace typically still consumes its persistent resources' cost,
  so a fleet that only ever stops (never deletes) scratch workspaces converges
  on a full budget.
- **Infrastructure.** Without quotas there is no per‑user workspace limit by
  default ([workspace lifecycle](https://coder.com/docs/user-guides/workspace-lifecycle)) —
  the bound is provisioner throughput and cluster capacity, and exceeding it
  looks like slow or failing builds rather than a crisp quota error.

Practical sizing:

- Read headroom before fanning out:
  `GET /api/v2/organizations/{org}/members/{user}/workspace-quota` returns
  `{ "credits_consumed": …, "budget": … }`. Quota is denominated in credits,
  not slots: admit another workspace only while `budget − credits_consumed`
  covers _that workspace's_ cost (the sum of its template's `daily_cost`
  declarations). "Free slots = headroom ÷ cost" only holds for a homogeneous
  fleet on one template; with mixed templates, size against each planned
  workspace's own cost.
- Keep fan‑out width within that headroom and queue the rest client‑side — an
  unschedulable turn does not queue usefully on the server (see
  [Preventing stuck turns](#preventing-stuck-turns)).
- Reuse one bound workspace across sequential turns and sessions instead of
  provisioning per request — the workspace is the expensive part, the chat is
  cheap. Reuse only **within one tenant / trust boundary**: workspace‑bound
  agents have file and shell tools, so a reused filesystem carries one
  session's artifacts (and secrets) into the next — provision per tenant, or
  securely reset a workspace before reassigning it.
- Steps that don't need server‑side tools belong on the
  [provider](../provider) — it never touches a workspace.

### Autostop & cleanup

Two lifetimes to manage, separately:

- **Chats** — `archive()` / `await using` every agent ([Cleanup](#cleanup)), or
  finished chats keep holding server resources.
- **Workspaces** — rely on template‑level scheduling rather than manual
  hygiene:
  - **Autostop TTL.** Give fleet templates a default TTL long enough to survive
    a normal session (including idle gaps between turns), short enough that a
    leaked workspace stops burning running‑cost within hours — without
    autostop, a leaked workspace pins its full quota until someone notices.
    Note that stopping only releases the quota of resources that go away on
    stop; persistent resources (disks, volumes) keep consuming their
    `daily_cost`, so a scratch fleet that only ever stops still converges on a
    full budget — pair the TTL with dormancy auto‑deletion or explicit
    deletion. With [`@coder/ai-sdk-sandbox`](../sandbox), `stopAfter: "8h"`
    sets the TTL (`ttl_ms`) at creation.
  - **Activity bump** (default 1 h) extends a running workspace's deadline when
    Coder detects sessions — check
    [what counts as activity](https://coder.com/docs/user-guides/workspace-scheduling)
    before assuming an agent's server‑side tool use keeps its workspace alive.
  - **Dormancy / failure cleanup** reap abandoned and repeatedly‑failing
    workspaces automatically — see
    [template scheduling](https://coder.com/docs/admin/templates/managing-templates/schedule).

### Preventing stuck turns

The signature failure mode of an over‑committed fleet: the chat is created, the
stream opens, and then — nothing. There is **no distinct "quota exceeded" error
kind on the chat stream**; a chat whose workspace can't be scheduled surfaces
either a generic turn error or, worse, a chat that sits in a non‑terminal
status indefinitely. Defend in this order:

1. **Set `requestTimeoutMs` — always, in fleets.** It is unbounded by default.
   On expiry the call rejects with a `CoderChatError` (`kind: "timeout"`,
   `retryable: true`) so your dispatcher gets its slot back, and a server‑side
   interrupt is fired **best‑effort** — fire‑and‑forget, and unreachable when
   the timeout lands before chat creation returned an id — so the run usually
   stops, but is not guaranteed released ([Timeouts](#timeouts--cancellation)).
   Pair it with reconciliation: periodically sweep for non‑terminal chats older
   than your budget and interrupt/archive them.
2. **Cap total wall‑clock** with `abortSignal: AbortSignal.timeout(…)` —
   `requestTimeoutMs` bounds each segment, not a whole multi‑tool call.
3. **Own the retries.** Workspace‑backed turns are **never auto‑retried**: the
   SDK marks a stream‑loss error `isRetryable` only when the failed turn
   created its chat _and_ had no workspace, no MCP servers, and no fresh
   uploads ([Timeouts](#timeouts--cancellation)). Your dispatcher owns the
   retry decision — and should re‑check quota headroom first, or it re‑queues
   into the same wall.
4. **Watch the fleet.** [`watchChats`](#watching-chats) yields status changes
   for every chat **visible to the authenticated user** — with chats spread
   across per‑tenant credentials, run one watcher per identity (or watch with
   a credential that can see them all). Alert on chats sitting in a
   non‑terminal status (e.g. `pending`) longer than your `requestTimeoutMs`.
   Events alone aren't a complete monitor: reconnects resubscribe fresh (no
   cursor or replay), so a chat already stuck before the watcher started — or
   one that transitioned during a gap — never emits an event to start your
   timer from. Seed and periodically reconcile against a chat listing
   (`GET /api/experimental/chats`) instead of trusting the event stream alone.

### Troubleshooting: unschedulable & stuck chats

Wire [`onTransportEvent`](#observability) into fleet telemetry — the event
sequence pinpoints _where_ a turn died:

| symptom (transport events)                                                                                                                                                                          | likely cause                                                                                                                                                                                                                                                                                                 | fix                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment:start` and `ws:open` fired, initial status events, then silence — no `message_part`, no `segment:settle`                                                                                   | if the chat's status is `pending` (or its workspace build is `pending`/`failed`): the workspace can't be scheduled — quota exhausted, no free provisioner, failing template. If the status is `running` with a healthy build, it may just be a slow model/tool step — silence alone doesn't prove scheduling | check quota headroom (`workspace-quota` endpoint) and the workspace's build — a quota failure logs `INSUFFICIENT_QUOTA`; reclaim enough _credits_ for the planned build (stopping helps only for stop‑scoped costs — delete workspaces to reclaim persistent costs, or raise the group allowance) and set `requestTimeoutMs` so this fails loudly next time                                                               |
| `segment:settle` carries `error: { name: "CoderChatError", message: "…requestTimeoutMs budget…" }`                                                                                                  | the per‑segment bound expired — wedged server, slow model, or an unschedulable workspace                                                                                                                                                                                                                     | inspect the workspace via the v2 API/UI: a `pending`/`failed` build means the row above; `running` means the turn was genuinely slow — raise `requestTimeoutMs` for long tool work                                                                                                                                                                                                                                        |
| repeated `ws:redial` with `consecutiveFailures` climbing toward `maxConsecutiveFailures` (5; backoff 1 s → 2 s → 4 s → 8 s, ≈15 s of redialing without forward progress), then a `CoderStreamError` | the network path to the deployment is failing — not workspace scheduling (the server keeps generating through short gaps)                                                                                                                                                                                    | fix connectivity; mind retry ownership above — on workspace‑backed chats the error is `isRetryable: false`, so the replay decision is yours                                                                                                                                                                                                                                                                               |
| `segment:settle` with `status: "error"` and an `error` payload                                                                                                                                      | the turn failed server‑side — a provider/model error, a tool failure, or a scheduling/build failure that terminated the turn instead of leaving it pending                                                                                                                                                   | the settle event's `error` carries only `{ name, message }` — branch on `kind` / `retryable` / `statusCode` by catching the thrown `CoderChatError`: at the `generate()` call site, or — for `stream()` — around stream consumption, since mid‑stream failures surface on the stream, not from `await agent.stream()` ([Handling errors](#handling-errors)); check the workspace build state to rule scheduling in or out |
| turn settled `status: "requires_action"`, follow‑up messages queue forever                                                                                                                          | the loop ended on an unanswered client tool call                                                                                                                                                                                                                                                             | submit the stranded results or interrupt — see rule 4 under [Structured output](#structured-output); if a crash left the pause behind, reconcile effects first ([Make client tools crash-safe](#make-client-tools-crash-safe))                                                                                                                                                                                            |
| `archive()` keeps returning 409 and rethrows after ~15 s                                                                                                                                            | the chat never settled server‑side — usually a stuck run still holding its workspace                                                                                                                                                                                                                         | `interrupt()` with a bounded signal, then re‑archive; if the run stays wedged, stop the workspace itself                                                                                                                                                                                                                                                                                                                  |

## Configuration

`CoderAgentSettings`:

| field                             | description                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `client` \| (`baseUrl` + `token`) | connection (one or the other; `baseUrl`/`token` default from `CODER_URL`/`CODER_SESSION_TOKEN`)  |
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
| `onTransportEvent`                | observability hook for typed transport events (see [Observability](#observability))              |
| `settleDeadlineMs`                | overall deadline for bounded cleanup (`archive()` 409 retries, disposal); default 15 000         |
| `settleRetryDelayMs`              | pause between `archive()` retries while the chat settles; default 1000                           |
| `chatId`                          | resume an existing chat                                                                          |

The `model` hint resolves against the deployment's model configs in order: a
config UUID is used as‑is, then an exact `provider:model` match, an exact model
id, a display‑name substring (case‑insensitive), and finally a model‑id
substring. Partial payloads from older/newer servers are tolerated (entries
match on the fields they carry), and an unresolvable hint falls back to the
server's default model instead of failing. Use `agent.listModels()` to see
what's available.

## How it works

```
CoderAgent  (implements ai.Agent)
  └─ ToolLoopAgent (ai)            ← inherits generate()/stream(), loop control
       └─ CoderLanguageModel       ← implements @ai-sdk/provider LanguageModelV4
            └─ CoderChatClient      ← REST + WebSocket to /api/experimental/chats
                 └─ Coder Agents     ← runs the agent loop SERVER-side
```

- One `doStream` call advances the chat until it **settles** (`waiting`/`completed`) or
  **pauses** for a client tool (`requires_action`). The SDK loop and the server‑side loop
  mesh at the client‑tool boundary, so there's no double loop.
- Streaming text is emitted from `message_part` deltas; every `message` snapshot is then
  reconciled against a per‑message emitted‑content ledger, so nothing double‑counts: a
  trailing snapshot after deltas is a no‑op, a fast snapshot‑only turn emits in full, a
  message that commits while the stream is redialing yields exactly its missing tail, and a
  revision that appends to an earlier message yields the appended suffix (rewrites that
  can't be expressed as deltas are safely suppressed).

## Durable workflows: persist, resume, recover

How to run **one agent session across process boundaries** — queue jobs,
durable‑workflow steps (Vercel Workflow, step functions, Temporal, …), cron
ticks — and survive the crashes, stream drops, and timeouts in between. The
mechanics this how‑to leans on are specified in [Sessions](#sessions),
[Timeouts & cancellation](#timeouts--cancellation),
[Handling errors](#handling-errors), and [Observability](#observability).

Two facts make the pattern work:

- **All chat state lives on the Coder server.** Messages, tool activity, the
  run itself — none of it is in your process. The only durable thing a
  workflow has to carry between steps is **`agent.chatId`: a string.**
- **`CoderAgent` can't ride a `fetch`‑shim durability layer** (it talks REST +
  WebSocket through its own client), so each turn runs **inside** a durable
  step — and the checkpointed chat id is the thread between steps.

Running example: a pipeline whose steps each run as their own job — possibly
on another machine, hours apart, retried after failures.

### Shape each step: one turn, then checkpoint

```ts
import { CoderAgent, type CoderTransportEvent } from "@coder/ai-sdk-agent";

// Any durable KV your engine gives you: step state, a job row, a DB table.
declare const checkpoints: {
  get(workflowId: string): Promise<string | undefined>;
  set(workflowId: string, chatId: string): Promise<void>;
};

export async function runTurn(workflowId: string, prompt: string): Promise<string> {
  const agent = new CoderAgent({
    baseUrl: process.env.CODER_URL!,
    token: process.env.CODER_SESSION_TOKEN!, // read per step — never checkpoint or log it
    organizationId: process.env.CODER_ORG_ID!,
    chatId: await checkpoints.get(workflowId), // undefined on the first step → the turn creates the chat
    requestTimeoutMs: 300_000, // always bound workflow steps — see below
    onTransportEvent: observe, // per-step telemetry — see below
  });

  try {
    const { text } = await agent.generate({
      prompt,
      // Total wall-clock for the step: requestTimeoutMs bounds each segment,
      // not a whole multi-segment (client-tool) turn — see "Bound every step".
      abortSignal: AbortSignal.timeout(600_000),
    });
    return text;
  } finally {
    // The durable resume handle — written even when the turn failed: a first
    // step that fails AFTER creating its chat (timeout, stream loss) must
    // still persist the id, or the retried step orphans a live chat and its
    // partial effects. Exception: after an exhausted stream failure on a
    // chat this very call created, the SDK has already discarded the dead
    // session (agent.chatId is undefined) and nothing is written — the thrown
    // CoderStreamError's chatId still names the stranded chat, and
    // agent.archive() retires it via agent.lastKnownChatId — see the
    // CoderStreamError notes below for what retrying means then.
    if (agent.chatId) await checkpoints.set(workflowId, agent.chatId);
  }
}
```

The shape matters:

- **One turn per step, `generate()` not `stream()`.** The checkpointed unit is
  a finished result — and a mid‑`stream()` failure surfaces on the stream,
  outside `generate()`'s error contract, which complicates step retry logic.
- **Persist the id, not the instance** (and never the token — read it from
  each step's environment).
- **Checkpoint in `finally`, not only on success**, so failed-but-alive chats
  stay reachable. What remains is the hard-crash window between chat creation
  and the checkpoint write (below).
- **No `await using` here.** The chat outlives the step; disposal archives it
  and archiving ends resumability (below).

### Resume in the next step — any process, any machine

```ts
// Step 1 — a queue job on machine A:
await runTurn("wf-1042", "Investigate the failing nightly build and propose a fix.");

// Step 2 — hours later, on machine B: same chat, full server-side history.
await runTurn("wf-1042", "Apply the fix you proposed and summarize what changed.");

// Final step — cleanup belongs to the workflow, not to each step (see below).
await archiveWorkflowChat("wf-1042");
```

What resuming does (and doesn't do):

- **Construction is free.** `new CoderAgent({ …, chatId })` performs no I/O
  and no validation — a bad or archived id fails the _turn_, not the
  constructor.
- **The first resumed turn seeds its cursor** from the chat's newest message
  (one single‑message history probe), so it streams only its own events —
  it never re‑absorbs earlier turns' content or usage.
- **Re‑supply process‑local configuration.** Client `tools` live in your
  process, not on the server, so each step that expects tool calls must pass
  them again. The workspace binding is the opposite: fixed at creation,
  carried by the chat, unchangeable on resume.
- **Sessions stay single‑flight across the whole system**, not just within one
  process: run steps strictly sequentially per chat. A second job posting to
  the same chat queues behind the live run and burns its own
  `requestTimeoutMs` waiting.

### Let the SDK absorb drops — and handle what it re‑throws

Self‑healed, invisible to the step (the run is **not** interrupted):

- **Transient stream drops.** The server keeps generating through the gap; the
  SDK redials with backoff and replays what it missed — committed messages
  past the turn's cursor plus the in‑progress message's deltas — deduplicating
  on receipt. A message that committed _while the connection was down_ arrives
  as exactly its missing tail. Drops cost latency, never content, and never
  duplicate content.
- **Client‑tool pauses ride one connection.** A multi‑segment turn keeps its
  stream across `requires_action` pauses, and a drop while your tool executes
  redials in the background.
- **A lost tool‑call event.** If a turn pauses for client tools but the pause's
  tool‑call event doesn't arrive within ~2 s, the SDK recovers the pending
  calls from committed history over REST and the turn continues.

Surfaced to the step once self‑healing is exhausted:

```ts
import { CoderApiError, CoderChatError, CoderStreamError } from "@coder/ai-sdk-agent";

try {
  await runTurn(workflowId, prompt);
} catch (err) {
  if (err instanceof CoderChatError && err.retryable) {
    // Timeout or transient turn failure. The run was interrupted (best-effort)
    // and the chat survives — but a re-run resubmits the prompt as a new user
    // turn: retry only steps designed to tolerate that (below).
  } else if (err instanceof CoderStreamError) {
    // Redial budget exhausted (~15s without forward progress). On a resumed
    // chat this is never auto-retried — the retry decision is yours (below).
  } else if (err instanceof CoderApiError) {
    // Branch on err.status: back off and retry 408/425/429/5xx; fail the workflow
    // on the rest (expired token, archived/deleted chat, …).
  }
  throw err;
}
```

- **`CoderChatError` with `retryable: true`** — the segment's
  `requestTimeoutMs` expired (`kind: "timeout"`) or the turn failed
  transiently (`kind: "stream_closed"`, an upstream 5xx). `retryable`
  classifies the _failure_ as transient — it does not make a re‑run free.
  Unlike the guarded `CoderStreamError` path below, the session is **not**
  discarded: the retried step reloads the checkpointed chat id (the `finally`
  checkpoint above is what makes this hold even when the _first_ step fails
  after creating its chat) and resubmits the same prompt as a new user turn,
  with the aborted attempt's partial output in history and any tool effects
  that ran before the failure not undone. The same idempotency judgment as
  below applies — retry steps designed to tolerate re‑submission; reconcile
  first when they aren't. And don't resubmit _immediately_: the expiry's
  server interrupt is asynchronous and best‑effort, so the timed‑out run may
  still be committing — run the same interrupt‑and‑wait‑for‑terminal‑status
  recovery as after a crash (below) before the retry, or its trailing output
  is absorbed into the retried turn. A timed‑out run can also have _finished_
  before that interrupt landed — but because the interrupt was already fired,
  the recovery's [result check](#recover-the-result-before-resubmitting)
  must treat the attempt as cut short (pin `cutShort` there) rather than
  trusting its own 409.
- **`CoderStreamError`** (an AI SDK `APICallError`) — the stream could not be
  re‑established. `isRetryable: true` only when the failed turn had just
  created its chat _and_ had no external effects a replay would repeat (no
  workspace, no MCP servers, no fresh inline uploads); the SDK then discards
  the dead session so a retry — `maxRetries` or a re‑run step — starts clean
  on a fresh chat. The discard happens for _every_ chat the failed turn
  itself created — **including the effectful, `isRetryable: false` case**:
  `agent.chatId` is `undefined` and the `finally` checkpoint writes nothing —
  but the stranded chat is not nameless: the error's **`chatId`** field names
  it, and `interrupt()`/`archive()` keep targeting it via
  `agent.lastKnownChatId` ([Cleanup](#cleanup)), so the step's error path can
  retire the orphan directly — or checkpoint `err.chatId` for the
  reconciliation sweep (below) when its workspace/MCP effects need
  reconciling first. A retried step then starts a fresh chat that has _not_
  seen the orphan's effects: gate that retry on the same idempotency judgment
  as any re‑submission. **On a resumed chat it is always `isRetryable: false`:**
  re‑running the step resubmits the same prompt as a _new user turn_, with the
  failed attempt's partial output still in history (usually fine — the model
  sees its own aborted attempt), and any workspace/MCP tool effects that ran
  before the drop are not undone. That judgment call belongs to your workflow,
  which is exactly why it isn't automatic.
- **`CoderApiError`** — an HTTP request failed; every non‑2xx wraps in this
  error, so branch on `status` before deciding. Rate limiting and transient
  server failures (408, 425, 429, 5xx) deserve backoff and a step retry (with
  the same re‑submission caveat as above). Auth failures and archived/deleted
  chats (401/403/404, the archived‑chat 400) hit the same wall on every
  attempt — fail the workflow.

### Recover after a crash

A hard crash (OOM kill, host loss) runs no `finally` blocks. Reason from the
checkpoint:

- **Crashed with an empty checkpoint** — usually nothing exists server‑side
  and the retried step just creates a fresh chat. But an empty checkpoint is
  not proof of nothing: a crash or `requestTimeoutMs` expiry while the create
  request was _in flight_ can leave a chat the server committed but whose id
  never arrived — unreachable even by the SDK's own interrupt. Treat "no
  checkpoint" as _up to one unacknowledged chat per attempt may exist_ — not
  as a clean slate, and automatic step retries can stack several. The
  reconciliation sweep below must therefore retire _every_ matching orphan
  (and its workspace/MCP effects, if the deployment auto‑attached any), not
  stop at the first.
- **Crashed after creation, before the checkpoint** — the chat is orphaned:
  its run keeps generating until it settles on its own — or, if the crash hit
  one of your client tools, never settles: it stays paused in
  `requires_action`, holding its workspace, invisible to the retried step
  (which has no id to interrupt). Either way the retried step starts a fresh
  chat, so orphans are found only by the reconciliation sweep from
  [Preventing stuck turns](#preventing-stuck-turns) — that sweep is not
  optional in this pattern, and it needs a **wider filter** here: the fleet
  sweep watches for _non‑terminal_ chats stuck past their budget, but an
  orphaned first turn may settle terminally on its own and then sit as a
  live, unarchived chat forever. Sweep every chat no checkpoint accounts
  for — regardless of status — and interrupt/archive it. (To shrink the window, checkpoint eagerly from the
  first `ws:dial` transport event — it carries the chat id as soon as the chat
  exists — but then the checkpoint's lifecycle is yours too: the retried step
  resumes a chat holding a dead half‑turn, and whenever a `CoderStreamError`
  killed a chat this step created — retryable or not: the SDK discards every
  such session, but only in memory — you must clear the eagerly checkpointed
  id yourself before any retry, or "starts fresh after a discard" silently
  turns into resuming the dead chat.)
- **Crashed after the checkpoint** — the chat is resumable, but don't just
  resubmit. The crashed attempt's run may still be live server‑side, and a
  resumed turn seeds its message cursor _before_ submitting — whatever the
  old run commits after that point would be absorbed into the resumed turn's
  output and usage. A crash _inside one of your client tools_ is worse: the
  chat is paused in `requires_action`, where new messages wait forever — and
  if the tool's external effect committed before the crash, that pause is the
  only pending record of it, so reconcile the tool ledger **before** any
  interrupt ([Make client tools crash-safe](#make-client-tools-crash-safe)).
  Both cases have one remedy — stop what the crash left behind and **wait
  until the chat actually settles** before deciding: a client‑tool pause is
  reconciled, never interrupted away; anything else is interrupted:
  `interrupt()` resolves on acknowledgment while the run keeps winding down
  (and committing) for a few more seconds, so poll the chat's status to a
  terminal one first. On a chat with no live run the interrupt rejects with a
  409 `CoderApiError`; that's the good case — ignore it:

  ```ts
  // Both shared with "Make client tools crash-safe" (below): the ledger
  // reconciliation resolves to its `unstarted` — true only when it fell back
  // to interrupting — and journals each action write-ahead, so a recovery
  // pass that dies mid-recovery is visible — and classifiable — to the next.
  declare function reconcileClientTools(): Promise<boolean>;
  // Journal entries are per-ATTEMPT, so the chat id alone cannot scope them:
  // a verdict from attempt N must not classify attempt N+1 (double crash),
  // and a later step's recovery on the same chat must not inherit this
  // one's. Every entry pins the step marker and an attempt count at write
  // time; a consult applies an entry only while both still match, so each
  // resubmission retires every earlier verdict by itself — there is no
  // clear step to forget.
  type JournalEntry = {
    // "submitting" is written ahead of every send on a checkpointed chat;
    // "resumed" / "cut-short" are the ledger reconcile's verdict (both in
    // the next sections).
    state: "submitting" | "resumed" | "cut-short";
    marker: string; // the step-scoped marker ("Recover the result…", below)
    attempt: number; // markerAttempts() at write time
    at: number; // write time — bounds the in-flight-send wait below
  };
  declare const journal: {
    get(chatId: string): Promise<JournalEntry | undefined>;
    set(chatId: string, entry: JournalEntry): Promise<void>;
  };
  // This step's attempts committed so far: user messages in the converted
  // transcript carrying the marker. Steps run sequentially, so they sit
  // contiguous at the tail of history — page newest-first (as the recovery
  // scan below already does) and stop at the first user message without it.
  declare function markerAttempts(): Promise<number>;

  // Bounded: a stalled deployment must fail the step, not hang it.
  const deadline = AbortSignal.timeout(15_000);
  // Whether an interrupt stopped a live run drives the resubmit decision
  // below: a 409 means there was nothing to stop.
  let cutShort = true;
  let { status } = await agent.client.getChat(agent.chatId!, deadline);
  // Recompute what the entry pinned at write time; a mismatch on either
  // means it classifies an earlier attempt (or another step's) — dead, skip.
  const entry = await journal.get(agent.chatId!);
  const attempts = await markerAttempts();
  const journaled = entry?.marker === marker && entry.attempt === attempts ? entry : undefined;
  if (status === "requires_action") {
    // The crash hit a client tool mid-execution: this pause is the only
    // pending record of its committed effects. Never interrupt it away —
    // reconcile the ledger instead (below): it submits recorded results
    // (reviving the run — nothing was cut short) or interrupts itself only
    // when nothing committed.
    cutShort = await reconcileClientTools();
  } else if (journaled && journaled.state !== "submitting") {
    // A previous recovery pass acted on this attempt, then died before the
    // step's result was recorded. Its journaled state is the verdict:
    // "resumed" — it revived the run by submitting recorded results;
    // interrupting now would cut down a run doing the step's work, and the
    // resubmitted prompt would mint NEW tool-call ids, sidestepping the
    // idempotency keys. Let it finish; nothing was cut short.
    // "cut-short" — it went on to interrupt (an unstarted sibling in the
    // batch); the attempt is truncated, so the check below must resubmit.
    cutShort = journaled.state === "cut-short";
    if (cutShort) {
      // The journal records write-ahead INTENT, not a landed interrupt: the
      // pass may have died in between, leaving the revived run working.
      // Re-drive the interrupt to make the intent true — a 409 means the
      // chat already settled; the cut-short verdict stands either way.
      await agent.interrupt({ signal: deadline }).catch((err) => {
        if (!(err instanceof CoderApiError && err.status === 409)) throw err;
      });
    }
  } else {
    await agent.interrupt({ signal: deadline }).catch((err) => {
      // A 409 proves nothing is stoppable NOW — that means "never cut short"
      // only if the probe saw no interrupt already in flight. A probed
      // "interrupting" is an earlier interrupt (a timeout's best-effort one,
      // a sweeper) already truncating the attempt; this 409 just says it
      // landed. Keep cutShort = true then.
      if (err instanceof CoderApiError && err.status === 409) cutShort = status === "interrupting";
      else throw err;
    });
  }
  // One thing can still be in flight here: the crashed attempt's own SEND. A
  // matching "submitting" entry — its attempt count has not grown — means the
  // process died with `createChatMessage` possibly en route, and the server
  // can commit it AFTER every read above (the 409 only said nothing was
  // running THEN). Sleep out what remains of the entry's commit window —
  // requestTimeoutMs past the write is the conservative horizon, and a
  // restart has usually consumed it already — so a late-landing turn starts
  // before the settle poll below and the next section's negative history
  // read is past the window. Then recount: a send that never landed OVER AN
  // EXISTING attempt pins cutShort — the step only ever plans a resubmission
  // over a cut-short, errored, or unsubmitted attempt, so the write-ahead
  // that superseded a "cut-short" verdict still carries its consequence, and
  // the scan below cannot mistake the old attempt's truncated tail for a
  // finished result.
  if (journaled?.state === "submitting") {
    await new Promise((r) => setTimeout(r, Math.max(0, journaled.at + 300_000 - Date.now())));
    if ((await markerAttempts()) === journaled.attempt && journaled.attempt > 0) cutShort = true;
  }
  // The 15 s interrupt bound must not cap what follows: a reconciled pause
  // revives a full model/tool continuation. Budget the settle poll — and the
  // history reads after it — on the turn scale, like the step itself.
  const settle = AbortSignal.timeout(600_000);
  do {
    ({ status } = await agent.client.getChat(agent.chatId!, settle));
    if (status === "waiting" || status === "completed" || status === "error") break;
    // With no accepted interrupt racing to clear it, requires_action is a
    // STABLE pause: a run resumed by submitted tool results called a NEW
    // client tool. Exit and reconcile the ledger again (below) instead of
    // polling out the deadline.
    if (status === "requires_action" && !cutShort) break;
    await new Promise((r) => setTimeout(r, 1_000)); // acknowledged ≠ settled — wait it out
  } while (true);
  ```

  Settled is necessary, not sufficient: a terminal status doesn't say whether
  the crashed attempt already _finished the step's work_ — check history
  before resubmitting
  ([Recover the result before resubmitting](#recover-the-result-before-resubmitting)).

### Make client tools crash-safe

Interrupting un‑strands a `requires_action` pause — but if the crashed
process died _between_ a non‑idempotent client tool committing its external
effect (a payment, a deploy, an email) and that result reaching the server,
the pause is the **only pending record of the execution**. Interrupt it away
and the resubmitted prompt is free to call the tool again — and duplicate the
effect. Close the window with a tool‑invocation ledger in the same durable
store as the `chatId` checkpoint, keyed by **chat id + `toolCallId`** — the
server assigns the call id and commits it to history, so both sides of the
reconciliation survive the crash. The chat id must be part of the key (and
of the idempotency key handed to the external system): call ids are only
unique _within_ a chat, and a store shared across workflows must never let
one chat's `done` entry answer — or deduplicate — another chat's call. In
multi‑tenant stores, fold the tenant in too:

```ts
import { tool } from "ai";
import { z } from "zod";
import { CoderAgent } from "@coder/ai-sdk-agent";

type LedgerEntry = { state: "committing" } | { state: "done"; output: string };
declare const ledger: {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
};
declare const payments: {
  charge(amountCents: number, opts: { idempotencyKey: string }): Promise<{ receiptId: string }>;
};

const ledgerKey = (chatId: string, toolCallId: string) => `${chatId}/${toolCallId}`;
const ChargeArgs = z.object({ amountCents: z.number().int() });

// A factory taking a getter, not an id: the chat may not exist until the
// turn creates it, so the id must be read lazily — it is set before any
// tool runs.
const chargeCard = (chatId: () => string) =>
  tool({
    description: "Charge the customer's card.",
    inputSchema: ChargeArgs, // shared with recovery's re-drive dispatch below
    execute: async ({ amountCents }, { toolCallId }) => {
      const key = ledgerKey(chatId(), toolCallId);
      // Write-ahead, BEFORE the effect: a crash between the two writes leaves
      // "committing" (ambiguous, but resolvable below); no entry at all proves
      // the effect never started.
      await ledger.set(key, { state: "committing" });
      // Hand the external system the SAME key as its idempotency key, so
      // re-driving this exact call can never double-charge.
      const { receiptId } = await payments.charge(amountCents, { idempotencyKey: key });
      await ledger.set(key, { state: "done", output: `charged: receipt ${receiptId}` });
      return `charged: receipt ${receiptId}`;
    },
  });

// Wire-up: a direct self-reference in the constructor call is circular for
// the type checker — defer it through a box assigned right after.
let self: { chatId?: string } | undefined;
const agent = new CoderAgent({
  /* …base options as in runTurn… */
  tools: { charge_card: chargeCard(() => self!.chatId!) },
});
self = agent;
```

On crash recovery, when the checkpointed chat is paused in `requires_action`,
reconcile _before_ any interrupt. The pending calls are in committed history —
the same derivation the SDK itself uses to recover a lost `action_required`
event — and the ledger holds the verdict on each:

```ts
// The step's configured ToolSet names: history does not record which calls
// were client tools (see [Rehydrating chat history]), so — like the SDK's
// own derivation — restrict to the names this step registers; a server/MCP
// call must never reach the ledger as "unstarted". (The recovery scan's
// final-text cut reuses this set — next section.)
const clientTools = new Set(["charge_card"]);

// Pending = the last assistant message's client (non-provider-executed,
// ToolSet-named) tool calls, minus ids answered by a later message's tool
// result.
const { messages } = await agent.client.getMessages(agent.chatId!, { limit: 200 }, deadline);
const ordered = [...messages].sort((a, b) => a.id - b.id);
const lastAssistant = ordered.findLast((m) => m.role === "assistant");
const handled = new Set(
  ordered
    .filter((m) => m.id > (lastAssistant?.id ?? 0))
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "tool-result")
    .map((p) => p.tool_call_id),
);
const pending = (lastAssistant?.content ?? []).filter(
  (p) =>
    p.type === "tool-call" &&
    !p.provider_executed &&
    clientTools.has(p.tool_name!) &&
    !handled.has(p.tool_call_id),
);

const results: { tool_call_id: string; output: unknown }[] = [];
let unstarted = false;
for (const call of pending) {
  const key = ledgerKey(agent.chatId!, call.tool_call_id!);
  const entry = await ledger.get(key);
  if (entry?.state === "done") {
    // Effect committed, result stranded: submit the record — the pause is
    // answered and nothing re-executes.
    results.push({ tool_call_id: call.tool_call_id!, output: entry.output });
  } else if (entry) {
    // "committing" is ambiguous — the crash hit between the write-ahead and
    // "done". Safe to re-drive: the SAME idempotency key makes a committed
    // effect replay as a no-op, and the call's args are committed in history.
    // Dispatch by tool name — every ledgered tool needs its own re-drive
    // path, its args validated exactly as the live loop would have.
    if (call.tool_name !== "charge_card")
      throw new Error(`no re-drive path for tool ${call.tool_name}`);
    const { amountCents } = ChargeArgs.parse(call.args);
    const { receiptId } = await payments.charge(amountCents, { idempotencyKey: key });
    const output = `charged: receipt ${receiptId}`;
    await ledger.set(key, { state: "done", output });
    results.push({ tool_call_id: call.tool_call_id!, output });
  } else {
    unstarted = true; // the tool never ran — interrupting loses nothing
  }
}
if (results.length > 0 || unstarted) {
  // ONE write-ahead with the batch's FINAL verdict, before any network
  // call — a mixed batch journals "cut-short" before even its submission,
  // so no crash point can leave a stale "resumed" masking the pending
  // interrupt. Every crash then either re-reconciles the stable pause or
  // re-drives the journaled intent. Scoped to THIS attempt: a resubmission
  // grows the marker count and retires the verdict on its own.
  await journal.set(agent.chatId!, {
    state: unstarted ? "cut-short" : "resumed",
    marker,
    attempt: await markerAttempts(),
    at: Date.now(),
  });
}
if (results.length > 0) await agent.client.submitToolResults(agent.chatId!, { results }, deadline);
if (unstarted) await agent.client.interruptChat(agent.chatId!, deadline);
// As `reconcileClientTools()` in the settle-wait snippet above: resolve to
// `unstarted` — cutShort is true only when this fell back to interrupting.
```

- **Only interrupt when the ledger shows no committed effect.** Submitted
  results are committed to chat history, so even when a mixed batch (one call
  done, a sibling never started) still ends in an interrupt, the effect's
  recorded outcome survives for the resubmitted turn to see.
- **Submitting answers the pause; it does not revive your tool loop.** Once
  every pending call is answered, the turn resumes **server‑side** with no
  process streaming it. That is why the settle‑wait's reconcile branch never
  interrupts a pause — nothing stranded is left to stop, and an interrupt
  now would cut down the very run the submission revived — and why the
  resolved `unstarted` leaves **`cutShort = false`** after a submission:
  nothing was cut short, and the next section's `!cutShort` check must
  classify the resumed run's finish as a completed attempt, not resubmit
  it. Give the poll a turn‑scale deadline rather than the 15 s interrupt
  bound; it exits on `requires_action` (stable here, with no accepted
  interrupt clearing it), which means the resumed run called a _new_ tool —
  reconcile again; a call with no ledger entry is safe to interrupt.
- **The finished run's output lands only in history** — recover it like any
  completed‑but‑unrecorded attempt (next section) instead of resubmitting.

### Recover the result before resubmitting

The settle‑wait resolves overlap with a still‑live run, but not the last
crash window: **the server finished the turn, and the process died before the
step's return value was recorded.** History now holds a perfectly good
result; a retried step that blindly resubmits runs the whole turn again —
duplicated output, repeated workspace/MCP/tool effects. This is the
at‑least‑once boundary every durable engine has around external effects, and
the chat itself is the record that narrows it to one honest window (below).
Make attempts matchable first — the server stores the prompt verbatim, so
embed a step‑scoped marker — and journal every send before it leaves the
process:

```ts
const marker = `[${workflowId}/step-2]`; // stable across this step's retries
// Write-ahead, BEFORE the send — first attempt and recovery resubmit alike.
// A crash before this write proves no send ever started; a crash after it
// leaves a dated entry whose commit window the settle-wait sleeps out. On a
// resubmission this write supersedes the "cut-short" verdict it acts on —
// safely: an unlanded send over an existing attempt makes the settle-wait
// pin cutShort right back. A first turn has no chat id to journal under: its
// send-crash window belongs to the empty-checkpoint sweep
// ("Recover after a crash").
if (agent.chatId) {
  await journal.set(agent.chatId, {
    state: "submitting",
    marker,
    attempt: await markerAttempts(),
    at: Date.now(),
  });
}
const { text } = await agent.generate({ prompt: `${marker} ${prompt}` });
```

Then, after the settle‑wait, three states are distinguishable — and only one
of them resubmits:

```ts
import { chatMessagesToUIMessages } from "@coder/ai-sdk-agent";

// A long turn can commit more than a page of messages after the prompt —
// page newest-first (the endpoint's default order) until the turn's user
// message is on hand; "never submitted" must never be concluded from a
// truncated read, or this recovery resubmits exactly the turn it was meant
// to deduplicate.
const fetched = [];
let page = await agent.client.getMessages(agent.chatId!, { limit: 200 }, settle);
fetched.push(...page.messages);
while (!fetched.some((m) => m.role === "user") && page.has_more) {
  const oldestId = Math.min(...fetched.map((m) => m.id));
  page = await agent.client.getMessages(agent.chatId!, { before_id: oldestId, limit: 200 }, settle);
  fetched.push(...page.messages);
}
const transcript = chatMessagesToUIMessages(fetched); // chronological
const lastUser = transcript.findLast((m) => m.role === "user");
const submitted = lastUser?.parts.some((p) => p.type === "text" && p.text.includes(marker));

if (submitted && !cutShort && (status === "waiting" || status === "completed")) {
  // The attempt finished; only the recording was lost. Recover what
  // `generate().text` would have returned — the FINAL step's text. Only a
  // CLIENT tool ends an AI SDK step, and narration lands on both sides of a
  // server-side call, so cut after the last part named in `clientTools`
  // (shared with the reconcile above) and join the text that follows.
  const parts = transcript
    .slice(transcript.indexOf(lastUser!) + 1)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts);
  return parts
    .slice(parts.findLastIndex((p) => p.type === "dynamic-tool" && clientTools.has(p.toolName)) + 1)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}
// Resubmit only what never finished: the prompt never reached the server
// (!submitted — sound only behind the write-ahead; see below), the turn
// failed (status "error" — normal retry judgment applies), or the interrupt
// cut a live run short (cutShort — the model sees its own aborted attempt in
// history and continues from it). One exit is neither: a requires_action
// settle goes back to ledger reconciliation (previous section) — never to
// recovery or resubmission.
```

- **`cutShort` is the completed/interrupted discriminator — but a 409 only
  proves nothing is running _now_.** An interrupted attempt leaves the same
  marker and a truncated answer in history, so history alone can't tell
  "finished" from "stopped"; what can is whether any interrupt stopped the
  run. The inference "409 ⇒ the attempt finished" is therefore sound only
  when recovery's interrupt is the _first_ one that could have: true after a
  hard crash, false after a `requestTimeoutMs` expiry — the expiry already
  fired the SDK's own best‑effort interrupt, which may have stopped the run
  before recovery ever looked. Carry the reason recovery ran: when it follows
  a known timeout or abort — or a matching journaled `"cut-short"`, or an
  unlanded `"submitting"` over an existing attempt (the settle‑wait already
  pins both) — pin `cutShort` to `true` and let only the hard‑crash path
  trust the 409.
- **`!submitted` races the crashed attempt's own send.** A crash kills the
  process, not necessarily its in‑flight `createChatMessage` — the server can
  commit that request _after_ an interrupt 409'd and a history read saw no
  marker, and a resubmit on that evidence queues the turn twice, duplicating
  its workspace/MCP/tool effects. The write‑ahead is what makes the negative
  read honest: no matching `"submitting"` entry proves no send ever started,
  and a matching one held recovery at the settle‑wait until the entry's
  commit horizon passed. That narrows the window; only server‑enforced
  submission idempotency could close it, and `POST /chats/{id}/messages`
  offers none today. A commit that outlasts even the horizon still lands
  under the same marker, so the duplicate is at least visible — in history,
  and to the next consult's attempt count.
- **The cut lands at the last _configured client‑tool_ boundary.** History
  does not mark which calls were client tools
  ([Rehydrating chat history](#rehydrating-chat-history)), so the cut
  classifies by name against the reconcile's `clientTools` set — narration
  before a trailing _server‑side_ call survives, matching what
  `generate().text` aggregates. What name‑matching cannot see: a call
  recorded under a name the step no longer configures (a tool renamed
  between deploys) reads as server‑side and leaks earlier‑step narration
  into the result, and a server tool sharing a configured name still cuts
  final‑step narration away.
- **Steps with structured results recover the call's input, not the text.**
  A [structured output](#structured-output) step's answer is the
  `structured_output` call's typed input, which rehydrates as a
  `dynamic-tool` part on the recovered turn
  ([Rehydrating chat history](#rehydrating-chat-history)) — and
  `structured_output` is one of the step's configured client tools, so the
  text join above cuts at it and returns only the ack prose that follows.
  Recover the filed call instead — this scan replaces the text join
  _inside_ the recovery branch above, reusing its `parts` — validated
  client‑side exactly like the live path (rule 2 there — the schema is the
  real gate):

  ```ts
  // Scan backward to the last call that VALIDATES, as in the live path — a
  // schema-invalid re-file must not shadow a valid answer.
  const filed = parts
    .filter((p) => p.type === "dynamic-tool")
    .filter((p) => p.toolName === "structured_output");
  let answer: z.infer<typeof Answer> | undefined;
  for (const call of filed.reverse()) {
    const parsed = Answer.safeParse(call.input);
    if (parsed.success) {
      answer = parsed.data;
      break;
    }
  }
  // recovered ⇔ answer !== undefined
  ```

### Watch turn health from inside the step

[Transport events](#observability) classify how each segment ended without
parsing errors or stream frames — emit them as step metrics/traces:

```ts
declare const metrics: {
  ok(segment: number, status: string, ms: number): void;
  fail(segment: number, error: string, detail: string): void;
  teardown(segment: number): void;
};

function observe(ev: CoderTransportEvent): void {
  if (ev.type === "ws:redial") {
    // Early warning: the stream dropped and is reconnecting. The server keeps
    // generating — nothing is lost yet; the turn fails if this hits the cap.
    console.warn(
      `redial ${ev.consecutiveFailures}/${ev.maxConsecutiveFailures}, next in ${ev.backoffMs}ms`,
    );
  } else if (ev.type === "segment:settle") {
    if (ev.finishReason) metrics.ok(ev.segment, ev.status!, ev.durationMs);
    else if (ev.error) metrics.fail(ev.segment, ev.error.name, ev.error.message);
    else metrics.teardown(ev.segment);
  }
}
```

`segment:settle` fires exactly once per `segment:start` and separates the
three endings a workflow cares about:

- **Clean settle** — `status` + `finishReason` present. `finishReason:
"tool-calls"` (status `requires_action`) is a healthy mid‑turn pause for
  your client tools; terminal statuses end the turn.
- **Failure** — `error: { name, message }` present (plus `status` when the
  server run itself still settled terminally): server‑side turn errors,
  transport failure after redials were exhausted, `requestTimeoutMs` expiry
  (`error.name: "CoderChatError"`), and caller aborts — which settle as
  failures carrying the abort reason's name, never as teardowns:
  `"TimeoutError"` for an `AbortSignal.timeout(…)` deadline (the running
  example), `"AbortError"` for an explicit abort.
- **Teardown** — neither: the stream consumer itself cancelled the turn
  (`stream()`'s `ReadableStream.cancel()` with no abort of its own) — rare in
  `generate()`‑shaped steps.

The hook is observability‑only — handler exceptions are swallowed and can't
disturb the turn, and an unset hook costs nothing. For monitoring _across_
steps (chats stuck before a watcher started, fleet‑level sweeps), see
[Preventing stuck turns](#preventing-stuck-turns).

### Bound every step

`requestTimeoutMs` arms **one timer per segment** covering everything the
segment does: the REST phase (chat creation, message/tool‑result submission,
uploads), the stream — and, the part that matters here, **any redial backoff
inside the segment**. A segment that spends 12 s reconnecting has 12 s less
budget; redials never reset the clock, so a flaky network can't stretch a step
past its bound. On expiry the call rejects with `CoderChatError`
(`kind: "timeout"`, `retryable: true`) and the server run is interrupted
best‑effort.

Two workflow‑specific notes:

- A turn that times out (or crashes) before its chat id arrived leaves nothing
  to _resume_ — the checkpoint stays empty and the retried step starts fresh —
  but possibly an unacknowledged chat to sweep (see
  [Recover after a crash](#recover-after-a-crash)).
- `requestTimeoutMs` bounds each _segment_; a turn driving client tools runs
  several. Cap a step's total wall‑clock with
  `abortSignal: AbortSignal.timeout(…)` —
  [Timeouts & cancellation](#timeouts--cancellation).

### Archive at the end — and only at the end

**An archived chat cannot be resumed:** the server rejects new messages on it
(400, `Cannot send messages to an archived chat`). The per‑request habits from
[Cleanup](#cleanup) — `await using`, `archive()` in a `finally` — would
destroy the session from inside an intermediate step, so here the _workflow_
owns the chat's end of life: archive once, in the final step, and in the
workflow's failure/compensation handler so abandoned runs don't accumulate
live chats.

```ts
export async function archiveWorkflowChat(workflowId: string): Promise<void> {
  const chatId = await checkpoints.get(workflowId);
  if (!chatId) return; // the workflow died before its first turn created a chat
  const agent = new CoderAgent({
    baseUrl: process.env.CODER_URL!,
    token: process.env.CODER_SESSION_TOKEN!,
    organizationId: process.env.CODER_ORG_ID!,
    chatId,
  });
  // A crashed step may have left a run live — stop it first, bounded. On an
  // already-settled chat the interrupt rejects with a 409; ignore it.
  await agent.interrupt({ signal: AbortSignal.timeout(15_000) }).catch(() => {});
  await agent.archive(); // retries 409s while the interrupted run winds down (~15s)
}
```

### Checklist

- One turn per durable step; `generate()`, not `stream()`.
- Persist `agent.chatId` (a string) — never the instance, never the token.
- Bound every step: `requestTimeoutMs` per segment, an abort deadline for
  total wall‑clock.
- Let redials self‑heal; own every retry decision — a re‑run step resubmits
  its prompt as a new user turn.
- Before resubmitting after a crash: reconcile the tool ledger before any
  interrupt, recover a finished attempt's result from history, and trust
  "never submitted" only past the journaled send's commit window.
- Keep concurrent steps' fan‑out within workspace quota —
  [Workspaces & quota](#workspaces--quota).
- Steps that don't need server‑side tools (plan / extract / synthesize) are
  cheaper and natively structured through
  [`@coder/ai-sdk-provider`](../provider) + `generateObject` — no chat, no
  workspace, no cleanup.
- Archive in the final step / failure handler — never per step.

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
