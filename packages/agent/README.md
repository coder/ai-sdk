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
- Resume a prior chat: `new CoderAgent({ …, chatId: "…" })`.

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
    console.log(`${ev.method} ${ev.path} → ${ev.status} in ${ev.durationMs.toFixed(0)}ms`);
  if (ev.type === "ws:event" && ev.event.type === "action_required")
    console.log(`tool calls arrived at +${ev.timestamp - events[0]!.timestamp}ms`);
  if (ev.type === "segment:settle")
    console.log(`segment ${ev.segment}: ${ev.status} in ${ev.durationMs.toFixed(0)}ms`);
}
```

`CoderTransportEvent` is a discriminated union on `type`. Every event carries
`timestamp` (`Date.now()` at observation — comparable to server‑side timestamps
such as a message's `created_at`, for delivery‑lag measurements):

| event            | when                                                | payload (besides `timestamp`)                                                                                                                                                           |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http:request`   | a REST request is sent                              | `id` (correlates the pair), `method`, `path`                                                                                                                                            |
| `http:response`  | response headers arrive (incl. non‑2xx, `ok:false`) | `id`, `method`, `path`, `status`, `ok`, `durationMs`                                                                                                                                    |
| `http:error`     | the fetch itself rejects (network failure, abort)   | `id`, `method`, `path`, `message`, `durationMs`                                                                                                                                         |
| `ws:dial`        | a stream connection attempt starts                  | `chatId`, `attempt` (1‑based, increments per redial), `url`                                                                                                                             |
| `ws:open`        | the WebSocket handshake completes                   | `chatId`, `attempt`                                                                                                                                                                     |
| `ws:event`       | a decoded stream event arrives                      | `chatId`, `attempt`, `event` (the decoded `ChatStreamEvent`, by reference — don't mutate)                                                                                               |
| `ws:close`       | the connection ends (exactly one per dial)          | `chatId`, `attempt`, `code`/`reason` when the server/network closed it; absent when the reader closed it (settle, teardown, redial)                                                     |
| `ws:error`       | a socket error or unparseable frame                 | `chatId`, `attempt`, `message`                                                                                                                                                          |
| `ws:redial`      | a dropped connection is about to be redialed        | `chatId`, `attempt` (the ended connection), `consecutiveFailures`, `maxConsecutiveFailures`, `backoffMs`                                                                                |
| `segment:start`  | a turn segment (one model round‑trip) starts        | `segment` (1‑based per model instance), `chatId` (absent before the first turn creates the chat)                                                                                        |
| `segment:settle` | the segment ends (exactly one per start)            | `segment`, `chatId`, and: `status` + `finishReason` on a clean settle, `error` (`{name, message}`, plus `status` if the run still settled terminally) on failure, neither on a teardown |

Semantics worth knowing:

- **Isolation** — exceptions thrown by the handler are swallowed; they can never
  alter transport behavior or a turn's outcome.
- **Zero overhead** — without a handler, no event objects are allocated and no
  extra socket listeners are registered.
- **No secrets** — events carry no headers and no tokens (auth travels in the
  `Coder-Session-Token` header, which is deliberately excluded); `path`/`url`
  never contain credentials.
- `ws:event` fires at arrival, **before** replay dedup: after a redial, chatd's
  replay of the in‑progress episode is visible here (correlate with `attempt`)
  even though the reader suppresses the duplicates it forwards to the turn.
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
  outside the retry wrapper. The last transport failure is in `cause`.

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
credentials — pass them alongside `client` if you construct one yourself.

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
  chat only; the workspace keeps running — and consuming quota — until template
  autostop or an explicit stop.

### Sizing a fleet

The structural rule: **concurrent workspace‑backed chats ≤ schedulable
workspaces.** What counts as "schedulable" is a deployment property, not an SDK
knob — whichever of these binds first:

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
  cheap.
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
   On expiry the run is interrupted server‑side (releasing the chat) and the
   call rejects with a `CoderChatError` (`kind: "timeout"`, `retryable: true`)
   instead of pinning a fleet slot ([Timeouts](#timeouts--cancellation)).
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

### Troubleshooting: unschedulable & stuck chats

Wire [`onTransportEvent`](#observability) into fleet telemetry — the event
sequence pinpoints _where_ a turn died:

| symptom (transport events)                                                                                                                                                                          | likely cause                                                                                                                                                                                                                                                                                                 | fix                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment:start` and `ws:open` fired, initial status events, then silence — no `message_part`, no `segment:settle`                                                                                   | if the chat's status is `pending` (or its workspace build is `pending`/`failed`): the workspace can't be scheduled — quota exhausted, no free provisioner, failing template. If the status is `running` with a healthy build, it may just be a slow model/tool step — silence alone doesn't prove scheduling | check quota headroom (`workspace-quota` endpoint) and the workspace's build — a quota failure logs `INSUFFICIENT_QUOTA`; reclaim enough _credits_ for the planned build (stopping helps only for stop‑scoped costs — delete workspaces to reclaim persistent costs, or raise the group allowance) and set `requestTimeoutMs` so this fails loudly next time |
| `segment:settle` carries `error: { name: "CoderChatError", message: "…requestTimeoutMs budget…" }`                                                                                                  | the per‑segment bound expired — wedged server, slow model, or an unschedulable workspace                                                                                                                                                                                                                     | inspect the workspace via the v2 API/UI: a `pending`/`failed` build means the row above; `running` means the turn was genuinely slow — raise `requestTimeoutMs` for long tool work                                                                                                                                                                          |
| repeated `ws:redial` with `consecutiveFailures` climbing toward `maxConsecutiveFailures` (5; backoff 1 s → 2 s → 4 s → 8 s, ≈15 s of redialing without forward progress), then a `CoderStreamError` | the network path to the deployment is failing — not workspace scheduling (the server keeps generating through short gaps)                                                                                                                                                                                    | fix connectivity; mind retry ownership above — on workspace‑backed chats the error is `isRetryable: false`, so the replay decision is yours                                                                                                                                                                                                                 |
| `segment:settle` with `status: "error"` and an `error` payload                                                                                                                                      | the turn failed server‑side — a provider/model error, a tool failure, or a scheduling/build failure that terminated the turn instead of leaving it pending                                                                                                                                                   | the settle event's `error` carries only `{ name, message }` — branch on `kind` / `retryable` / `statusCode` by catching the thrown `CoderChatError` at the `generate()`/`stream()` call site ([Handling errors](#handling-errors)), and check the workspace build state to rule scheduling in or out                                                        |
| turn settled `status: "requires_action"`, follow‑up messages queue forever                                                                                                                          | the loop ended on an unanswered client tool call                                                                                                                                                                                                                                                             | submit the stranded results or interrupt — see rule 4 under [Structured output](#structured-output)                                                                                                                                                                                                                                                         |
| `archive()` keeps returning 409 and rethrows after ~15 s                                                                                                                                            | the chat never settled server‑side — usually a stuck run still holding its workspace                                                                                                                                                                                                                         | `interrupt()` with a bounded signal, then re‑archive; if the run stays wedged, stop the workspace itself                                                                                                                                                                                                                                                    |

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
