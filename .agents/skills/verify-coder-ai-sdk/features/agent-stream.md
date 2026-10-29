# Stream a reply

`agent.stream({ prompt })` returns at once, and `result.textStream` yields the reply as chatd streams it. Every character of the reply arrives once: the stream reader and `TurnTranslator` remove the duplicates that chatd replays after a reconnect. At the end, the streamed text equals the text that chatd committed.

## Sub-features

- `stream-deltas` yields text deltas before the turn settles.
- `stream-exactly-once` delivers the committed text exactly once, with nothing missing and nothing repeated.
- `stream-settle` ends with finish reason `stop`.
- `stream-archive` archives the chat when the caller calls `agent.archive()`.

## How to get to it (user POV)

- Iterate `for await (const delta of (await agent.stream({ prompt })).textStream)`.
- Run `pnpm example:stream` in `packages/agent` (the same code as `examples/02-stream.ts`).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` prints `doctor: READY`.

- **Stream.** Ask for the three-sentence sunrise in `examples/02-stream.ts`. Run `.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-stream`. `PASS textStream produced text` and `PASS finish reason is stop` appear. `streamed-text.txt` holds the text that the example printed from `textStream`.
- **Exactly once.** The drive joins the chat's committed assistant text from `GET /api/v2/chats/<id>/messages` into `committed-text.txt`. `PASS streamed text equals the committed text, exactly once` appears.
- **Cleanup.** `PASS the example created 1 chat(s) (created 1)` and `PASS the example archived every chat it created` appear.
- **Proof.** Keep `streamed-text.txt`, `committed-text.txt`, `messages-<id>.json`, and `checks.txt`.

## Gotchas

- The comparison is byte-exact. The drive cuts only the example's framing (one blank line before the deltas, one after), so a missing or repeated newline in the reply fails the check.
- One live run takes one network path and rarely includes a reconnect. For drops, redials, and replays, run the `verify-agent-stream-exactly-once` skill: it checks every order of those events within its bounds.
- A known gap: when chatd retries a failed generation attempt in the middle of a stream, the abandoned attempt's deltas stay in `textStream` (see `verify-agent-stream-exactly-once`, finding `restart-keeps-abandoned-deltas`, issue #407). A live run hits it only when the provider fails in the middle of the reply. The drive cannot see that retry, so rerun once. A failure that repeats is not this gap.
