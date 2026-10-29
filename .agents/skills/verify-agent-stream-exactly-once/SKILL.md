---
name: verify-agent-stream-exactly-once
description: Bounded exhaustive check that @coder/ai-sdk-agent delivers a turn's streamed text, reasoning, and usage to the AI SDK exactly once when the chatd stream drops, redials, replays, or revises messages. Use before you merge a change to the stream reader (packages/agent/src/coder/ws.ts streamChatEvents), TurnTranslator (packages/agent/src/model/translate.ts), or the turn read loop in packages/agent/src/model/language-model.ts, and when coder/coder changes the chatd stream protocol.
---

# Verify: agent stream exactly-once

## The promise

- **Property.** Every character of text and reasoning that chatd commits for a turn reaches the AI SDK exactly once, text and reasoning together arrive in the order of the committed content, every `finish` usage counter counts each committed message once, and the turn ends with `finish` without an interrupt, for every order of connection drops, redials, retries, and replays within the bounds below.
- **One exception.** When chatd retries a step and the new attempt streams different parts (`retry` with `nextParts` in a scenario), the AI SDK keeps the abandoned attempt's content that it already got: a stream cannot take content back. If the committed content starts with that abandoned content, text and reasoning in one order, the AI SDK must still get the committed content exactly once. If not, it must get the abandoned content, then the complete committed content (`stepExpectation` in the check file, issue #407). The exception applies only to the step of such a retry. A step with reasoning is checked only without drops: a drop can hide the restart from the client, and then the translator reconciles each kind on its own and keeps a reasoning mismatch suppressed, because chatd can commit reasoning that it never streamed (`chatloop.go` keeps the text of a reasoning start in the content, but streams only reasoning deltas).
- **Harm.** When it breaks, a user of `agent.generate()` or `agent.stream()` sees repeated or missing text after a network blip, and the reported tokens and cost are wrong.

Unit tests pin a few hand-picked orders. This check tries every order within the bounds against the real code.

## How the check works

The check is a small stateless model checker in TypeScript. No verifier runs on this TypeScript code, and a hand model of the 1,100-line translator would drift from it. So the client side is the real code, and only the server is a model:

- `packages/agent/test/formal/chatd-world.ts` models what chatd sends on `/stream`. It follows coder/coder `coderd/x/chatd/ARCHITECTURE.md` ("Stream loop", "Sync operation", "Message part buffer") and `stream_loop.go` (`applyDBSnapshot`, `part`) at commit `3697bb38ce6fa29bf73a82f3494cca3ecf708de6`.
- `packages/agent/test/formal/stream-exactly-once.check.ts` drives the real `CoderLanguageModel.doStream` over a real `CoderChatClient` through a scripted WebSocket, under vitest fake timers. At each point where chatd or the network can do more than one thing, it asks the explorer.
- `packages/agent/test/formal/explore.ts` enumerates every decision sequence depth-first and reruns the client from scratch for each one.

One indivisible step of the check is one WebSocket frame, a close, or a failed handshake. That is also one indivisible step in the code: `streamChatEventsLoop` handles a whole frame in its `message` listener. Between steps, the harness lets the client run until it waits for the next frame.

## Does my change touch the verified code?

The check covers these files and functions. The sync commit is in "Coverage record" below.

```sh
SYNC=a67f2e8b0c7e1d8bb057ab643ef89bf68400b422
# A squash merge drops the branch commit: then use the commit that last updated this file.
git cat-file -e "$SYNC^{commit}" 2>/dev/null ||
  SYNC="$(git log -1 --format=%H -- .agents/skills/verify-agent-stream-exactly-once/SKILL.md)"
git diff --stat "$SYNC" -- \
  packages/agent/src/coder/ws.ts \
  packages/agent/src/model/translate.ts \
  packages/agent/src/model/language-model.ts \
  packages/agent/src/model/session-stream.ts \
  packages/agent/src/coder/client.ts \
  packages/agent/src/coder/types.ts \
  packages/agent/test/formal
```

