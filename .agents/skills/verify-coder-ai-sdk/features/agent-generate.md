# Generate a reply

`agent.generate({ prompt })` sends one prompt to Coder Agents, waits for the turn to settle, and returns the reply text, the finish reason, the steps, and the token usage. The chat that it created stays on the deployment until `agent.archive()` archives it.

## Sub-features

- `generate-text` returns the assistant's reply as `result.text`.
- `generate-settle` ends the turn with finish reason `stop` and one step.
- `generate-usage` reports usage from chatd's committed messages.
- `generate-archive` archives the chat when the caller calls `agent.archive()`.

## How to get to it (user POV)

- Call `await agent.generate({ prompt })` on a `new CoderAgent({ baseUrl, token, organizationId, model })`.
- Run `pnpm example:generate` in `packages/agent` (the same code as `examples/01-generate.ts`).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` prints `doctor: READY`, including `agent model hint "haiku"` (or your `CODER_MODEL`).

- **Generate.** Ask the one-sentence question in `examples/01-generate.ts`. Run `.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-generate`. The lines `PASS example exits 0`, `PASS generate() returned text`, and `PASS finish reason is stop` appear.
- **Second view.** The drive reads the chat's messages from `GET /api/v2/chats/<id>/messages`. `PASS result.text equals the assistant text that chatd committed` appears: `answer-text.txt` and `committed-text.txt` are byte for byte equal.
- **Usage.** `PASS result.usage equals the usage that chatd committed` appears: the printed `outputTokens` equals the sum of the assistant messages' `output_tokens`, and `inputTokens` equals the sum of their input, cache read, and cache write tokens.
- **Cleanup.** The drive reads `GET /api/v2/chats/<id>`. `PASS the example created 1 chat(s) (created 1)` and `PASS the example archived every chat it created` appear, and `chat-<id>.json` has `"archived": true`.
- **Proof.** Keep `agent-generate/01-generate.clean.txt`, `answer-text.txt`, `committed-text.txt`, `messages-<id>.json`, `chat-<id>.json`, and `checks.txt` from the run directory.

## Gotchas

- `Usage` counts cache writes in `inputTokens`. On the first turn of a chat, `inputTokens` can be thousands while `raw.input_tokens` is near zero. That is expected.
- The messages endpoint returns newest first. The drive sorts by id before it joins the assistant text.
- The chat's title is the prompt at first, but chatd can rename it later. Do not use the title as proof.
