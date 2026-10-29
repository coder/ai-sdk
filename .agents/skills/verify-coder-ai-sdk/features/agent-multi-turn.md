# Keep a multi-turn session

One `CoderAgent` is one session. The first `generate()` creates a chat, and each later `generate()` adds a turn to the same chat, so the model sees the earlier turns from chatd's server-side history. The caller does not resend the history.

## Sub-features

- `session-reuse` sends turn 2 to the chat that turn 1 created.
- `session-memory` lets the model use what turn 1 said.
- `session-history` stores both user turns in that one chat.
- `session-archive` archives the chat once, at the end.

## How to get to it (user POV)

- Call `agent.generate()` twice on the same `CoderAgent` instance.
- Run `pnpm example:multi-turn` in `packages/agent` (the same code as `examples/04-multi-turn.ts`).

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` prints `doctor: READY`.

- **Turn 1.** Tell the agent that your favorite color is teal. **Turn 2.** Ask for your favorite color. Run `.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-multi-turn`. `PASS both turns used one chat` appears: both `chat:` lines in the stdout show the same id.
- **Memory.** `PASS turn 2 recalls the color from turn 1` appears. The `Turn 2:` line contains `teal`.
- **Second view.** The drive reads `GET /api/v2/chats/<id>/messages`. `PASS chatd stored both user turns in that chat` appears.
- **Cleanup.** `PASS the example archived its chat` appears.
- **Proof.** Keep `04-multi-turn.clean.txt`, `messages-<id>.json`, and `checks.txt`.

## Gotchas

- The drive does not compare per-turn usage. When a change touches the turn cursor (`lastSeenMessageId`), also read the two `Turn` lines: turn 2's answer must not repeat turn 1's `ok`.
- The recall check matches the word `teal` and depends on the model. Rerun once before you call a failure a regression.