Any output means that the covered code changed since the last sync. Run the check. Also run it when a change in coder/coder touches the chatd stream: `coderd/x/chatd/stream_loop.go`, `stream_subscribe.go`, `stream_relay.go`, or the "Stream loop" section of `ARCHITECTURE.md`. Then compare `chatd-world.ts` with the new source.

## Run

1. Install once, with the toolchain from `mise.toml` first on `PATH` (the ambient `PATH` can carry an older Node and pnpm):

   ```sh
   export PATH="$(mise where node)/bin:$(dirname "$(mise which pnpm)"):$PATH"
   CI=true pnpm install --frozen-lockfile
   ```

   The check imports `packages/agent/src` directly, so it needs no build.

2. Run every scenario, from anywhere in the repository:

   ```sh
   .agents/skills/verify-agent-stream-exactly-once/check.sh
   ```

   It takes about 20 seconds. Pass a name filter to run some scenarios: `check.sh "one step"`.

3. The script puts Node and pnpm from `mise.toml` first on `PATH` itself and uses the lockfile's vitest. It prints the versions and the commit first. It writes the full log to `$FORMAL_OUT`, default `$TMPDIR/agent-stream-exactly-once.log`, or `/tmp/agent-stream-exactly-once.log` when `TMPDIR` is unset.

At the sync commit every scenario passes:

```text
RESULT scenario="one step, two text parts, new chat" status=pass runs=2205 violating=0 violated=none
RESULT scenario="two steps, reasoning then text, follow-up turn" status=pass runs=41222 violating=0 violated=none
RESULT scenario="step 1 revised (text appended, usage changed) before step 2 starts" status=pass runs=19941 violating=0 violated=none
RESULT scenario="attempt fails after a partial stream and chatd retries it" status=pass runs=590 violating=0 violated=none
RESULT scenario="attempt fails after a partial stream and chatd retries it with different text" status=pass runs=980 violating=0 violated=none
RESULT scenario="attempt fails after a partial stream and chatd retries it, reasoning and text reordered" status=pass runs=23 violating=0 violated=none
RESULT scenario="step 1 revised while step 2 streams, so chatd restarts step 2" status=pass runs=2947 violating=0 violated=none
RESULT scenario="blank step 1, then a stop hook continues the turn into step 2" status=pass runs=7014 violating=0 violated=none
RESULT scenario="blank step 1, then a stop hook continues the turn and chatd retries step 2" status=pass runs=1761 violating=0 violated=none
```

The script exits 0 when every scenario is `pass` or `known-finding`. It exits non-zero on `fail`, and also when a known finding no longer reproduces.

## Read a result

- `status=pass`: no run in the scenario broke a property.
- `status=fail`: a run broke a property that the scenario must keep. The report prints the shortest counterexample for each property.
- `status=known-finding`: the scenario still shows the finding recorded below, and nothing else. Each known finding is pinned by a fingerprint in the scenario's `knownFinding` field: the violated properties, the number of violating runs, and the shortest counterexample's `=>` line per property. Exploration is deterministic, so another defect in the same scenario changes the fingerprint. The report then prints `FINGERPRINT differs` and the status is `fail`.

A counterexample is a numbered list of steps:

- `chatd ...` is a server transition from `chatd-world.ts`, such as "chatd commits the current step as an assistant message".
- `connection N ...` is a network event: the connection opens with its `after_id`, delivers one frame, drops (close 1006), or fails its handshake (502).
- `connection N opens (after_id=...); chatd queues the initial sync and K replayed preview part(s)` means that the new connection gets one frame with the initial sync (committed messages past `after_id`, status, `preview_reset`), then the K parts that the current attempt has streamed so far, from seq 1. The `delivers:` lines that follow show which of those frames arrived.
- `(N unforwarded preview part(s) dropped)` means that chatd ended the attempt before it forwarded those parts, as `stream_loop.go` `part` does.
- `=>` compares what the AI SDK got with what chatd committed. `ab[+e]` means that message text `ab` got the suffix `e` from a later revision. `{ab}ac` means that the AI SDK must keep `ab` from an abandoned attempt that diverged, then get the committed `ac` (see "One exception" above).

