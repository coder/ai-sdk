# Durable workflows: persist, resume, recover

Run **one agent session across process boundaries** — queue jobs,
durable‑workflow steps (Vercel Workflow, step functions, Temporal, …), cron
ticks — and survive the crashes, stream drops, and timeouts in between. Read
this when a chat must outlive the process that started it. Back to the
[package README](../README.md); mechanics are in
[Sessions](../README.md#sessions),
[Timeouts & cancellation](../README.md#timeouts--cancellation),
[Handling errors](../README.md#handling-errors), and
[Observability](../README.md#observability).

How it works:

- **All chat state lives on the Coder server** — messages, tool activity, the
  run itself. Between steps, carry only **`agent.chatId`** (a string) and,
  optionally, **`agent.lastSeenMessageId`** (the resume cursor; saves one
  serial round‑trip).
- **Each turn runs inside a durable step.** `CoderAgent` talks REST +
  WebSocket through its own client, so it can't ride a `fetch`‑shim durability
  layer.

| Sections                                                                                                                                                                      | Covers                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [Shape each step](#shape-each-step-one-turn-then-checkpoint) → [Archive](#archive-at-the-end--and-only-at-the-end)                                                            | The normal path.                                  |
| [Let the SDK absorb drops](#let-the-sdk-absorb-drops--and-handle-what-it-rethrows)                                                                                            | Errors that reach your step.                      |
| [Recover after a crash](#recover-after-a-crash), [Make client tools crash-safe](#make-client-tools-crash-safe), [Recover the result](#recover-the-result-before-resubmitting) | Hard crashes. The three snippets share variables. |

## Shape each step: one turn, then checkpoint

```ts
import { CoderAgent, type CoderTransportEvent } from "@coder/ai-sdk-agent";

interface WorkflowCheckpoint {
  chatId: string;
  /** The resume cursor — pairs with chatId, never persisted without it. */
  lastSeenMessageId?: number;
}

// Any durable KV your engine gives you: step state, a job row, a DB table.
declare const checkpoints: {
  get(workflowId: string): Promise<WorkflowCheckpoint | undefined>;
  set(workflowId: string, checkpoint: WorkflowCheckpoint): Promise<void>;
};

export async function runTurn(workflowId: string, prompt: string): Promise<string> {
  const checkpoint = await checkpoints.get(workflowId); // undefined on the first step → the turn creates the chat
  const agent = new CoderAgent({
    baseUrl: process.env.CODER_URL!,
    token: process.env.CODER_SESSION_TOKEN!, // read per step — never checkpoint or log it
    organizationId: process.env.CODER_ORG_ID!,
    chatId: checkpoint?.chatId,
    lastSeenMessageId: checkpoint?.lastSeenMessageId, // optional: skips the pre-prompt history probe
    requestTimeoutMs: 300_000, // per segment — see "Bound every step"
    onTransportEvent: observe, // see "Watch turn health"
  });

  try {
    const { text } = await agent.generate({
      prompt,
      abortSignal: AbortSignal.timeout(600_000), // total wall-clock for the step
    });
    return text;
  } finally {
    // Checkpoint even when the turn failed: failed-but-alive chats stay reachable.
    if (agent.chatId) {
      const next: WorkflowCheckpoint = { chatId: agent.chatId };
      // A turn that failed before streaming may have no cursor.
      if (agent.lastSeenMessageId !== undefined) {
        next.lastSeenMessageId = agent.lastSeenMessageId;
      }
      await checkpoints.set(workflowId, next);
    }
  }
}
```

| Rule                                                | Why                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One turn per step; `generate()`, not `stream()`** | The checkpointed unit is a finished result. A mid‑`stream()` failure surfaces on the stream, outside `generate()`'s error contract, which complicates step retries.                                                         |
| **Persist the id, not the instance**                | Never the token — read it from each step's environment.                                                                                                                                                                     |
| **Checkpoint in `finally`**                         | A first step that fails _after_ creating its chat (timeout, stream loss) must still persist the id, or the retry orphans a live chat and its partial effects. Only the [hard‑crash window](#recover-after-a-crash) remains. |
| **No `await using`**                                | Disposal archives the chat, and [archiving ends resumability](#archive-at-the-end--and-only-at-the-end).                                                                                                                    |

<details><summary>When the <code>finally</code> checkpoint writes nothing</summary>

After an exhausted stream failure on a chat this very call created, the SDK has
already discarded the dead session: `agent.chatId` is `undefined`, so nothing
is written. The thrown `CoderStreamError`'s `chatId` still names the stranded
chat, and `agent.archive()` retires it via `agent.lastKnownChatId`. See
[`CoderStreamError`](#let-the-sdk-absorb-drops--and-handle-what-it-rethrows)
for what retrying means then.

</details>

## Resume in the next step — any process, any machine

```ts
// Step 1 — a queue job on machine A:
await runTurn("wf-1042", "Investigate the failing nightly build and propose a fix.");

// Step 2 — hours later, on machine B: same chat, full server-side history.
await runTurn("wf-1042", "Apply the fix you proposed and summarize what changed.");

// Final step — cleanup belongs to the workflow, not to each step (see below).
await archiveWorkflowChat("wf-1042");
```

- **Construction does no I/O.** A bad or archived `chatId` fails the _turn_,
  not the constructor. Only `lastSeenMessageId` is validated locally: a cursor
  that isn't a positive integer, or lacks its `chatId`, throws immediately.
- **A resumed turn streams only its own events** — never earlier turns'
  content or usage. Without a checkpointed cursor (first resume, older
  checkpoints), it seeds one from the chat's newest message: one extra
  single‑message GET, same result.
- **Re‑supply client `tools` in every step that expects tool calls.** They live
  in your process. The workspace binding is the opposite: fixed at creation,
  unchangeable on resume.
- **Run steps strictly sequentially per chat.** Sessions are single‑flight
  system‑wide, not just per process.

<details><summary>What happens if two jobs post to the same chat</summary>

The second job queues behind the live run and burns its own `requestTimeoutMs`
waiting. It attributes nothing of the live run's output to itself — its window
opens only when its own queued prompt materializes. If it times out first, it
withdraws its queued prompt rather than leaving it to run unattended.

The live run's turn is guarded symmetrically. The server starts the queued
prompt's run **without ever emitting a terminal settle for the finished one**,
so the SDK settles the finishing turn the moment the promoted prompt appears on
its stream; nothing of the next turn's output or usage leaks into it.

That settle reports `finishReason: "stop"` as a documented approximation. The
wire doesn't distinguish a run that completed into a promotion from one
interrupted by `busy_behavior: "interrupt"`, so an interrupted turn also
settles `"stop"` (with whatever partial output it committed) rather than
surfacing an interruption.

</details>

## Bound every step

`requestTimeoutMs` arms **one timer per segment**, covering the REST phase
(chat creation, message/tool‑result submission, uploads), the stream, and
**any redial backoff inside the segment**.

- **Redials never reset the clock.** 12 s spent reconnecting is 12 s less
  budget, so a flaky network can't stretch a step past its bound.
- **On expiry** the call rejects with `CoderChatError` (`kind: "timeout"`,
  `retryable: true`), and the server run is interrupted best‑effort.
- **Cap total wall‑clock with `abortSignal: AbortSignal.timeout(…)`.** A turn
  driving client tools runs several segments
  ([Timeouts & cancellation](../README.md#timeouts--cancellation)).
- **A turn that times out (or crashes) before its chat id arrived** leaves
  nothing to _resume_ — the checkpoint stays empty and the retried step starts
  fresh — but possibly an unacknowledged chat to sweep
  ([Recover after a crash](#recover-after-a-crash)).

## Watch turn health from inside the step

Emit [transport events](../README.md#observability) as step metrics/traces;
they classify how each segment ended without parsing errors or stream frames:

```ts
declare const metrics: {
  ok(segment: number, status: string, ms: number): void;
  fail(segment: number, error: string, detail: string): void;
  teardown(segment: number): void;
};

function observe(ev: CoderTransportEvent): void {
  if (ev.type === "ws:redial") {
    // Early warning: the server keeps generating, nothing is lost yet;
    // the turn fails if this hits the cap.
    console.warn(
      `redial ${ev.consecutiveFailures}/${ev.maxConsecutiveFailures}, next in ${ev.backoffMs}ms`,
    );
  } else if (ev.type === "segment:settle") {
    if (ev.finishReason) metrics.ok(ev.segment, ev.status!, ev.durationMs);
    else if (ev.error) metrics.fail(ev.segment, ev.error.name, ev.error.message);
    else metrics.teardown(ev.segment);
  }
}
```

`segment:settle` fires exactly once per `segment:start`, with one of three
endings:

| Ending           | Fields                                                                                 | Means                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clean settle** | `status` + `finishReason`                                                              | `finishReason: "tool-calls"` (status `requires_action`) is a healthy mid‑turn pause for your client tools; terminal statuses end the turn.                                                                                                                                                          |
| **Failure**      | `error: { name, message }`, plus `status` when the server run still settled terminally | Server‑side turn errors, transport failure after exhausted redials, `requestTimeoutMs` expiry (`error.name: "CoderChatError"`), and caller aborts — named after the abort reason, never teardowns: `"TimeoutError"` for an `AbortSignal.timeout(…)` deadline, `"AbortError"` for an explicit abort. |
| **Teardown**     | neither                                                                                | The stream consumer itself cancelled the turn (`stream()`'s `ReadableStream.cancel()` with no abort of its own) — rare in `generate()`‑shaped steps.                                                                                                                                                |

Handler exceptions are swallowed and can't disturb the turn; an unset hook
costs nothing. For fleet‑level monitoring _across_ steps, see
[Preventing stuck turns](./workspaces-and-quota.md#preventing-stuck-turns).

## Archive at the end — and only at the end

**An archived chat cannot be resumed:** the server rejects new messages on it
(400, `Cannot send messages to an archived chat`). So skip the per‑request
[Cleanup](../README.md#cleanup) habits (`await using`, `archive()` in a
`finally`) in intermediate steps.

The _workflow_ owns the chat's end of life: archive once, in the final step and
in the failure/compensation handler, so abandoned runs don't accumulate live
chats.

```ts
export async function archiveWorkflowChat(workflowId: string): Promise<void> {
  const checkpoint = await checkpoints.get(workflowId);
  if (!checkpoint) return; // the workflow died before its first turn created a chat
  const agent = new CoderAgent({
    baseUrl: process.env.CODER_URL!,
    token: process.env.CODER_SESSION_TOKEN!,
    organizationId: process.env.CODER_ORG_ID!,
    chatId: checkpoint.chatId,
  });
  // A crashed step may have left a run live — stop it first, bounded. On an
  // already-settled chat the interrupt rejects with a 409; ignore it.
  await agent.interrupt({ signal: AbortSignal.timeout(15_000) }).catch(() => {});
  await agent.archive(); // retries 409s while the interrupted run winds down (~15s)
}
```

## Let the SDK absorb drops — and handle what it re‑throws

These self‑heal, invisible to the step; the run is **not** interrupted:

- **Transient stream drops.** The server keeps generating; the SDK redials
  with backoff and replays what it missed. Drops cost latency, never content,
  and never duplicate content.
- **Drops during a client‑tool pause.** The turn keeps its stream across
  `requires_action` pauses; a drop while your tool executes redials in the
  background.
- **A lost tool‑call event.** If the pause's tool‑call event doesn't arrive
  within ~2 s, the SDK recovers the pending calls from committed history over
  REST and the turn continues.

<details><summary>What a redial replays</summary>

Committed messages past the turn's cursor plus the in‑progress message's
deltas, deduplicated on receipt. A message that committed _while the
connection was down_ arrives as exactly its missing tail.

</details>

Once self‑healing is exhausted, the step sees one of three errors:

```ts
import { CoderApiError, CoderChatError, CoderStreamError } from "@coder/ai-sdk-agent";

try {
  await runTurn(workflowId, prompt);
} catch (err) {
  if (err instanceof CoderChatError && err.retryable) {
    // Timeout or transient turn failure; the chat survives. A re-run
    // resubmits the prompt as a new user turn (below).
  } else if (err instanceof CoderStreamError) {
    // Redial budget exhausted (~15s without forward progress). On a resumed
    // chat this is never auto-retried — the retry decision is yours (below).
  } else if (err instanceof CoderApiError) {
    // Branch on err.status: back off and retry 408/425/429/5xx; fail the workflow
    // on the rest (expired token, archived/deleted chat, …).
  }
  throw err;
}
```

**Any re‑run resubmits the prompt as a new user turn.** Partial output stays in
history; tool effects that already ran are not undone. `retryable` means the
_failure_ is transient, not that a re‑run is free: retry only steps that
tolerate re‑submission, and reconcile first otherwise.

| Error                                         | Cause                                                                                                              | Before retrying                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CoderChatError`, `retryable: true`           | `requestTimeoutMs` expired (`kind: "timeout"`) or a transient turn failure (`kind: "stream_closed"`, upstream 5xx) | Chat survives. Run the [settle‑wait](#recover-after-a-crash) before resubmitting. After a `timeout`, also pin `cutShort = true` in the [result check](#recover-the-result-before-resubmitting): the expiry already fired an interrupt. |
| `CoderStreamError` (an AI SDK `APICallError`) | The stream could not be re‑established                                                                             | `isRetryable: true` only for a turn that just created its chat with no workspace, no MCP servers, and no fresh inline uploads (the SDK then discards the session). Always `false` on a resumed chat.                                   |
| `CoderApiError` (every non‑2xx)               | An HTTP request failed                                                                                             | Back off and retry 408, 425, 429, 5xx. Fail the workflow on 401/403/404 and the archived‑chat 400 — every attempt hits the same wall.                                                                                                  |

<details><summary><code>CoderChatError</code>: why wait, and why pin <code>cutShort</code></summary>

The session is **not** discarded. The retried step reloads the checkpointed
chat id (the `finally` checkpoint makes this hold even when the _first_ step
fails after creating its chat) and resubmits the same prompt as a new user
turn, with the aborted attempt's partial output in history and any tool
effects that ran before the failure not undone.

Don't resubmit _immediately_: the expiry's server interrupt is asynchronous and
best‑effort, so the timed‑out run may still be committing. Run the same
interrupt‑and‑wait‑for‑terminal‑status recovery as after a crash before the
retry, or its trailing output is absorbed into the retried turn.

A timed‑out run can also have _finished_ before that interrupt landed. Because
the interrupt was already fired, the result check must treat the attempt as
cut short (pin `cutShort`) rather than trust its own 409.

</details>

<details><summary><code>CoderStreamError</code>: retry semantics and orphaned chats</summary>

When `isRetryable: true`, a retry — `maxRetries` or a re‑run step — starts
clean on a fresh chat.

**On a resumed chat it is always `isRetryable: false`.** Re‑running the step
resubmits the same prompt as a _new user turn_, with the failed attempt's
partial output still in history (usually fine — the model sees its own aborted
attempt), and any workspace/MCP tool effects that ran before the drop are not
undone. That judgment call belongs to your workflow, which is why it isn't
automatic.

**The discard happens for _every_ chat the failed turn itself created —
including the effectful, `isRetryable: false` case.** `agent.chatId` is
`undefined` and the `finally` checkpoint writes nothing, but the stranded chat
is not nameless: the error's **`chatId`** field names it, and
`interrupt()`/`archive()` keep targeting it via `agent.lastKnownChatId`
([Cleanup](../README.md#cleanup)). The step's error path can retire the orphan
directly, or checkpoint `err.chatId` for the
[reconciliation sweep](#recover-after-a-crash) when its workspace/MCP effects
need reconciling first. A retried step then starts a fresh chat that has _not_
seen the orphan's effects: gate that retry on the same idempotency judgment as
any re‑submission.

</details>

## Recover after a crash

A hard crash (OOM kill, host loss) runs no `finally` blocks. What to do depends
on where it hit:

| Crashed…                                  | Left behind server‑side                                                                                                                  | Do                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **with an empty checkpoint**              | Usually nothing — but _up to one unacknowledged chat per attempt may exist_; automatic retries can stack several.                        | Fresh chat, plus the sweep.                                                            |
| **after creation, before the checkpoint** | An orphan: generating until it settles — or, if the crash hit a client tool, paused in `requires_action` forever, holding its workspace. | Fresh chat (no id to interrupt), plus the sweep.                                       |
| **after the checkpoint**                  | A resumable chat, possibly with a live run or a client‑tool pause.                                                                       | Settle‑wait (below), then the [result check](#recover-the-result-before-resubmitting). |

<details><summary>Why an empty checkpoint is not a clean slate</summary>

A crash or `requestTimeoutMs` expiry while the create request was _in flight_
can leave a chat the server committed but whose id never arrived — unreachable
even by the SDK's own interrupt.

</details>

**The reconciliation sweep is not optional in this pattern.** Start from the
sweep in
[Preventing stuck turns](./workspaces-and-quota.md#preventing-stuck-turns),
with two changes:

- **Widen the filter:** sweep every chat no checkpoint accounts for —
  regardless of status — and interrupt/archive it. An orphaned first turn may
  settle terminally on its own and then sit live and unarchived forever; the
  fleet sweep only catches _non‑terminal_ chats.
- **Retire _every_ matching orphan**, not just the first, including its
  workspace/MCP effects if the deployment auto‑attached any.

<details><summary>Shrinking the window with an eager checkpoint (and what it costs)</summary>

Checkpoint eagerly from the first `ws:dial` transport event — it carries the
chat id as soon as the chat exists. The checkpoint's lifecycle is then yours
too:

- The retried step resumes a chat holding a dead half‑turn.
- Whenever a `CoderStreamError` killed a chat this step created — retryable or
  not — the SDK discards the session, but only in memory. Clear the eagerly
  checkpointed id yourself before any retry, or "starts fresh after a discard"
  silently turns into resuming the dead chat.

</details>

**After the checkpoint, don't just resubmit.** Stop what the crash left behind,
then **wait until the chat actually settles** before deciding:

- **A client‑tool pause is reconciled, never interrupted away** — if the
  tool's effect committed, the pause is its only pending record
  ([Make client tools crash-safe](#make-client-tools-crash-safe)).
- **Anything else is interrupted, then polled to a terminal status:**
  `interrupt()` resolves on acknowledgment, but the run keeps winding down
  (and committing) for a few seconds.
- **A 409 `CoderApiError`** from the interrupt means no live run — the good
  case.

<details><summary>What goes wrong if you resubmit straight away</summary>

- The crashed attempt's run may still be live. A resubmission queues behind
  it: nothing the old run commits is attributed to the resumed turn (its window
  opens only at its own queued prompt's materialization), but the step burns
  its `requestTimeoutMs` waiting for the old run to finish first — and a
  timeout withdraws the queued prompt again.
- A crash inside one of your client tools leaves the chat paused in
  `requires_action`, where new messages wait forever.

</details>

```ts
// Defined in "Make client tools crash-safe": resolves to its `unstarted`,
// true only when it fell back to interrupting.
declare function reconcileClientTools(): Promise<boolean>;
// A per-ATTEMPT journal: each entry pins the step marker and attempt count.
type JournalEntry = {
  // "submitting": written ahead of every send on a checkpointed chat.
  // "resumed" / "cut-short": the ledger reconcile's verdict.
  state: "submitting" | "resumed" | "cut-short";
  marker: string; // the step-scoped marker ("Recover the result…", below)
  attempt: number; // markerAttempts() at write time
  at: number; // write time — bounds the in-flight-send wait below
};
declare const journal: {
  get(chatId: string): Promise<JournalEntry | undefined>;
  set(chatId: string, entry: JournalEntry): Promise<void>;
};
// Count of this step's committed attempts (user messages carrying the marker).
declare function markerAttempts(): Promise<number>;

// Bounded: a stalled deployment must fail the step, not hang it.
const deadline = AbortSignal.timeout(15_000);
// Did an interrupt stop a live run? A 409 means there was nothing to stop.
let cutShort = true;
let { status } = await agent.client.getChat(agent.chatId!, deadline);
// Apply the entry only if it classifies THIS attempt of THIS step.
const entry = await journal.get(agent.chatId!);
const attempts = await markerAttempts();
const journaled = entry?.marker === marker && entry.attempt === attempts ? entry : undefined;
if (status === "requires_action") {
  // A client tool crashed mid-execution: reconcile, never interrupt.
  cutShort = await reconcileClientTools();
} else if (journaled && journaled.state !== "submitting") {
  // A previous recovery pass acted on this attempt, then died.
  cutShort = journaled.state === "cut-short";
  if (cutShort) {
    // The journal records intent, not a landed interrupt: re-drive it.
    // A 409 means the chat already settled; the verdict stands.
    await agent.interrupt({ signal: deadline }).catch((err) => {
      if (!(err instanceof CoderApiError && err.status === 409)) throw err;
    });
  }
} else {
  await agent.interrupt({ signal: deadline }).catch((err) => {
    // A probed "interrupting" means an earlier interrupt already truncated
    // the attempt; the 409 just says it landed — keep cutShort = true.
    if (err instanceof CoderApiError && err.status === 409) cutShort = status === "interrupting";
    else throw err;
  });
}
// The crashed attempt's own send may still land: sleep out its commit
// window, then recount.
if (journaled?.state === "submitting") {
  await new Promise((r) => setTimeout(r, Math.max(0, journaled.at + 300_000 - Date.now())));
  if ((await markerAttempts()) === journaled.attempt && journaled.attempt > 0) cutShort = true;
}
// Turn-scale budget: a reconciled pause revives a full model/tool continuation.
const settle = AbortSignal.timeout(600_000);
do {
  ({ status } = await agent.client.getChat(agent.chatId!, settle));
  if (status === "waiting" || status === "completed" || status === "error") break;
  // Stable pause: the resumed run called a NEW client tool — reconcile again.
  if (status === "requires_action" && !cutShort) break;
  await new Promise((r) => setTimeout(r, 1_000)); // acknowledged ≠ settled — wait it out
} while (true);
```

Settled is necessary, not sufficient: the crashed attempt may already have
_finished the step's work_.
[Check history before resubmitting](#recover-the-result-before-resubmitting).

<details><summary>How the settle‑wait decides, branch by branch</summary>

**Journal scoping.** Entries are per attempt, so the chat id alone cannot scope
them: a verdict from attempt N must not classify attempt N+1 (double crash),
and a later step's recovery on the same chat must not inherit this one's. A
consult applies an entry only while both marker and attempt count still match,
so each resubmission retires every earlier verdict by itself — there is no
clear step to forget. The ledger reconciliation journals each action
write‑ahead, so a recovery pass that dies mid‑recovery is visible — and
classifiable — to the next.

**`markerAttempts()`** counts user messages in the converted transcript
carrying the marker. Steps run sequentially, so they sit contiguous at the tail
of history: page newest‑first (as the result scan does) and stop at the first
user message without the marker.

**`requires_action`.** The crash hit a client tool mid‑execution, and this
pause is the only pending record of its committed effects. Reconciliation
submits recorded results (reviving the run — nothing was cut short) or
interrupts itself only when nothing committed.

**Journaled `"resumed"`.** The previous pass revived the run by submitting
recorded results. Interrupting now would cut down a run doing the step's work,
and the resubmitted prompt would mint _new_ tool‑call ids, sidestepping the
idempotency keys. Let it finish; nothing was cut short.

**Journaled `"cut-short"`.** The previous pass went on to interrupt (an
unstarted sibling in the batch), so the attempt is truncated and the result
check must resubmit. The journal records write‑ahead _intent_, not a landed
interrupt — the pass may have died in between, leaving the revived run working
— so the interrupt is re‑driven to make the intent true.

**A 409 on the fresh interrupt.** A 409 proves nothing is stoppable _now_. That
means "never cut short" only if the probe saw no interrupt already in flight. A
probed `"interrupting"` is an earlier interrupt (a timeout's best‑effort one, a
sweeper) already truncating the attempt.

**A matching `"submitting"` entry** — its attempt count has not grown — means
the process died with `createChatMessage` possibly en route, and the server can
commit it _after_ every read above (the 409 only said nothing was running
then). The wait sleeps out what remains of the entry's commit window:
`requestTimeoutMs` past the write is the conservative horizon, and a restart
has usually consumed it already. A late‑landing turn then starts before the
settle poll, and the next section's negative history read is past the window.

**An unlanded send over an existing attempt pins `cutShort`.** The step only
ever plans a resubmission over a cut‑short, errored, or unsubmitted attempt, so
the write‑ahead that superseded a `"cut-short"` verdict still carries its
consequence, and the result scan cannot mistake the old attempt's truncated
tail for a finished result.

**Two budgets.** The 15 s interrupt bound must not cap what follows: a
reconciled pause revives a full model/tool continuation. The settle poll — and
the history reads after it — are budgeted on the turn scale, like the step
itself.

**`requires_action` inside the poll.** With no accepted interrupt racing to
clear it, `requires_action` is a _stable_ pause: a run resumed by submitted
tool results called a new client tool. Exit and reconcile the ledger again
instead of polling out the deadline.

</details>

## Make client tools crash-safe

If the process dies _between_ a non‑idempotent client tool committing its
effect (a payment, a deploy, an email) and the result reaching the server, the
`requires_action` pause is the **only pending record of the execution**.
Interrupt it away, and the resubmitted prompt may call the tool again —
duplicating the effect.

Fix: a **tool‑invocation ledger** in the same durable store as the `chatId`
checkpoint, keyed by **chat id + `toolCallId`**. The server assigns the call id
and commits it to history, so both sides survive the crash.

<details><summary>Why the chat id (and tenant) belong in the key</summary>

Call ids are only unique _within_ a chat. Put the chat id in the ledger key and
in the idempotency key handed to the external system: a store shared across
workflows must never let one chat's `done` entry answer — or deduplicate —
another chat's call. In multi‑tenant stores, fold the tenant in too.

</details>

```ts
import { tool } from "ai";
import { z } from "zod";
import { CoderAgent } from "@coder/ai-sdk-agent";

type LedgerEntry = { state: "committing" } | { state: "done"; output: string };
declare const ledger: {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
};
declare const payments: {
  charge(amountCents: number, opts: { idempotencyKey: string }): Promise<{ receiptId: string }>;
};

const ledgerKey = (chatId: string, toolCallId: string) => `${chatId}/${toolCallId}`;
const ChargeArgs = z.object({ amountCents: z.number().int() });

// Takes a getter: the chat may not exist until the turn creates it, but its
// id is set before any tool runs.
const chargeCard = (chatId: () => string) =>
  tool({
    description: "Charge the customer's card.",
    inputSchema: ChargeArgs, // shared with recovery's re-drive dispatch below
    execute: async ({ amountCents }, { toolCallId }) => {
      const key = ledgerKey(chatId(), toolCallId);
      // Write-ahead, BEFORE the effect: no entry proves the effect never started.
      await ledger.set(key, { state: "committing" });
      // The SAME key as the idempotency key: re-driving can never double-charge.
      const { receiptId } = await payments.charge(amountCents, { idempotencyKey: key });
      await ledger.set(key, { state: "done", output: `charged: receipt ${receiptId}` });
      return `charged: receipt ${receiptId}`;
    },
  });

// A direct self-reference in the constructor call is circular for the type
// checker — defer it through a box assigned right after.
let self: { chatId?: string } | undefined;
const agent = new CoderAgent({
  baseUrl: process.env.CODER_URL!,
  token: process.env.CODER_SESSION_TOKEN!,
  organizationId: process.env.CODER_ORG_ID!,
  // …plus chatId, requestTimeoutMs, etc. as in runTurn
  tools: { charge_card: chargeCard(() => self!.chatId!) },
});
self = agent;
```

On recovery, reconcile a `requires_action` pause _before_ any interrupt. The
pending calls are in committed history; the ledger holds the verdict on each:

| Ledger entry | Meaning                                                | Action                                                                                                                                 |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `done`       | Effect committed, result stranded.                     | Submit the recorded output; nothing re‑executes.                                                                                       |
| `committing` | Ambiguous: crashed between the write‑ahead and `done`. | Re‑drive with the _same_ idempotency key (a committed effect replays as a no‑op), args from history, validated as the live loop would. |
| none         | The tool never ran.                                    | Interrupting loses nothing.                                                                                                            |

This is the derivation the SDK uses to recover a lost `action_required` event:

```ts
// History does not record which calls were client tools (see [Rehydrating
// chat history]), so restrict to the names this step registers: a server/MCP
// call must never reach the ledger as "unstarted". The result scan's
// final-text cut reuses this set (next section).
const clientTools = new Set(["charge_card"]);

// Pending = the last assistant message's client (non-provider-executed,
// ToolSet-named) tool calls, minus ids answered by a later message's tool
// result.
const { messages } = await agent.client.getMessages(agent.chatId!, { limit: 200 }, deadline);
const ordered = [...messages].sort((a, b) => a.id - b.id);
const lastAssistant = ordered.findLast((m) => m.role === "assistant");
const handled = new Set(
  ordered
    .filter((m) => m.id > (lastAssistant?.id ?? 0))
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "tool-result")
    .map((p) => p.tool_call_id),
);
const pending = (lastAssistant?.content ?? []).filter(
  (p) =>
    p.type === "tool-call" &&
    !p.provider_executed &&
    clientTools.has(p.tool_name!) &&
    !handled.has(p.tool_call_id),
);

const results: { tool_call_id: string; output: unknown }[] = [];
let unstarted = false;
for (const call of pending) {
  const key = ledgerKey(agent.chatId!, call.tool_call_id!);
  const entry = await ledger.get(key);
  if (entry?.state === "done") {
    results.push({ tool_call_id: call.tool_call_id!, output: entry.output });
  } else if (entry) {
    // "committing": re-drive. Every ledgered tool needs its own path.
    if (call.tool_name !== "charge_card")
      throw new Error(`no re-drive path for tool ${call.tool_name}`);
    const { amountCents } = ChargeArgs.parse(call.args);
    const { receiptId } = await payments.charge(amountCents, { idempotencyKey: key });
    const output = `charged: receipt ${receiptId}`;
    await ledger.set(key, { state: "done", output });
    results.push({ tool_call_id: call.tool_call_id!, output });
  } else {
    unstarted = true; // the tool never ran — interrupting loses nothing
  }
}
if (results.length > 0 || unstarted) {
  // ONE write-ahead with the batch's FINAL verdict, before any network call.
  await journal.set(agent.chatId!, {
    state: unstarted ? "cut-short" : "resumed",
    marker,
    attempt: await markerAttempts(),
    at: Date.now(),
  });
}
if (results.length > 0) await agent.client.submitToolResults(agent.chatId!, { results }, deadline);
if (unstarted) await agent.client.interruptChat(agent.chatId!, deadline);
// As `reconcileClientTools()` in the settle-wait snippet above: resolve to
// `unstarted` — cutShort is true only when this fell back to interrupting.
```

- **Only interrupt when the ledger shows no committed effect.** Submitted
  results are committed to history, so even a mixed batch (one call done, a
  sibling never started) that ends in an interrupt keeps the effect's recorded
  outcome for the resubmitted turn.
- **Submitting answers the pause; it does not revive your tool loop.** The turn
  resumes **server‑side** with no process streaming it. Its output lands only
  in history — [recover it](#recover-the-result-before-resubmitting) instead
  of resubmitting.

<details><summary>How reconciliation interacts with the settle‑wait</summary>

- **Why the settle‑wait's reconcile branch never interrupts a pause:** nothing
  stranded is left to stop, and an interrupt now would cut down the very run
  the submission revived.
- **Why `unstarted` leaves `cutShort = false` after a submission with no
  unstarted call:** nothing was cut short, and the next section's `!cutShort`
  check must classify the resumed run's finish as a completed attempt, not
  resubmit it.
- **The settle poll uses a turn‑scale deadline**, not the 15 s interrupt bound.
  It exits on `requires_action` (stable here, with no accepted interrupt
  clearing it), which means the resumed run called a _new_ tool — reconcile
  again; a call with no ledger entry is safe to interrupt.
- **One batch verdict, journaled first.** A mixed batch journals `"cut-short"`
  before even its submission, so no crash point can leave a stale `"resumed"`
  masking the pending interrupt. Every crash then either re‑reconciles the
  stable pause or re‑drives the journaled intent. The verdict is scoped to this
  attempt: a resubmission grows the marker count and retires it on its own.
- **Tool write‑ahead.** A crash between the `committing` and `done` writes
  leaves `committing` (ambiguous, but resolvable by re‑driving); no entry at
  all proves the effect never started.

</details>

## Recover the result before resubmitting

The last crash window: **the server finished the turn, but the process died
before recording the step's result.** A blind resubmit runs the whole turn
again — duplicated output, repeated workspace/MCP/tool effects.

**First, make attempts matchable.** The server stores the prompt verbatim:
embed a step‑scoped marker, and journal every send before it leaves the
process.

```ts
const marker = `[${workflowId}/step-2]`; // stable across this step's retries
// Write-ahead, BEFORE the send — first attempt and recovery resubmit alike.
if (agent.chatId) {
  await journal.set(agent.chatId, {
    state: "submitting",
    marker,
    attempt: await markerAttempts(),
    at: Date.now(),
  });
}
const { text } = await agent.generate({ prompt: `${marker} ${prompt}` });
```

<details><summary>What the send write‑ahead guarantees</summary>

- A crash before this write proves no send ever started. A crash after it
  leaves a dated entry whose commit window the settle‑wait sleeps out.
- On a resubmission this write supersedes the `"cut-short"` verdict it acts on
  — safely: an unlanded send over an existing attempt makes the settle‑wait pin
  `cutShort` right back.
- A first turn has no chat id to journal under. Its send‑crash window belongs
  to the empty‑checkpoint sweep ([Recover after a crash](#recover-after-a-crash)).

</details>

**Then, after the settle‑wait,** classify the attempt:

| State                    | Condition                                                 | Action                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finished, recording lost | `submitted && !cutShort`, status `waiting` or `completed` | Return the recovered result.                                                                                                                                                 |
| Never finished           | `!submitted`, status `"error"`, or `cutShort`             | Resubmit. `!submitted` is sound only behind the write‑ahead; `"error"` gets normal retry judgment; after `cutShort` the model continues from its aborted attempt in history. |
| Paused                   | settled `requires_action`                                 | Back to ledger reconciliation ([previous section](#make-client-tools-crash-safe)) — never recovery or resubmission.                                                          |

```ts
import { chatMessagesToUIMessages } from "@coder/ai-sdk-agent";

// A long turn can commit more than a page after the prompt: page newest-first
// (the endpoint's default order) until the turn's user message is on hand.
// "Never submitted" must never be concluded from a truncated read.
const fetched = [];
let page = await agent.client.getMessages(agent.chatId!, { limit: 200 }, settle);
fetched.push(...page.messages);
while (!fetched.some((m) => m.role === "user") && page.has_more) {
  const oldestId = Math.min(...fetched.map((m) => m.id));
  page = await agent.client.getMessages(agent.chatId!, { before_id: oldestId, limit: 200 }, settle);
  fetched.push(...page.messages);
}
const transcript = chatMessagesToUIMessages(fetched); // chronological
const lastUser = transcript.findLast((m) => m.role === "user");
const submitted = lastUser?.parts.some((p) => p.type === "text" && p.text.includes(marker));

if (submitted && !cutShort && (status === "waiting" || status === "completed")) {
  // Recover what `generate().text` would have returned: the FINAL step's
  // text, after the last configured client-tool part.
  const parts = transcript
    .slice(transcript.indexOf(lastUser!) + 1)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts);
  return parts
    .slice(parts.findLastIndex((p) => p.type === "dynamic-tool" && clientTools.has(p.toolName)) + 1)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}
// Otherwise resubmit — unless the settle was requires_action (table above).
```

- **`cutShort` separates completed from interrupted; history can't** (both
  leave the marker and an answer). A 409 only proves nothing is running _now_:
  pin `cutShort = true` when recovery follows a known timeout or abort, and let
  only the hard‑crash path trust the 409. The settle‑wait already pins it for a
  matching journaled `"cut-short"` or an unlanded `"submitting"` over an
  existing attempt.
- **`!submitted` races the crashed attempt's own send.** The write‑ahead
  narrows that window; it cannot close it.
- **The text cut lands at the last _configured client‑tool_ boundary.** Only a
  client tool ends an AI SDK step, so narration before a trailing
  _server‑side_ call survives, matching what `generate().text` aggregates.

<details><summary>Why a 409 cannot prove the attempt finished after a timeout</summary>

The inference "409 ⇒ the attempt finished" is sound only when recovery's
interrupt is the _first_ one that could have stopped the run: true after a hard
crash, false after a `requestTimeoutMs` expiry. The expiry already fired the
SDK's own best‑effort interrupt, which may have stopped the run before recovery
ever looked. So carry the reason recovery ran.

</details>

<details><summary>The remaining duplicate‑send window</summary>

This is the at‑least‑once boundary every durable engine has around external
effects; the chat itself is the record that narrows it to one honest window.

A crash kills the process, not necessarily its in‑flight `createChatMessage`.
The server can commit that request _after_ an interrupt 409'd and a history
read saw no marker, and a resubmit on that evidence queues the turn twice,
duplicating its workspace/MCP/tool effects.

The write‑ahead makes the negative read honest: no matching `"submitting"`
entry proves no send ever started, and a matching one held recovery at the
settle‑wait until the entry's commit horizon passed. Only server‑enforced
submission idempotency could close the window, and
`POST /chats/{id}/messages` offers none today. A commit that outlasts even the
horizon still lands under the same marker, so the duplicate is at least
visible — in history, and to the next consult's attempt count.

</details>

<details><summary>Where name‑matching the client‑tool cut goes wrong</summary>

Narration lands on both sides of a server‑side call, and history does not mark
which calls were client tools
([Rehydrating chat history](../README.md#rehydrating-chat-history)). So the
cut classifies by name against the reconcile's `clientTools` set. It cannot
see:

- A call recorded under a name the step no longer configures (a tool renamed
  between deploys) reads as server‑side and leaks earlier‑step narration into
  the result.
- A server tool sharing a configured name still cuts final‑step narration
  away.

</details>

<details><summary>Structured‑output steps: recover the call's input, not the text</summary>

A [structured output](./structured-output.md) step's answer is the
`structured_output` call's typed input, which rehydrates as a `dynamic-tool`
part on the recovered turn
([Rehydrating chat history](../README.md#rehydrating-chat-history)).
`structured_output` is one of the step's configured client tools, so the text
join above cuts at it and returns only the ack prose that follows. Recover the
filed call instead: this scan replaces the text join _inside_ the recovery
branch above, reusing its `parts`, and validates client‑side exactly like the
live path ([rule 2](./structured-output.md#2-validate-clientside) — the schema is the real gate):

```ts
// Scan backward to the last call that VALIDATES, as in the live path — a
// schema-invalid re-file must not shadow a valid answer.
const filed = parts
  .filter((p) => p.type === "dynamic-tool")
  .filter((p) => p.toolName === "structured_output");
let answer: z.infer<typeof Answer> | undefined;
for (const call of filed.reverse()) {
  const parsed = Answer.safeParse(call.input);
  if (parsed.success) {
    answer = parsed.data;
    break;
  }
}
// recovered ⇔ answer !== undefined
```

</details>

## Checklist

- One turn per durable step; `generate()`, not `stream()`.
- Persist `agent.chatId` (a string) — never the instance, never the token.
- Bound every step: `requestTimeoutMs` per segment, an abort deadline for total
  wall‑clock.
- Let redials self‑heal; own every retry decision — a re‑run step resubmits its
  prompt as a new user turn.
- Before resubmitting after a crash: reconcile the tool ledger before any
  interrupt, recover a finished attempt's result from history, and trust "never
  submitted" only past the journaled send's commit window.
- Keep concurrent steps' fan‑out within workspace quota —
  [Workspaces & quota](./workspaces-and-quota.md).
- Steps that don't need server‑side tools (plan / extract / synthesize) are
  cheaper and natively structured through
  [`@coder/ai-sdk-provider`](../../provider) + `generateObject` — no chat, no
  workspace, no cleanup.
- Archive in the final step / failure handler — never per step.
