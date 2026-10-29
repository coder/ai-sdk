---
name: verify-coder-ai-sdk
description: Drive coder/ai-sdk's published API the way a user does, against a live Coder deployment (dogfood by default), and keep evidence. The primary surface is @coder/ai-sdk-agent (CoderAgent generate, stream, client tools, multi-turn sessions) through its runnable examples. @coder/ai-sdk-provider (AI Gateway generateText/streamText) is also mapped. Use to prove that a change works end to end, to reproduce a user report, or to check a deployment upgrade, after unit tests pass.
---

# Verify coder/ai-sdk against a live deployment

## What a user touches

The repository ships npm libraries, not a server. A user writes Node code against the public API, and that code talks to a Coder deployment.

- **Primary surface:** `@coder/ai-sdk-agent`. `new CoderAgent(...)` runs Coder Agents (chatd) as an AI SDK `Agent`. The runnable scripts in `packages/agent/examples/` call the public API exactly as user code does. They import `../src/index.js` instead of the npm package, so they test the source in this checkout.
- **Mapped secondary surface:** `@coder/ai-sdk-provider`, through `packages/provider/examples/`.
- **Not mapped yet:** `@coder/ai-sdk-effect` (`packages/effect/examples/`, needs `pnpm -r build` first), and `@coder/ai-sdk-sandbox` (`packages/sandbox/scripts/verify-*.ts`). The sandbox scripts create and delete Coder workspaces, which is slow and uses shared capacity, so map them only when a change needs them.

Everything below runs through one helper, `.agents/skills/verify-coder-ai-sdk/verify.sh`. Run it from anywhere in the repository. It puts Node and pnpm from `mise.toml` first on `PATH` itself.

## Launch

There is no process to keep alive. Launch prepares the checkout once:

```sh
.agents/skills/verify-coder-ai-sdk/verify.sh launch
```

It runs `mise install node pnpm`, `CI=true pnpm install --frozen-lockfile`, and `pnpm -r build`. It is ready when it prints `launch: ok`. A fresh clone reaches that state with no other step. The build is only for the effect package. The agent and provider examples run from source with `tsx`.

The examples need a deployment and a token in the environment:

- `CODER_URL`: the deployment, for example `https://dogfood.cdr.dev`.
- `CODER_SESSION_TOKEN`: a token for it. In a Coder workspace both are set already. Do not create or revoke tokens for a verification run.
- Optional: `CODER_ORG_ID` (otherwise the examples use your first organization), `CODER_MODEL` (agent model hint, default `haiku`), `CODER_TOOL_MODEL` (default `sonnet`), `VERIFY_PROVIDER_MODEL` (AI Gateway model id for the provider drive, default `claude-sonnet-4-6`), `VERIFY_TIMEOUT` (seconds per example, default 300).

## Doctor

Run this first, and again whenever a result looks wrong. It only reads.

```sh
.agents/skills/verify-coder-ai-sdk/verify.sh doctor
```

It prints one `PASS` or `FAIL` line per check and ends with `doctor: READY` or `doctor: NOT READY`. It checks:

- Node and pnpm match the pins in `mise.toml` and `package.json`.
- `curl`, `jq`, and `timeout` are on `PATH`, and the agent and provider dependencies are installed.
- The checkout commit, and whether `packages/` has local changes.
- The deployment answers `GET /api/v2/buildinfo`, and the line shows its version.
- The token is valid (`GET /api/v2/users/me`).
- Coder Agents is available to this user (`GET /api/v2/chats`).
- The agent model hints match an enabled chat model (`GET /api/v2/organizations/<org>/chats/models`).

Doctor does not call the AI Gateway, because every gateway call spends tokens. The `provider-generate-stream` drive is the gateway check.

## Drive

```sh
.agents/skills/verify-coder-ai-sdk/verify.sh features                  # list the mapped features
.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-stream        # one feature
.agents/skills/verify-coder-ai-sdk/verify.sh drive agent-generate agent-custom-tool
```

Each feature file in [`features/`](features/README.md) says what the drive does and what proves the feature. The drive:

1. Runs the feature's example scripts with `pnpm exec tsx`, under `timeout`.
2. Reads what the example printed: the answer, the finish reason, the tool calls, and the chat id.
3. Reads the same result a second way, from the deployment: `GET /api/v2/chats/<id>` and `GET /api/v2/chats/<id>/messages`. The proof compares the two views, for example the streamed text with the assistant text that chatd committed.
4. Prints one `PASS` or `FAIL` line per check, then `drive: PASS` or `drive: FAIL`. The exit code is 0 only on `PASS`.

All five features take about 30 seconds and a few cents of model tokens.

## Evidence

Each drive prints its run directory: `$VERIFY_OUT/<UTC time>-<pid>/`. `VERIFY_OUT` defaults to `$XUM_SCRATCH_DIR/verify-coder-ai-sdk`, then `$TMPDIR/verify-coder-ai-sdk`, then `/tmp/verify-coder-ai-sdk`. A Xum scratch directory is deleted with its workspace, so copy the run directory elsewhere when the proof must outlive the workspace.

- `run.txt`: the commit and whether `packages/` was clean or had local changes, the Node version, and the deployment URL and version.
- `<feature>/command.txt`: the exact commands, with the model variables that the drive set.
- `<feature>/<example>.stdout.txt`, `.clean.txt` (ANSI codes removed), `.stderr.txt`, `.exit-code.txt`.
- `<feature>/chat-ids.txt`, `chat-<id>.json`, `messages-<id>.json`: the deployment's view of each chat.
- `<feature>/committed-text.txt`, `streamed-text.txt`: the texts that a comparison used. Only the drives that compare text write them (`agent-generate`, `agent-stream`, `provider-generate-stream`).
- `<feature>/checks.txt`: the verdict lines.
- `<feature>/leaked-candidates.txt`: only when a chat may have leaked. See Cleanup.

Proof standards:

- Drive the public API through the examples. Do not call `CoderChatClient` or REST endpoints to make a feature happen. REST is only for the second view.
- A proof has the action (command and output) and the resulting state (the chat and messages from the deployment), not only the final printout.
- Check side effects: the chat exists, holds the expected messages and tool results, and is archived at the end.
- The examples use no mocks. Keep it that way.
- Report a feature that cannot run, with the command and the unmet precondition. Do not report it as verified through another feature.

## Cleanup

Each example archives the chats it created, in a `finally` block, and the drive checks that (`the example archived its chat`). Cleanup handles what is left after a crash or a timeout:

```sh
.agents/skills/verify-coder-ai-sdk/verify.sh cleanup <run-dir>
```

It reads every `chat-ids.txt` in the run directory and archives each chat that is still unarchived. It writes `cleanup.txt` and never deletes evidence.

When an example dies before it prints its chat id, the drive looks for unarchived chats created during the drive whose first user message is the example's prompt. It lists them in `leaked-candidates.txt` and prints a `WARN` line. Read them, then archive them with `cleanup <run-dir> --candidates`.

The deployment is shared. Cleanup touches only chats that this run recorded. Never archive chats found by listing all chats: they belong to you or to other runs. No drive creates workspaces, so there is nothing else to tear down. Several runs can go side by side, because each example creates its own chat.

## Gotchas

- **CAUTION: Call the AI Gateway only through the provider examples. Do not send your Coder token to other gateway routes by hand.** Doctor and the drives never do.
- `CODER_MODEL` means a chat model hint for the agent examples and a gateway model id for the provider examples. The helper sets the provider's own model, so a `CODER_MODEL=haiku` for the agent does not break the provider drive.
- Model output varies. When a check about the model's words fails (the rolled value, the recalled color), read `checks.txt` and the stdout before you call it a regression. Rerun once. A transport or tool failure does not depend on the model.
- `npx vitest` and bare `node` can run the system Node 22 instead of the pinned Node 26. Use the helper, which fixes `PATH`.
- A chat stuck in `requires_action` refuses an archive with HTTP 409. Submit an error result for its pending tool call first (`POST /api/v2/chats/<id>/tool-results`), then archive it.
- The examples test the source, not the packed npm tarball. CI's `pnpm publint` and `pnpm attw` cover packaging.

## Maintaining the map

`features/README.md` indexes the mapped features. When you add an example or a feature, add a feature file with the same four sections and a `drive_<feature>` function in `verify.sh`. To keep the map in step with the code, use `/maintain-verification-skill`.