Every part in a scenario is one distinct letter, so a repeated letter is a duplicate and a missing letter is a loss. To print any one run, set `FORMAL_SHOW_RUN=<n>` (0-based, per scenario), for example `FORMAL_SHOW_RUN=7 check.sh "one step"`, and read the full log.

## A real bug or a modeling error?

Decide in this order:

1. `harness: ...`, `Chooser: replay diverged`, or `exploreAll: replay ended after` in the log is a harness problem, not a product bug. A divergence means that the client behaved differently on the same decisions, which makes the enumeration incomplete. Find the nondeterminism, such as a real timer or `Math.random`, before you trust any result.
2. Check each `chatd ...` step of the counterexample against chatd at the pinned commit. Fetch a file with `gh api "repos/coder/coder/contents/coderd/x/chatd/<file>?ref=3697bb38ce6fa29bf73a82f3494cca3ecf708de6" -H "Accept: application/vnd.github.raw"`. Each step maps to chatd code:

   | Step in the counterexample                        | chatd source (`coderd/x/chatd/`)                                                                        |
   | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
   | `connection N opens ...; chatd queues ...`        | `stream_subscribe.go` (initial events), `stream_loop.go` `applyDBSnapshot` from the null state          |
   | replayed preview parts, `delivers: ... part`      | `stream_loop.go` `part` (forwards seq > last forwarded seq; a new connection starts at 0)               |
   | `chatd streams the next part of the current step` | `ARCHITECTURE.md` "Message part buffer" (`AddPart`), "Generation goroutine" (`RecordGenerationAttempt`) |
   | `chatd commits the current step ...`              | `ARCHITECTURE.md` "Message revisions and history version"; `applyDBSnapshot` message sync               |
   | a blank step, `message N assistant ""`            | `chatloop/chatloop.go` `processStepStream` (a block without deltas commits empty text)                  |
   | `a stop hook continues the turn ...`              | `generation.go` `finishGenerationTurn`, `chathooks/effects.go` `EventMessages` (a model-only row)       |
   | `the provider call fails ...; chatd retires ...`  | `generation.go` (retryable errors), `applyDBSnapshot` (`attemptRetired`, retry event)                   |
   | `chatd revises step N's message ...`              | `ARCHITECTURE.md` "Event processing" case 2 (a history change cancels the attempt)                      |
   | `(N unforwarded preview part(s) dropped)`         | `stream_loop.go` `part` (rejects parts of an older history version or attempt)                          |

   When chatd cannot take a step, the model is wrong: fix `chatd-world.ts`, cite the chatd source in a comment, and rerun.

3. When every step is possible, the bug is real. The client path in the check is the production code, so no replay is needed to confirm it. Write the counterexample as a unit test in `packages/agent/test/unit/agent.test.ts`, with the `redialModel()` helper in "CoderLanguageModel stream redial (real reader)" as the template, and fix the code.
4. When your change alters the promise on purpose, change the property in `check()` and this file in the same commit, and say why. Never weaken a property, a bound, or the model to make a known bug pass.

## Known findings

None are open. The check records a finding with a `knownFinding` field on its scenario, as described in "Read a result". When a fix lands, the scenario fails with "known finding ... no longer reproduces": then delete its `knownFinding` field, so that it must pass, and its section here. A change that alters a finding without removing it prints `FINGERPRINT differs`. Read the new counterexample. When it is the same defect, copy the new run count and `=>` lines into `knownFinding` and say so in the commit.

