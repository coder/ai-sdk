# @coder/ai-sdk-agent

[![CI](https://github.com/coder/ai-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/coder/ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A **Vercel AI SDK agent backed by Coder Agents**, Coder's server‑side agent
runtime. `new CoderAgent(...)` implements the AI SDK's
[`Agent`](https://ai-sdk.dev/docs/reference/ai-sdk-core/agent) interface
(`generate()` / `stream()`): script it, stream from it, and attach your own tools
exactly like the SDK's own `ToolLoopAgent`.

Coder Agents runs the complete agent loop **server‑side**: the multi‑step tool
loop, built‑in tools, MCP, sub‑agents, multi‑provider model routing, and
automatic context compaction. This package bridges it to the AI SDK's
client‑side loop without re‑implementing the loop.

> Status: targets Coder's stable chat API (`/api/v2/chats`), available since
> Coder 2.37.0 (September 1, 2026). This package remains pre‑1.0.
> See [API compatibility](#api-compatibility) for older deployments.

**Contents**

| Get started                                             | Build                                                 | Reference                               | Run in production                                              |
| ------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| [Install](#install)                                     | [Custom tools](#custom-tools)                         | [Auth](#auth)                           | [Timeouts & cancellation](#timeouts--cancellation)             |
| [Quick start](#quick-start)                             | [Files](#files)                                       | [Configuration](#configuration)         | [Handling errors](#handling-errors)                            |
| [Examples](#examples)                                   | [Structured output](#structured-output)               | [API compatibility](#api-compatibility) | [Cleanup](#cleanup)                                            |
| [Agent vs. provider](#agent-vs-provider--which-package) | [Sessions](#sessions)                                 | [How it works](#how-it-works)           | [Usage & cost](#usage--cost)                                   |
|                                                         | [Rehydrating chat history](#rehydrating-chat-history) | [Testing](#testing)                     | [Observability](#observability)                                |
|                                                         | [Watching chats](#watching-chats)                     | [Limitations](#limitations)             | [Workspaces & quota](#workspaces--quota)                       |
|                                                         | [Workspace previews](#workspace-previews)             |                                         | [Durable workflows](#durable-workflows-persist-resume-recover) |
|                                                         | [Sources](#sources)                                   |                                         |                                                                |

## Agent vs. provider — which package?

|                   | `@coder/ai-sdk-agent` (this package)                                                                                                                | [`@coder/ai-sdk-provider`](../provider)                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| What runs         | Coder's server‑side agent: tool loop, built‑in tools, MCP servers, workspace‑scoped file/shell tools, sub‑agents, and compaction, on the deployment | Plain model calls through Coder's AI Gateway. A normal AI SDK provider: `generateText`, `streamText`, `generateObject` |
| Server state      | Each `CoderAgent` is one server chat ("session"), bound to at most one workspace                                                                    | No chat, no workspace; natively cancelable                                                                             |
| Structured output | Through a tool call ([Structured output](#structured-output))                                                                                       | `generateObject`, schema‑constrained                                                                                   |
| Reach for it when | You need **server‑side tools, MCP, or a workspace**                                                                                                 | You just need **a model** (plan / extract / summarize / classify)                                                      |

They compose: a multi‑step pipeline often uses the provider for its pure
text/JSON steps and the Agent only for the steps that touch tools.

## Install

```bash
pnpm add @coder/ai-sdk-agent ai@^7 zod
```

Requires Node ≥ 22 and `ai` v7. The constructors throw an actionable error when
another `ai` major is detected, instead of failing cryptically mid‑generation.
The guard fails open when the installed version can't be resolved.

## Quick start

```ts
import { CoderAgent } from "@coder/ai-sdk-agent";
import { tool } from "ai";
import { z } from "zod";

const agent = new CoderAgent({
  baseUrl: "https://dogfood.cdr.dev",
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

`generate()` returns a real AI SDK `GenerateTextResult`; `stream()` returns a
real `StreamTextResult` (`.textStream`, `.fullStream`, `.toUIMessageStream()`,
`.steps`, `.usage`, …). Because `CoderAgent` _is_ an `Agent`, it composes with
the rest of the AI SDK.

## Examples

Runnable scripts in [`examples/`](./examples) run against a real deployment via
`tsx`:

```bash
export CODER_URL=https://dogfood.cdr.dev
export CODER_SESSION_TOKEN=$(coder tokens create --name coderagent-example)

pnpm example:generate     # non-streaming generate()
pnpm example:stream       # streaming via textStream
pnpm example:tool         # custom (client-executed) tool round-trip
pnpm example:multi-turn   # multi-turn session memory
pnpm example:file         # attach a file to a chat (optional: pass a path)
pnpm example:structured   # typed structured output via the structured_output tool
```

Each example creates a new chat and archives it when done; none touches
workspaces. Details: [`examples/README.md`](./examples/README.md).

## Custom tools

Tools you pass are registered with Coder Agents as **client‑executed**
("dynamic") tools; your `execute` runs in your process. This is the standard AI
SDK tool loop:

1. The model calls your tool, and the run pauses on the server.
2. The AI SDK runs your tool's `execute`.
3. This package submits the result back, and the run resumes.

- Give tools an `execute` for scripting use; the loop runs to completion
  automatically.
- Coder's own server‑side tools (file editing, shell, MCP, …) still run on the
  server. They appear in the transcript as `providerExecuted` tool
  calls/results: you observe them, you don't execute them.

<details>
<summary>Since v0.2.1: server tools stream as <code>dynamic-tool</code> parts</summary>

Server‑executed tools stream with `dynamic: true`: they aren't in your `ToolSet`,
and the AI SDK only accepts unknown tool names on dynamic calls. In UI message
streams they therefore surface as `dynamic-tool` parts rather than `tool-{name}`
parts. Key off `toolName`, not `part.type`, when rendering them.

</details>

## Files

Pick by whether the model should **read** the file or **operate on** it.

**Chat attachments** carry content for the model to read (a PDF, image, CSV…).
Drop a native AI SDK `file` part into a message and it's uploaded transparently:

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

To upload once and reuse across turns, use `attach()`. It also accepts a
`Blob`/`File` or stream; `fs.openAsBlob` avoids reading the whole file into
memory:

```ts
import { openAsBlob } from "node:fs";

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

Attachments are capped at **10 MiB** and restricted to this media‑type
allowlist: `application/pdf`, `application/json`, `text/{plain,markdown,csv}`,
`image/{png,jpeg,gif,webp}`. Oversized or unsupported files throw a clear error
up front.

**Workspace files** are material for the agent to operate on: a zip of assets, a
dataset, a binary — anything outside the allowlist or over the cap. Write it onto
the workspace filesystem and let the agent's tools take over.

This needs a `workspaceFiles` adapter. The agent core stays dependency‑free, so
whoever holds a workspace connection supplies a few‑line adapter:

```ts
const agent = new CoderAgent({ /* … */ workspaceId: ws.id, workspaceFiles });
const { path } = await agent.uploadToWorkspace({
  content: await openAsBlob("assets.zip"),
  path: "assets.zip",
});
// Then ask the agent to `unzip assets.zip` — uploadToWorkspace writes bytes as-is; it does not unpack.
```

## Structured output

Coder Agents has no server‑side `response_format`, so `CoderAgent` cannot
constrain what the model **says** to a JSON schema. A `responseFormat` /
`experimental_output` request emits a warning and is best‑effort at most.

- **Pure text‑in / JSON‑out, no server‑side tools** → use
  [`@coder/ai-sdk-provider`](../provider) with `generateObject` /
  `Output.object` (schema‑constrained; requires AI Gateway on the deployment).
- **The answer must come out of an agent run** (server‑side tools, MCP, a
  workspace) → have the model submit its answer by _calling a tool_ whose
  `inputSchema` is your Zod schema. The answer arrives as the tool call's typed
  `input`.

The tool pattern needs four rules to stay robust (validate client‑side, never
stop on the call, and more). Guide: [docs/structured-output.md](./docs/structured-output.md).
Copyable helper: [`examples/06-structured-output.ts`](./examples/06-structured-output.ts).

## Sessions

One `CoderAgent` instance maps to one chat ("session") on the Coder server. The
chat is created on the first turn and reused by later `generate()`/`stream()`
calls, with history kept server‑side. `agent.chatId` is the current chat id.

| Call                                 | What it does                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.resetSession()`               | Start a fresh chat on the next turn. Reuse one instance for sequential turns; you don't need a new agent per turn.                                                                                                                              |
| `agent.interrupt({ signal? })`       | Interrupt an in‑flight generation.                                                                                                                                                                                                              |
| `agent.archive({ signal? })`         | Archive the underlying chat ([Cleanup](#cleanup)).                                                                                                                                                                                              |
| `agent.listModels()`                 | List the organization's model configs, so you don't have to guess the `model` hint.                                                                                                                                                             |
| `new CoderAgent({ …, chatId: "…" })` | Resume a prior chat. Optionally pass `lastSeenMessageId` (the persisted resume cursor, read from `agent.lastSeenMessageId`) to skip the resumed turn's pre‑prompt history probe. Full how‑to: [Durable workflows](./docs/durable-workflows.md). |

**One generation at a time.** A single instance is **single‑flight**: don't run
concurrent generations against it. For concurrency, use one instance per session
(and see [Workspaces & quota](./docs/workspaces-and-quota.md)).

**Interrupting is asynchronous on the server.** `interrupt()` resolves as soon
as the interrupt is acknowledged; the run keeps winding down for a few seconds
afterwards. The client‑level `client.interruptChat(chatId, { wait: true })`
sends `?wait=true` to ask the server to hold the response until the run has
stopped, but current Coder servers ignore the unknown parameter and still return
immediately. Confirm completion via the event stream (e.g.
[`watchChats`](#watching-chats)) instead.

## Rehydrating chat history

To render an existing chat in a UI (e.g. after a reload), fetch its messages with
a `CoderChatClient` (`agent.client`, or one you construct — see [Auth](#auth))
and convert them with `chatMessagesToUIMessages`. The result mirrors a
live‑streamed transcript of the same turn:

```ts
import { chatMessagesToUIMessages } from "@coder/ai-sdk-agent";

const { messages } = await client.getMessages(chatId);
const uiMessages = chatMessagesToUIMessages(messages);
// e.g. in React: useChat({ messages: uiMessages })
```

- **Any page order works.** The converter sorts by message id, so the endpoint's
  newest‑first default (and any pagination order) is safe to pass straight in.
  `useChat` always receives a chronological transcript.
- **Mapping.** Tool calls become `dynamic-tool` parts with their results folded
  in, and `source` parts become `source-url` parts. Unknown part kinds are skipped
  silently, so history written by newer Coder servers degrades gracefully.
- **Every tool call rehydrates as `dynamic-tool`.** History doesn't record which
  tool names were client (`ToolSet`) tools; live, client tools stream as
  statically typed `tool-{name}` parts. Render tools by name (ai's
  `isToolOrDynamicToolUIPart` and `getToolOrDynamicToolName`), not by exact
  `part.type`, and the difference disappears.
- **Files need a `fileUrl` resolver.** Persisted `file` parts carry only a
  `file_id` (no bytes, usually no URL). Download the bytes with
  `client.getChatFile(fileId)` and return a data:/object/proxy URL. Parts left
  without a URL are skipped:

```ts
chatMessagesToUIMessages(messages, {
  fileUrl: (part) => (part.file_id ? `/api/files/${part.file_id}` : undefined),
});
```

## Watching chats

`client.watchChats({ signal })` yields lifecycle events (status/title changes,
creation, deletion, …) for **every chat visible to the authenticated user**. It
is an async iterable backed by the `/api/v2/chats/watch` WebSocket:

```ts
for await (const event of client.watchChats({ signal })) {
  if (event.kind === "status_change") console.log(event.chat.id, event.chat.status);
}
```

- **Long‑lived.** After [prefix selection](#api-compatibility) (whose preflight
  errors propagate), dropped connections are redialed automatically with
  exponential backoff: 1s doubling to a 30s cap, reset once an event arrives.
- **Teardown.** Aborting the signal or ending iteration tears down the reader.
- **Terminal errors.** A 4xx upgrade rejection throws a terminal
  `CoderApiError`: a bad/expired token, or an older Coder server without the
  endpoint (404).

<details>
<summary>Custom plumbing: <code>watchChatEvents</code></summary>

For custom plumbing (own client, browser sockets), the standalone
`watchChatEvents({ baseUrl, token, signal, webSocketFactory })` export defaults
to the stable prefix without preflighting. Use `CoderChatClient` for automatic
prefix selection.

</details>

## Workspace previews

When the agent is bound to a workspace (the `workspaceId` setting), resolve — and
share — the browser URL where a workspace port is served, e.g. the dev server the
agent just started:

```ts
const { url } = await agent.getPreview({ port: 3000 });
// → https://3000--main--dev--alice.apps.example.com (private to the workspace owner)

const shared = await agent.sharePreview({ port: 3000, shareLevel: "authenticated" });
// shared.url is now reachable by any logged-in user; shared.shareLevel is the level in effect
```

| Method                                                 | What it does                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `getPreview({ port, agentName?, protocol?, signal? })` | Composes the subdomain URL. The URL honors the port's current share level: private to the workspace owner unless shared. |
| `sharePreview({ port, shareLevel?, … })`               | Additionally upserts the port's share level (re‑invoking updates it in place) and returns the level in effect.           |

- Ports below 1000 are rejected up front. Coder subdomain URLs only encode 4–5
  digit ports, so `80--agent--…` would be parsed as an app named "80" and never
  resolve; serve the preview on a higher port.
- `agentName` is optional when the workspace has exactly one agent. With
  several, the error lists the candidates.
- `protocol: "https"` means the app speaks TLS _inside the workspace_. It adds
  the `s` label suffix (`3000s--…`) and does not affect the browser scheme.
- `shareLevel` values:

  | `shareLevel`                | Reachable by                                                           |
  | --------------------------- | ---------------------------------------------------------------------- |
  | `"authenticated"` (default) | Any logged‑in user                                                     |
  | `"organization"`            | Members of the workspace's organization; requires a newer Coder server |
  | `"public"`                  | Anyone — no auth at all; mind what the port serves                     |

  Reverting to owner‑only means deleting the share; `"owner"` is not accepted on
  upsert.

**Credentials.** The preview helpers call non‑chat endpoints, so they need
`baseUrl` + `token`. Pass them alongside `client` if you construct one yourself
(or let them default from `CODER_URL`/`CODER_SESSION_TOKEN`).

<details>
<summary>Compatibility and failure cases (wildcard access URL, Coder &lt; v2.9)</summary>

Both helpers are built on the stable v2 workspace APIs (workspace lookup + the
wildcard apps host; `sharePreview` adds a port‑share upsert), so they work
against old Coder servers — no experimental endpoints.

They fail clearly instead of returning broken URLs:

- A deployment without a wildcard access URL (`--wildcard-access-url`) yields an
  explanatory error.
- A server that predates port sharing (< Coder v2.9) yields a 404
  `CoderApiError` saying so.

</details>

## Sources

Model configs with web search enabled emit `source` parts. They flow through to
`result.sources` and, in UI message streams, to `source-url` parts. Pass
`sendSources: true` to `toUIMessageStream`; the AI SDK omits them by default.
Earlier releases dropped them.

## Auth

Pass a Coder **API token** or **session token** as `token`. It is sent as the
`Coder-Session-Token` header (REST) and authenticates the streaming WebSocket.
Create one with `coder tokens create`, or reuse your CLI session.

`baseUrl`/`token` default from the `CODER_URL` and `CODER_SESSION_TOKEN`
environment variables, the same convention as `@coder/ai-sdk-sandbox`'s
transports. Explicit settings win over the environment:

```ts
const agent = new CoderAgent({ organizationId }); // uses CODER_URL + CODER_SESSION_TOKEN
```

You can also pass a pre‑built client:

```ts
import { CoderAgent, CoderChatClient } from "@coder/ai-sdk-agent";
const client = new CoderChatClient({ baseUrl, token });
const agent = new CoderAgent({ client, organizationId });
```

## Configuration

`CoderAgentSettings`:

| field                             | description                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `client` \| (`baseUrl` + `token`) | connection (one or the other; `baseUrl`/`token` default from `CODER_URL`/`CODER_SESSION_TOKEN`)                    |
| `organizationId`                  | org UUID that owns the chat (required)                                                                             |
| `model`                           | model hint: UUID, `provider:model`, model id, or display‑name substring                                            |
| `reasoningEffort`                 | reasoning effort for chat creation and every user-message submission (see below)                                   |
| `instructions`                    | system prompt                                                                                                      |
| `tools`                           | AI SDK `ToolSet` (client‑executed)                                                                                 |
| `workspaceId`                     | bind the chat to a Coder workspace (enables workspace‑scoped tools)                                                |
| `workspaceFiles`                  | adapter enabling `uploadToWorkspace()` (write files to the workspace FS)                                           |
| `mcpServerIds`                    | server‑side MCP servers to enable                                                                                  |
| `planMode`                        | enable plan mode (`"plan"`)                                                                                        |
| `stopWhen`                        | AI SDK stop condition(s); default `stepCountIs(64)`                                                                |
| `maxRetries`                      | default `0` — SDK retries can duplicate server‑side turns; override with care                                      |
| `requestTimeoutMs`                | per‑turn time budget (ms); interrupts the run and rejects (`kind: "timeout"`) instead of hanging                   |
| `onTransportEvent`                | observability hook for typed transport events (see [Observability](#observability))                                |
| `settleDeadlineMs`                | overall deadline for bounded cleanup (`archive()` 409 retries, disposal); default 15 000                           |
| `settleRetryDelayMs`              | pause between `archive()` retries while the chat settles; default 1000                                             |
| `chatId`                          | resume an existing chat                                                                                            |
| `lastSeenMessageId`               | resume cursor for `chatId` (persist `agent.lastSeenMessageId`) — skips the resumed turn's pre‑prompt history probe |

**Model hint resolution.** The `model` hint resolves against the organization's
model configs, first match wins:

1. a config UUID, used as‑is
2. an exact `provider:model` match
3. an exact model id
4. a display‑name substring (case‑insensitive)
5. a model‑id substring

An unresolvable hint falls back to the server's default model instead of
failing. Use `agent.listModels()` to see what's available.

<details>
<summary>Where model configs come from, and older deployments</summary>

- Configs come from
  `GET /api/v2/organizations/{organizationId}/chats/models`, with the provider
  type joined from the response's provider descriptors.
- On older deployments where the organization‑scoped route does not exist yet
  (404), resolution falls back once to the legacy deployment‑wide
  `/api/experimental/chats/model-configs` listing, independently of chat‑prefix
  selection.
- Partial payloads from older/newer servers are tolerated: entries match on the
  fields they carry.

</details>

### Reasoning effort

Set `reasoningEffort` on `CoderAgentSettings` (or `CoderLanguageModelConfig`
when using the model directly):

```ts
import { CoderAgent } from "@coder/ai-sdk-agent";

const agent = new CoderAgent({
  organizationId: "your-org-uuid",
  reasoningEffort: "low",
});
await agent.generate({ prompt: "Reply with exactly: pong" });
const chat = await agent.client.getChat(agent.chatId!);
console.log(chat.last_reasoning_effort); // string, null, or absent on the wire
await agent.archive();
```

- **Values.** The global scale is `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`. The exported `ReasoningEffort` type also accepts other strings
  for forward compatibility.
- **Per‑model options.** Model configs returned by `agent.listModels()` /
  `client.listModelConfigs(organizationId)` expose the optional
  `reasoning_efforts` list of selectable values for each model.
- **Independent of the `model` hint.**
- **No per‑call override.** Configure it on the agent/model instance.

<details>
<summary>When <code>reasoning_effort</code> is sent, and older servers</summary>

- It is sent as `reasoning_effort` on chat creation and every
  user‑message submission, including submissions to resumed or busy chats that
  queue the message. When unset, the request key is omitted entirely.
  Tool‑result submissions and WebSocket reconnects do not post user messages and
  do not send this field.
- Older Coder servers that do not recognize `reasoning_effort` ignore the
  unknown JSON field, so setting it is safe but has no effect there.

</details>

## API compatibility

Coder 2.37.0 promoted chat routes to `/api/v2/chats`
([server routes](https://github.com/coder/coder/pull/28496),
[Go SDK](https://github.com/coder/coder/pull/28497)). Coder 2.36.4 has no stable
chat mount. During the compatibility window (CODAGT-921) the promoted routes also
remain under `/api/experimental/chats`; legacy removal is tracked in CODAGT-922.

Each `CoderChatClient` selects its chat prefix from HTTP responses, not version
strings: v2 first, then the experimental prefix on a 404. The first non‑404 HTTP
response locks the prefix for the client's lifetime.

<details>
<summary>Prefix selection rules</summary>

- Until a prefix is selected, an actual REST request (including JSON requests
  and `Blob` uploads) tries v2 first and retries once under the experimental
  prefix only on 404.
- The first non‑404 HTTP response (including an error) locks that prefix for the
  client's lifetime. Concurrent unresolved calls may probe independently; the
  first conclusive response wins.
- Two 404s preserve the original v2 error without locking. Non‑HTTP failures do
  not lock either.
- A locked prefix is never renegotiated, even on 404.
- Before opening a per‑chat `/stream` or global `/watch` WebSocket, an
  unresolved client preflights with `GET /api/v2/chats`, using the same
  selection rules and cancellation signal.
- `ReadableStream` uploads also preflight, so their consumed bodies are never
  replayed.
- Legacy model‑config lookup remains independent of chat‑prefix selection (see
  [Configuration](#configuration)).

</details>

## Timeouts & cancellation

**Cancel a turn** by passing an `abortSignal` to `generate()`/`stream()`.
Aborting **interrupts the server‑side run**, not just the local socket, so the
chat stops generating and releases its resources instead of running on,
orphaned. Tearing down a `stream()` early (cancelling the stream) interrupts the
run too.

**Bound each segment** with `requestTimeoutMs`. If a segment runs longer (e.g.
the server is wedged, or a workspace can't be scheduled), the run is interrupted
and the call rejects with a retryable `CoderChatError` (`kind: "timeout"`)
instead of hanging:

```ts
const agent = new CoderAgent({ /* … */ requestTimeoutMs: 120_000 });
```

A segment is one model round‑trip, until it settles or pauses for a client tool.
A multi‑step `generate()` that drives client tools runs several segments, so
`requestTimeoutMs` bounds each one, not the whole call.

**Cap total wall‑clock** of a multi‑step call with a deadline signal instead:

```ts
await agent.generate({ prompt: "…", abortSignal: AbortSignal.timeout(120_000) });
```

**Stream drops heal themselves.** If the event stream drops mid‑turn, the agent
redials it automatically with exponential backoff, replays the turn's events from
its starting cursor, and deduplicates them on receipt. The server keeps
generating during the gap, so a transient drop costs nothing and the run is
**not** interrupted.

Only when the stream cannot be re‑established (several consecutive failed
attempts, ~15s) is the server run interrupted and the call rejected with a
`CoderStreamError`, an AI SDK `APICallError`:

| `isRetryable` | When                                                                                                                                                                                                                         | Then                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `true`        | The failed turn had just created its chat **and** had no external effects a replay would repeat: no `workspaceId`, no `mcpServerIds`, and no freshly uploaded inline attachments (pre‑uploaded `fileId` references are fine) | The dead session is discarded. `generate()` calls with `maxRetries` set retry the whole turn on a fresh chat automatically. |
| `false`       | Otherwise                                                                                                                                                                                                                    | Retrying is the caller's deliberate decision.                                                                               |

<details>
<summary>Why the other cases aren't retryable</summary>

On a chat with prior state (resumed sessions, later turns, tool‑result
segments), a re‑invocation would resubmit the same prompt as a new user turn.
Workspace/MCP tools may already have executed side effects, and inline
attachments would upload again.

</details>

- For `stream()`, a mid‑stream failure surfaces on the stream itself, outside
  the SDK's retry wrapper. Handle it in your consumption loop.
- A non‑transient 4xx upgrade rejection (bad/expired token, deleted chat) fails
  fast with a `CoderApiError` instead of retrying. 408/425/429 consume the redial
  budget like any other transient failure.

## Handling errors

All errors extend `CoderAgentError`, except `CoderStreamError`.

| Error              | Extends               | Thrown when                                                                       | Fields                                        |
| ------------------ | --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `CoderApiError`    | `CoderAgentError`     | An HTTP request failed                                                            | `status`, `method`, `path`, `detail`          |
| `CoderChatError`   | `CoderAgentError`     | A turn ended in an error, timed out, or lost its stream                           | `kind`, `retryable`, `statusCode`, `provider` |
| `CoderStreamError` | AI SDK `APICallError` | The event stream dropped and could not be re‑established within its redial budget | `isRetryable`, `cause`, `chatId`              |

`CoderStreamError` extends `APICallError` so `generate()`'s `maxRetries`
machinery recognizes it:

- `isRetryable` is `true` only when the failed turn created its chat and had no
  external effects to repeat (workspace/MCP tooling, fresh attachment uploads).
  Full rules: [Timeouts & cancellation](#timeouts--cancellation).
- `cause` holds the last transport failure.
- `chatId` names the chat the failed turn had created or attached to (absent
  when it failed before a chat existed). After the fresh‑chat discard the chat
  still exists server‑side, and `archive()` keeps targeting it via
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

**`maxRetries` defaults to `0`.** This agent owns server‑side chat state, so an
SDK‑level retry could duplicate a turn. Prefer catching `retryable` errors and
retrying the whole step deliberately.

## Cleanup

The agent is an **async disposable**, so cleanup can ride scope exit instead of a
`finally` you have to remember:

```ts
await using agent = new CoderAgent({/* … */});
const { text } = await agent.generate({ prompt: "…" });
// agent.interrupt() + agent.archive() run automatically when the scope exits.
```

- Disposal interrupts any in‑flight run, then archives.
- Disposal is **bounded and never throws** (~15s overall, best‑effort). Its
  errors are swallowed so they can't mask the scope's own error. Call
  `archive()` directly when you need guaranteed cleanup.
- In a request handler that returns before a fire‑and‑forget `archive()`
  settles, the archive can be abandoned. `await using` (or an awaited
  `archive()` in `finally`) avoids accumulating live chats.

**What `archive()` does:**

- It soft‑hides the chat: the chat stays in listings as `archived: true`. There
  is no hard delete yet.
- A freshly interrupted chat keeps winding down server‑side for a few seconds,
  and archiving 409s meanwhile. `archive()` retries those 409s (~1s apart, up to
  ~15s overall; tune with `settleDeadlineMs` / `settleRetryDelayMs`) and
  rethrows the last one if the chat never settles.
- Any other failure, including your own abort, rethrows immediately.

**Return values.** Both methods report what they acted on instead of silently
no‑oping:

| Method        | Acted on a chat                                                                                 | No chat exists at all    |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| `archive()`   | `{ archived: true, chatId, archivedChatIds }` (each archived id is cleared as a cleanup target) | `{ archived: false }`    |
| `interrupt()` | `{ interrupted: true, chatId }`                                                                 | `{ interrupted: false }` |

<details>
<summary>Which chat <code>archive()</code> and <code>interrupt()</code> target after a session is dropped</summary>

- They target the session's chat. After the session was dropped —
  `resetSession()`, or the automatic discard after a fresh‑chat stream failure
  (see [Handling errors](#handling-errors)) — they target the **last‑known chat
  id** (`agent.lastKnownChatId`), so a stranded chat is still cleaned up instead
  of leaking.
- Generation never uses the last‑known id: a turn after a drop creates a fresh
  chat as always.
- Every chat stranded by an _automatic_ discard is also recorded on a ledger,
  `agent.strandedChatIds` (oldest first). With `maxRetries`, several failed
  attempts can strand one chat each while only the final attempt's error
  surfaces. One `archive()` retires them all, oldest first, alongside its
  primary target.
- Deliberate abandonment is different: `resetSession()` does **not** add to the
  ledger (you may want that chat kept). After a manual reset, the old chat is
  targetable only until a new chat supersedes `lastKnownChatId`.

</details>

## Usage & cost

`result.usage` reflects what the whole turn actually consumed:

- A chatd turn runs several model steps server‑side (one per server tool round),
  each reporting its own usage. The SDK **sums every step**, and the AI SDK adds
  up the steps of a turn that paused for client tools.
- `inputTokens` is the full prompt size. Coder normalizes the wire
  `input_tokens` to the _uncached_ count (cache reads/writes are separate
  fields), so the SDK adds them back into the total and exposes the split via
  `inputTokenDetails` (`noCacheTokens`, `cacheReadTokens`, `cacheWriteTokens`).

**Cost and runtime.** When the server reports them, `total_cost_micros`
(micro‑USD) and `total_runtime_ms` are mirrored under each step's
`providerMetadata.coder`.

- `result.providerMetadata` reflects only the final step. Sum
  `result.steps[*].providerMetadata.coder` for whole‑turn cost when client tools
  ran.
- Both are absence‑tolerant mirrors: on servers that don't send them, nothing is
  emitted. Cost is otherwise only on the aggregate cost endpoints
  (`/api/v2/chats/cost/*`).

<details>
<summary>Raw wire usage per step (<code>steps[i].usage.raw</code>)</summary>

- The snake_case wire usage lives **per step** at `result.steps[i].usage.raw`.
  The AI SDK does not carry `raw` onto the summed `result.usage`.
- Use it for fields the normalized shape has no slot for: `context_limit`, cost,
  runtime, and any newer wire fields (which pass through newest‑value‑wins).
- `raw` keeps the wire convention (`input_tokens` = uncached only). Its counters
  are summed over that step's server‑side model steps, with `context_limit` from
  the newest one.
- So don't divide `raw`'s summed counters by `context_limit` to estimate context
  fullness. They are turn consumption, not a prompt‑size snapshot.

</details>

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

## Observability

Pass `onTransportEvent` to receive typed events for HTTP exchanges, the per‑chat
stream's WebSocket lifecycle, and turn‑segment boundaries. You get timing and
tracing without wrapping `fetch`/`webSocketFactory` or re‑parsing stream frames.

Handler exceptions are swallowed, there is zero overhead without a handler, and
events carry no headers or tokens. Example, event reference, and semantics:
[docs/observability.md](./docs/observability.md).

## Workspaces & quota

A chat may be backed by a **Coder workspace** that runs its tools, and
workspaces are the scarce resource: **N agents running concurrently can need N
schedulable workspaces**. Past that bound, a turn can sit unscheduled and never
settle. Read [docs/workspaces-and-quota.md](./docs/workspaces-and-quota.md)
before running fleets: how chats bind to workspaces, fleet sizing, autostop and
cleanup, preventing stuck turns, and troubleshooting.

## Durable workflows: persist, resume, recover

Run **one agent session across process boundaries** — queue jobs,
durable‑workflow steps (Vercel Workflow, step functions, Temporal, …), cron
ticks — and survive crashes, stream drops, and timeouts in between. All chat
state lives on the Coder server, so a workflow carries only `agent.chatId` (plus,
optionally, the `agent.lastSeenMessageId` resume cursor) between steps, and
each turn runs inside a durable step. Guide: [docs/durable-workflows.md](./docs/durable-workflows.md).

## How it works

```
CoderAgent  (implements ai.Agent)
  └─ ToolLoopAgent (ai)            ← inherits generate()/stream(), loop control
       └─ CoderLanguageModel       ← implements @ai-sdk/provider LanguageModelV4
            └─ CoderChatClient      ← REST + WebSocket to /api/v2/chats
                 └─ Coder Agents     ← runs the agent loop SERVER-side
```

One `doStream` call advances the chat until it **settles** (`waiting`/`completed`)
or **pauses** for a client tool (`requires_action`). The SDK loop and the
server‑side loop mesh at the client‑tool boundary, so there's no double loop.

<details>
<summary>How streamed text avoids double‑counting</summary>

Streaming text is emitted from `message_part` deltas. Every `message` snapshot is
then reconciled against a per‑message emitted‑content ledger, so nothing
double‑counts:

- a trailing snapshot after deltas is a no‑op;
- a fast snapshot‑only turn emits in full;
- a message that commits while the stream is redialing yields exactly its
  missing tail;
- a revision that appends to an earlier message yields the appended suffix;
- rewrites that can't be expressed as deltas are safely suppressed.

</details>

## Testing

```bash
pnpm test          # unit tests (hermetic, mocked client)
pnpm typecheck
pnpm lint          # lint with oxlint
pnpm format        # format with oxfmt (or `pnpm format:check` to verify only)
pnpm check         # format check + lint + typecheck (CI gate)
pnpm build
```

End‑to‑end tests run against a live Coder deployment and are opt‑in via env. The
suite creates **new chats only** (no workspaces) and archives them afterward:

```bash
CODER_URL=https://dogfood.cdr.dev \
CODER_SESSION_TOKEN=$(coder tokens create --name e2e) \
pnpm test:e2e
```

## Limitations

- Older deployments use a temporary experimental‑route fallback; it is not a
  guarantee that every chat feature is available (see
  [API compatibility](#api-compatibility)).
- Designed for Node (WebSocket via `ws`); a browser build can inject a
  `webSocketFactory`.
- A v7 `@ai-sdk/harness` adapter (the conceptually exact fit) is a future
  direction once that experimental API stabilizes.

## License

Apache-2.0
