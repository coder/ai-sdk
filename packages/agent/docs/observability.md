# Observability: transport events

`onTransportEvent` receives typed transport events: HTTP exchanges, the per‑chat
stream's WebSocket lifecycle, and turn‑segment boundaries. Use it for timing and
tracing without wrapping `fetch`/`webSocketFactory` or re‑parsing stream frames.

Pass it on any of:

- `CoderAgentSettings` — reaches both the client and the model.
- `CoderChatClientOptions`
- `CoderLanguageModelConfig`

## Example: where did the turn spend its time?

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

## Event reference

`CoderTransportEvent` is a discriminated union on `type`. Every event carries
`timestamp`: `Date.now()` at observation. It is comparable to server‑side
timestamps such as a message's `created_at`, so you can measure delivery lag.

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

## Guarantees

- **Isolation** — exceptions thrown by the handler are swallowed. They can never
  alter transport behavior or a turn's outcome.
- **Zero overhead** — without a handler, no event objects are allocated and no
  extra socket listeners are registered.
- **No secrets** — events carry no headers and no tokens. Auth travels in the
  `Coder-Session-Token` header, which is deliberately excluded. `path`/`url`
  never contain credentials.

## Semantics

### HTTP operation names

- `op` is the public `CoderChatClient` method performing the exchange
  (`"createChat"`, `"createChatMessage"`, `"getMessages"`,
  `"submitToolResults"`, … — the `CoderClientOperation` union). Classify per
  operation without reverse‑engineering `path`.
- `method`/`path` stay for generic consumers.
- `archiveChat` stamps its own `op`, even though it issues the same `PATCH` as
  `updateChat`.
- WebSocket prefix‑selection preflights emit the existing `http:*` event kinds
  with `op: "streamEvents"` or `op: "watchChats"`. There are no new event kinds.

### Replay and `forwarded`

- `ws:event` fires at arrival. After a redial, chatd's replay of the
  in‑progress episode is visible here; correlate with `reader`/`attempt`.
- Each `ws:event` is stamped with the reader's own replay verdict:
  `forwarded: false` exactly on the duplicate deltas the reader suppresses from
  the turn. Subscribers never re‑derive the episode filter.
- `forwarded` does **not** reflect snapshot dedup. Repeated or revised
  `message` snapshots are always `forwarded: true`: reconciling them is
  deliberately the consumer's job past the transport layer. `TurnTranslator`'s
  per‑message ledger decides what a revision re‑emits, and that disposition is
  not stamped on transport frames.
- Use `ws:event` for span pairing and replay accounting. If you need content
  fidelity, consume model output (or `TurnTranslator`), not transport frames.

### Identifying a connection

Identify a connection as `(chatId, reader, attempt)`, never `(chatId, attempt)`
alone.

- `reader` is a monotonic id for the `streamChatEvents` call behind the
  connection. It comes from one process‑wide counter, so it stays unique across
  model and client instances. Every `ws:*` event carries it.
- `attempt` restarts at 1 per reader.
- Why it matters: a client‑tool pause the caller abandons is closed
  fire‑and‑forget when the next turn dials its replacement. The superseded
  reader's late `ws:close` (or a raced‑in frame) can emit after the new reader's
  `ws:dial`. The reader id tells them apart.
- `segment:settle` names the reader that served the segment. `segment:start`
  predates stream acquisition and carries none.

### Multi‑step turns

A multi‑step turn that drives client tools emits one
`segment:start`/`segment:settle` pair per round‑trip, all riding **one**
`ws:dial`ed connection: the stream is retained across `requires_action` pauses.

- A pause settles with `status: "requires_action"`, `finishReason: "tool-calls"`.
- The final settle carries the terminal status (`waiting`/`completed`/`error`).

### Coverage

- `ws:*` events cover the per‑chat `/stream` reader (turn transport). The
  `watchChats` subscription is not instrumented.
- With a pre‑built `client` in `CoderAgentSettings`, HTTP/WS events come from the
  hook given to **that client's** options. The agent‑level hook then only
  receives `segment:*` events.
