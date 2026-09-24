# Workspaces & quota

How to run fleets of agents: how a chat binds to a Coder workspace, how to size
concurrency, what to clean up, and how to diagnose a stuck chat. Read it before
running many `CoderAgent`s at once. Back to the [package README](../README.md).

A chat may be backed by a **Coder workspace** that runs its tools, depending on
its configuration and the deployment. Workspaces are the scarce resource: a
deployment budgets how many an account may run at once, so **N agents running concurrently can need N schedulable workspaces.** Past that
bound, a turn can sit unscheduled and never settle.

## How a chat binds to a workspace

- **One chat, at most one workspace, fixed at creation.** `workspaceId` is sent
  as `workspace_id` on chat creation; message and update requests carry no
  workspace field. To move work to another workspace, start a new agent/chat.
- **This SDK never provisions workspaces.** Pass an existing one. Provision it
  with [`@coder/ai-sdk-sandbox`](https://github.com/coder/ai-sdk/tree/main/packages/sandbox)'s `ensureCoderWorkspace`, the
  CLI, or the v2 API.
- **A chat created without `workspaceId` can still be workspace‑backed.**
  Deployments may assign one server‑side. The SDK reads the created chat's
  `workspace_id` and treats the chat as workspace‑backed from then on (this
  affects [retry ownership](#preventing-stuck-turns)).
- **Chat cleanup does not release the workspace.** `archive()` soft‑hides the
  chat only. The workspace keeps running until template autostop or an
  explicit stop. Stopping releases only stop‑scoped quota; persistent resources
  (disks, volumes) keep consuming their cost until the workspace is deleted.

## Sizing a fleet

Rule: **workspaces that must be running concurrently ≤ schedulable
workspaces.**

- **One workspace per chat** (the common shape, and what auto‑assigning
  deployments produce): concurrent chats ≤ schedulable workspaces.
- **Chats bound to a shared `workspaceId`** count it once, so their concurrency
  is not quota‑bound. They share one filesystem and tool environment — only
  acceptable within a single tenant / trust boundary.

"Schedulable" is a deployment property, not an SDK knob. Whichever binds first:

| Limit                                     | How it works                                                                                                                                                                                              | When exceeded                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Workspace quota** (premium deployments) | Templates declare per‑resource costs. A user's budget is the sum of their groups' quota allowances, enforced when a build starts or stops ([resource quotas](https://coder.com/docs/admin/users/quotas)). | The build **fails** (`INSUFFICIENT_QUOTA`, "insufficient quota"); the turn never gets its workspace. |
| **Infrastructure**                        | No per‑user workspace limit by default without quotas ([workspace lifecycle](https://coder.com/docs/user-guides/workspace-lifecycle)). The bound is provisioner throughput and cluster capacity.          | Slow or failing builds, not a crisp quota error.                                                     |

Practical sizing:

1. **Read headroom before fanning out.**
   `GET /api/v2/organizations/{org}/members/{user}/workspace-quota` returns
   `{ "credits_consumed": …, "budget": … }`. Admit another workspace only while
   `budget − credits_consumed` covers _that workspace's_ cost (the sum of its
   template's `daily_cost` declarations).
   <details><summary>Credits are not slots</summary>

   "Free slots = headroom ÷ cost" only holds for a homogeneous fleet on one
   template. With mixed templates, size against each planned workspace's own
   cost.

   </details>

2. **Queue the rest client‑side.** An unschedulable turn does not queue
   usefully on the server ([Preventing stuck turns](#preventing-stuck-turns)).
3. **Reuse one bound workspace** across sequential turns and sessions. The
   workspace is the expensive part; the chat is cheap. Reuse only **within one
   tenant / trust boundary**: agents have file and shell tools, so a reused
   filesystem carries one session's artifacts (and secrets) into the next.
   Provision per tenant, or securely reset a workspace before reassigning it.
4. **Send steps that don't need server‑side tools to the
   [provider](https://github.com/coder/ai-sdk/tree/main/packages/provider)** — it never touches a workspace.

## Autostop & cleanup

Manage two lifetimes separately:

- **Chats:** `archive()` / `await using` every agent
  ([Cleanup](../README.md#cleanup)), or finished chats keep holding server
  resources.
- **Workspaces:** rely on template‑level scheduling, not manual hygiene.

| Template setting                | What to do                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Autostop TTL**                | Long enough to survive a normal session (including idle gaps between turns), short enough that a leaked workspace stops burning running‑cost within hours. Without autostop, a leaked workspace pins its full quota until someone notices. [Sandbox](https://github.com/coder/ai-sdk/tree/main/packages/sandbox): `stopAfter: "8h"` sets `ttl_ms` at creation. |
| **Activity bump** (default 1 h) | Extends a running workspace's deadline when Coder detects sessions. Check [what counts as activity](https://coder.com/docs/user-guides/workspace-scheduling) before assuming server‑side tool use keeps a workspace alive.                                                                                                                                     |
| **Dormancy / failure cleanup**  | Reaps abandoned and repeatedly‑failing workspaces automatically ([template scheduling](https://coder.com/docs/admin/templates/managing-templates/schedule)).                                                                                                                                                                                                   |

**Stopping is not enough.** A _stopped_ workspace typically still consumes its
persistent resources' `daily_cost` (disks, volumes), so a scratch fleet that
only ever stops converges on a full budget. Pair the TTL with dormancy
auto‑deletion or explicit deletion.

## Preventing stuck turns

The signature failure of an over‑committed fleet: the chat is created, the
stream opens, then nothing. There is **no distinct "quota exceeded" error kind
on the chat stream.** An unschedulable chat surfaces a generic turn error or
sits in a non‑terminal status indefinitely.

Defend in this order:

1. **Set `requestTimeoutMs` — always, in fleets.** It is unbounded by default.
   On expiry the call rejects with a `CoderChatError` (`kind: "timeout"`,
   `retryable: true`), so your dispatcher gets its slot back. Pair it with a
   reconciliation sweep: periodically interrupt/archive non‑terminal chats
   older than your budget.
   <details><summary>Why the run is not guaranteed released on timeout</summary>

   The timeout fires a server‑side interrupt **best‑effort**: fire‑and‑forget,
   and unreachable when the timeout lands before chat creation returned an id.
   The run usually stops, but is not guaranteed released
   ([Timeouts](../README.md#timeouts--cancellation)).

   </details>

2. **Cap total wall‑clock** with `abortSignal: AbortSignal.timeout(…)`.
   `requestTimeoutMs` bounds each segment, not a whole multi‑tool call.
3. **Own the retries.** Workspace‑backed turns are **never auto‑retried**: a
   stream‑loss error is `isRetryable` only when the failed turn created its
   chat _and_ had no workspace, no MCP servers, and no fresh uploads
   ([Timeouts](../README.md#timeouts--cancellation)). Re‑check quota headroom
   before retrying, or you re‑queue into the same wall.
4. **Watch the fleet.** [`watchChats`](../README.md#watching-chats) yields
   status changes for every chat **visible to the authenticated user** — run
   one watcher per identity for per‑tenant credentials, or use a credential
   that sees them all. Alert on chats in a non‑terminal status (e.g. `pending`)
   longer than your `requestTimeoutMs`. Seed and periodically reconcile against
   `GET /api/v2/chats`; don't trust the event stream alone.
   <details><summary>Why events alone miss stuck chats</summary>

   Reconnects resubscribe fresh (no cursor or replay). A chat already stuck
   before the watcher started — or one that transitioned during a gap — never
   emits an event to start your timer from.

   </details>

## Troubleshooting: unschedulable & stuck chats

Wire [`onTransportEvent`](../README.md#observability) into fleet telemetry; the
event sequence pinpoints _where_ a turn died. Expand the symptom you see.

<details><summary><code>segment:start</code> and <code>ws:open</code> fired, initial status events, then silence</summary>

No `message_part`, no `segment:settle`.

- **Likely cause:** if the chat's status is `pending` (or its workspace build
  is `pending`/`failed`), the workspace can't be scheduled — quota exhausted,
  no free provisioner, failing template. If the status is `running` with a
  healthy build, it may just be a slow model/tool step; silence alone doesn't
  prove scheduling.
- **Fix:** check quota headroom (`workspace-quota` endpoint) and the
  workspace's build — a quota failure logs `INSUFFICIENT_QUOTA`. Reclaim enough
  _credits_ for the planned build: stopping helps only for stop‑scoped costs;
  delete workspaces to reclaim persistent costs, or raise the group allowance.
  Set `requestTimeoutMs` so this fails loudly next time.

</details>

<details><summary><code>segment:settle</code> carries a <code>CoderChatError</code> mentioning the <code>requestTimeoutMs</code> budget</summary>

The event looks like
`error: { name: "CoderChatError", message: "…requestTimeoutMs budget…" }`.

- **Likely cause:** the per‑segment bound expired — wedged server, slow model,
  or an unschedulable workspace.
- **Fix:** inspect the workspace via the v2 API/UI. A `pending`/`failed` build
  means the previous symptom; `running` means the turn was genuinely slow —
  raise `requestTimeoutMs` for long tool work.

</details>

<details><summary>Repeated <code>ws:redial</code>, then a <code>CoderStreamError</code></summary>

`consecutiveFailures` climbs toward `maxConsecutiveFailures` (5; backoff
1 s → 2 s → 4 s → 8 s, ≈15 s of redialing without forward progress).

- **Likely cause:** the network path to the deployment is failing — not
  workspace scheduling (the server keeps generating through short gaps).
- **Fix:** fix connectivity. Mind [retry ownership](#preventing-stuck-turns):
  on workspace‑backed chats the error is `isRetryable: false`, so the replay
  decision is yours.

</details>

<details><summary><code>segment:settle</code> with <code>status: "error"</code> and an <code>error</code> payload</summary>

- **Likely cause:** the turn failed server‑side — a provider/model error, a
  tool failure, or a scheduling/build failure that terminated the turn instead
  of leaving it pending.
- **Fix:** the settle event's `error` carries only `{ name, message }`. To
  branch on `kind` / `retryable` / `statusCode`, catch the thrown
  `CoderChatError`: at the `generate()` call site, or — for `stream()` — around
  stream consumption, since mid‑stream failures surface on the stream, not from
  `await agent.stream()` ([Handling errors](../README.md#handling-errors)).
  Check the workspace build state to rule scheduling in or out.

</details>

<details><summary>Turn settled <code>status: "requires_action"</code>; follow‑up messages queue forever</summary>

- **Likely cause:** the loop ended on an unanswered client tool call.
- **Fix:** submit the stranded results or interrupt — see [rule 4 of the structured-output guide](./structured-output.md#4-settle-a-turn-that-stopped-on-a-tool-call). If a crash left the
  pause behind, reconcile effects first
  ([Make client tools crash-safe](./durable-workflows.md#make-client-tools-crash-safe)).

</details>

<details><summary><code>archive()</code> keeps returning 409 and rethrows after ~15 s</summary>

- **Likely cause:** the chat never settled server‑side — usually a stuck run
  still holding its workspace.
- **Fix:** `interrupt()` with a bounded signal, then re‑archive. If the run
  stays wedged, stop the workspace itself.

</details>
