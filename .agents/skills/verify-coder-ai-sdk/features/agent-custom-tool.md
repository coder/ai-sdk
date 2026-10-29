# Run a client tool

A tool that the caller passes to `new CoderAgent({ tools })` runs in the caller's process. chatd pauses the turn at `requires_action`, the AI SDK runs the tool's `execute`, the agent submits the result, and the turn resumes to the final answer. The tool runs exactly once, and chatd stores its result in the chat.

## Sub-features

- `tool-call` sends the tool's schema to chatd, and the model calls the tool.
- `tool-once` runs the local `execute` exactly once per call.
- `tool-result` submits the result, and chatd stores it as a `tool-result` part.
- `tool-resume` resumes the turn, and the final answer uses the result.

## How to get to it (user POV)

- Pass `tools: { rollDice: tool({ inputSchema, execute }) }` to `new CoderAgent(...)` and call `agent.generate({ prompt })`.
- Run `pnpm example:tool` in `packages/agent` (the same code as `examples/03-custom-tool.ts`).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` prints `agent model hint "sonnet" matches an enabled chat model` (or your `CODER_TOOL_MODEL`).

- **Call the tool.** Ask the agent to roll a 20-sided die. Run `.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-custom-tool`. `PASS the local tool ran exactly once (ran 1 times)` and `PASS result.steps records the rollDice call` appear. The stdout has one `[local tool] rollDice({ sides: 20 }) -> N` line.
- **Use the result.** `PASS the answer reports the rolled value N` appears.
- **Second view.** The drive reads `GET /api/v2/chats/<id>/messages`. `PASS chatd stored one rollDice tool call` and `PASS chatd stored one rollDice tool result with value N` appear. `messages-<id>.json` has one `tool-call` part and one `tool-result` part named `rollDice`.
- **Cleanup.** `PASS the example created 1 chat(s) (created 1)` and `PASS the example archived every chat it created` appear.
- **Proof.** Keep `03-custom-tool.clean.txt`, `messages-<id>.json`, and `checks.txt`.

## Gotchas

- A weak model can answer without the tool. Then `ran 0 times` appears and the answer has no value. Use the default `sonnet` tool model before you call it a regression.
- `ran 2 times` is a real bug: the tool ran twice for one call, for example after a replayed `action_required`.
- A chat that fails between the pause and the resume stays in `requires_action` and refuses an archive (HTTP 409). Submit an error result for the pending call (`POST /api/v2/chats/<id>/tool-results`), then run `verify.sh cleanup <run-dir>`.
