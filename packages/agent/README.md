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
is no hard delete yet). A freshly interrupted chat keeps winding down server‑side
for a few seconds, during which archiving 409s — `archive()` retries those 409s
(~1s apart, up to ~15s overall; tune with `settleDeadlineMs` /
`settleRetryDelayMs`) and rethrows the last one if the chat never settles. Any
other failure, including your own abort, rethrows immediately.

To make cleanup ride scope exit instead of a `finally` you have to remember, the
agent is an **async disposable**:

```ts
await using agent = new CoderAgent({
  /* … */
});
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

## Usage & cost

Results carry normalized token usage in `usage`, plus the verbatim snake_case
wire usage in `usage.raw` for fields the normalized shape has no slot for
(`context_limit`, cost, runtime, …). When the server reports them,
`total_cost_micros` (micro‑USD) and `total_runtime_ms` are also mirrored under
`providerMetadata.coder` on finish. Both are **absence‑tolerant mirrors**:
today's Coder servers only expose cost on the aggregate cost endpoints
(`/api/experimental/chats/cost/*`), so expect these fields to be absent —
nothing is emitted when the server sends neither.

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
