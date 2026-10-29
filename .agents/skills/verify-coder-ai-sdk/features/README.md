# coder/ai-sdk verification map

This directory is the maintained source for verifying the user-facing behavior of coder/ai-sdk against a live Coder deployment. Read this index before you drive anything, then use the matching feature file as the recipe.

## Baseline preconditions

- `verify.sh launch` has run in this checkout and printed `launch: ok`.
- `CODER_URL` and `CODER_SESSION_TOKEN` name a deployment with Coder Agents and AI Gateway enabled. Dogfood (`https://dogfood.cdr.dev`) has both.
- `verify.sh doctor` prints `doctor: READY`.
- Never drive or archive a chat that this run did not create.

## Driving conventions

- Every drive goes through `.agents/skills/verify-coder-ai-sdk/verify.sh drive <feature>`, which runs the feature's example scripts unchanged.
- Each example creates its own chat, so features do not depend on each other and need no seed data.
- Treat every command as literal. Keep the feature names and file paths unchanged.
- The examples archive their chats. Run `verify.sh cleanup <run-dir>` after any failed or timed-out drive.

## Proof and skip reporting

- A proof has the command, stdout, stderr, and exit code of each example, plus the deployment's second view of each chat (`chat-<id>.json`, `messages-<id>.json`).
- A proof compares what the API returned with what the deployment stored. A printout alone is not proof.
- Record the feature name and the run directory with every claim.
- Report a drive that cannot run with the attempted command and the unmet precondition.
- Do not report a skipped feature as verified through a different feature.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph about the user-visible behavior. It then has exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify.sh` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Generate a reply](./agent-generate.md) covers `agent.generate()`: text, finish reason, usage, and chat cleanup.
- [Stream a reply](./agent-stream.md) covers `agent.stream()` and checks that the streamed text equals the committed text exactly once.
- [Run a client tool](./agent-custom-tool.md) covers a custom tool that runs in the caller's process, exactly once, with its result stored by chatd.
- [Keep a multi-turn session](./agent-multi-turn.md) covers two `generate()` calls on one agent that share one chat and its history.
- [Call a model through AI Gateway](./provider-generate-stream.md) covers `@coder/ai-sdk-provider` with `generateText()` and `streamText()`.

Not mapped yet: file upload (`packages/agent/examples/05-file-upload.ts`), structured output (`06-structured-output.ts`), the Effect bridge (`packages/effect/examples/`), and sandbox workspaces (`packages/sandbox/scripts/`).