Fixed: `restart-keeps-abandoned-deltas` ([#407](https://github.com/coder/ai-sdk/issues/407)). A chatd attempt restart left the abandoned attempt's deltas in the output ("aa" for a committed "ab").

## When the change is intended

- **New wire behavior.** When the client starts to handle an event that the model does not send yet, add the event to `chatd-world.ts` (with a citation) and add a scenario that uses it.
- **Bounds.** The bounds are the `SCENARIOS` list in the check file: steps, parts per step, `timeline`, and `maxDrops`. Keep a full run under about a minute. `maxRuns` makes a scenario fail fast when its run count grows past the limit.
- **After any change to the check, the model, or a covered file**, prove that the check can still fail:

  ```sh
  .agents/skills/verify-agent-stream-exactly-once/mutants.sh
  ```

  It takes about 5 minutes. It applies each `mutants/*.patch` to the real code, runs the check, and requires that a passing scenario now fails with the property on the patch's `Expect:` line. It reverts every patch, and it refuses to start when a file that a patch touches has local changes. Every mutant must print `CAUGHT`.

- **A patch no longer applies** because the code moved: make the same one-line break by hand in the new code, save it with `git diff -- <file> > mutants/<name>.patch`, put the `Expect:` line and the one-sentence description back at the top, and restore the file with `git checkout -- <file>`.

The mutants, and what each one breaks:

| Patch                                | Break                                                          | Property             |
| ------------------------------------ | -------------------------------------------------------------- | -------------------- |
| `01-reader-forwards-replayed-deltas` | The reader forwards deltas that a redial replays               | TextExactlyOnce      |
| `02-ledger-forgets-emitted-text`     | The translator ledger does not record emitted text             | TextExactlyOnce      |
| `03-redial-advances-cursor`          | A redial uses the highest committed id as `after_id`           | TextExactlyOnce      |
| `04-reasoning-deltas-not-pending`    | Streamed reasoning is not recorded as pending                  | ReasoningExactlyOnce |
| `05-usage-counted-per-snapshot`      | Usage is summed per snapshot, not per message id               | UsageOnce            |
| `06-drop-is-terminal`                | A drop ends the stream; the model then interrupts              | Completes            |
| `07-snapshot-text-before-reasoning`  | A snapshot emits text parts before reasoning parts             | ContentInOrder       |
| `08-restart-keeps-pending`           | A new attempt keeps the abandoned attempt's pending text       | TextExactlyOnce      |
| `09-diverged-commit-suppressed`      | A commit that diverges from the emitted text emits nothing     | TextExactlyOnce      |
| `10-restart-commit-ignores-order`    | After a restart, a commit is reconciled per kind, not in order | ContentInOrder       |
| `11-blank-snapshot-claims-deltas`    | A re-sent blank step claims the next step's open deltas        | TextExactlyOnce      |

`06` also breaks NoInterrupt, and `11` also breaks ContentInOrder. `07` breaks only ContentInOrder: the text and reasoning checks each see the right letters, in the wrong order between them.

## What a pass covers

A pass covers the real client code against the chatd model within these bounds. It does not cover the whole system.

- **Turn shapes:** a new chat (`createChat`, no `after_id`) and a follow-up turn (`createChatMessage`, `after_id` = the prompt id).
- **Steps:** up to 2 assistant steps of up to 3 text or reasoning parts. A part can be blank: a block without deltas streams nothing and commits empty text, as in a step whose only part is empty reasoning.
- **Server events:** streamed parts, commits, one retry (its new attempt streams the same parts, other text, or the same parts with reasoning and text reordered), one revision that appends text and changes usage, a `stop` hook that continues the turn after a step, and the settle.
- **Network:** up to 2 connection failures per run (drops or failed handshakes). That is fewer than the reader's budget of 5, so every run must complete. Each connection can open before or after any server event.
- **Relay lag:** at each commit, retry, or revision, chatd can drop any preview parts that it has not forwarded yet.

The check assumes these facts about chatd:

- The initial sync is one frame. Later events arrive one per frame. That is the finest frame split, so it also covers chatd batching several events into one frame.
- Events of one sync arrive in `applyDBSnapshot` order: messages, status, retry, `preview_reset`.
- A history change during a step cancels the attempt, and the step starts again from its first part.
- A redial replays every committed message past `after_id` at its latest revision, then the current attempt's parts from seq 1.
- A `stop` hook's model context row takes a message id and advances `history_version`, but the stream never sends it: `GetChatMessagesByRevisionForStream` in coder/coder `coderd/database/queries/chats.sql` reads only user-visible rows.
- A step that streams no parts sends only `preview_reset` when its attempt starts. The client ignores `preview_reset`, so the model leaves that attempt out.
- The client runs until it waits between environment steps. The reader queues frames in arrival order and drains its queue before it decides to redial (`ws.ts`), so a slower consumer sees the same events. I did not verify this for the `requires_action` pause path, which the check does not cover.

The check does not cover:

- Client tool calls, `requires_action`, and the stream that one turn keeps across segments.
- Server tool calls and their results, and sources.
- A `stop` hook's user-visible notice row.
- Queued submissions (#114, #119) and the promotion boundary (#120).
- `history_reset`, error status, 4xx handshakes, unparseable frames, and servers without episode coordinates.
- Aborts, `requestTimeoutMs`, and the `/watch` socket.
- A diverging retry on a step with reasoning when a drop hides the restart from the client (see "One exception"). Then the AI SDK keeps the abandoned content, each kind reconciles on its own, and diverging reasoning stays suppressed.
- The order of a revision suffix relative to later steps. The translator emits the suffix when it sees the revision, which can be after later steps' text. The check requires only that the suffix arrives once, in order, after its own message's text.

## Coverage record

- **Sync commit:** `a67f2e8b0c7e1d8bb057ab643ef89bf68400b422` (the branch that adds the blank-step scenarios, on top of `main` 84bb9cd, 2026-10-29). At this commit the check gives the results above, and all 11 mutants are `CAUGHT`. A squash merge removes this commit from history. Then the sync point is the commit that last changed this file, because the coverage record and the covered code merged together.
- **chatd model source:** coder/coder `3697bb38ce6fa29bf73a82f3494cca3ecf708de6`.

| File                                         | Functions the check exercises                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agent/src/coder/ws.ts`             | `streamChatEvents`, `streamChatEventsLoop`: the episode filter and progress accounting in `ingest`, redial and backoff, the failure budget, `sleep`          |
| `packages/agent/src/model/translate.ts`      | `TurnTranslator`: `ingest`, `#ingestMessagePart`, `#ingestMessage`, `#reconcileRevision`, `#flushDeferredRevisions`, `finish`; `accumulateUsage`, `mapUsage` |
| `packages/agent/src/model/language-model.ts` | `CoderLanguageModel.doStream`, `#runTurnInner` (submission, `afterId`, translator setup, read loop, settle, teardown interrupt), `#acquireStream`            |
| `packages/agent/src/model/session-stream.ts` | `SessionChatStream` (`read`, `close`)                                                                                                                        |
| `packages/agent/src/coder/client.ts`         | `CoderChatClient`: `createChat`, `createChatMessage`, `streamEvents`, chat route negotiation                                                                 |

Move the sync commit forward only after you confirm that the verification describes the code at the new commit:

1. Read the diff of the covered files since the sync commit. Look for behavior that the model does not exercise, such as an event type that the client now handles.
2. Run `check.sh`. The result must match the expected result above, or you updated that result on purpose.
3. Run `mutants.sh`. Every mutant must print `CAUGHT`.
4. Then replace both sync SHAs in this file (the one in "Does my change touch the verified code?" too) with the new commit, and update the run counts in the expected result. Use a commit on `main` when you can: a squash merge drops branch commits.
