# AGENTS.md

Operational knowledge for agents (and humans) working on `coder/ai-sdk`. For
contributor setup and command details, see [CONTRIBUTING.md](./CONTRIBUTING.md);
this file covers what you need to operate the repo without tripping over it.

## Repo shape

- pnpm workspace (`packages/*`). Toolchain (Node, pnpm, actionlint, zizmor) is
  pinned in `mise.toml` and locked in `mise.lock` — use `mise install`.
- Three independently versioned npm packages, all targeting Vercel AI SDK v7:
  `@coder/ai-sdk-agent`, `@coder/ai-sdk-provider`, `@coder/ai-sdk-sandbox`.
- One private package: `packages/release-please-ai` — release-please run as a
  library with AI-generated changelog notes; it drives the release workflow.

## Validation gates

Run before every push:

- `pnpm check` — oxfmt format check + oxlint + typecheck (the CI lint gate).
- `pnpm -r build` and `pnpm -r test`.
- Live e2e (optional; needs a real deployment):
  `cd packages/agent && npx vitest run test/e2e` — self-skips unless
  `CODER_URL` and `CODER_SESSION_TOKEN` are set.

CI additionally runs `pnpm publint` and `pnpm attw` (publish hygiene for
sandbox + provider) and lints workflows with `actionlint` + `zizmor`.

Gotchas:

- **oxfmt formats Markdown too — including TypeScript inside fenced code
  blocks.** After editing any `.md`, run `pnpm format` or `pnpm check` fails.
- The vendored [anti-slop](./tools/oxlint/anti-slop/) oxlint rules reject
  low-evidence "clever" patterns — e.g. `no-conditional-empty-object-spread`
  bans `...(cond ? { x } : {})`. Write code imperatively: build the object,
  then conditionally assign. Ratchet policy is in CONTRIBUTING.md.

## Commits, PRs, merging

- **Conventional Commit PR titles are load-bearing.** PRs are squash-merged,
  the title becomes the commit on `main`, and release-please derives versions
  and changelogs from those commits. `pr-title.yml` validates titles (scope
  `sandbox` / `agent` / `provider` or none; subject starts lowercase, no
  trailing period).
- **Merge only through the merge queue** (squash). Auto-merge is disabled; if
  `gh pr merge` lacks queue support, use GraphQL `enqueuePullRequest`.
- The single required status check is the aggregate `Required` job in
  `ci.yml`; it also runs in the merge queue (`merge_group`).

## Review protocol

Maintainer agents run BOTH review loops on every PR until each is clean on the
current head:

1. Comment exactly `@codex review`.
2. Comment exactly `@codex security review` (a separate loop).

- Re-trigger both after every push — a clean verdict only counts for the head
  it names.
- A connector comment saying "Something went wrong" / "Unknown error" is an
  errored round: it never produces a verdict. Re-trigger that loop immediately.
- When scripting a watcher: the clean-verdict phrase and the
  `Reviewed commit: <sha>` line live on **different lines of one comment** —
  match per-comment, not per-line. Paginate comment/review fetches, and derive
  `created_at` cutoffs from the trigger comment's actual timestamp.

## Releases

Merging a release-please PR (`chore(<component>): release X.Y.Z`) tags
`<component>-vX.Y.Z` and publishes to npm via OIDC trusted publishing
(`.github/workflows/release-please.yml`). No manual publishing; release-please
owns `CHANGELOG.md` (excluded from oxfmt) — never hand-edit it.

Known quirks when several release PRs are open:

- Merging one release PR makes release-please force-refresh the sibling
  release PR branches, which **silently dequeues them from the merge queue**
  (no error; the PR still shows clean/open). Enqueue release PRs serially and
  re-verify/re-enqueue after each merge.
- A refreshed branch resets CI, and its runs can stick at `action_required`
  (workflow-approval gate) indefinitely. Check `gh run list --branch <branch>`
  and approve via `gh api -X POST repos/{owner}/{repo}/actions/runs/<id>/approve`.
- `gh pr checks --watch` errors with "no checks reported" until CI starts on
  the refreshed head — poll with a grace loop until checks appear.
- A release tagged on GitHub but never published to npm is recovered via
  `workflow_dispatch` on `release-please.yml` with the release tag.

## Transport invariants (`packages/agent`)

Deliberate design — do not "fix" these. The authoritative protocol docs are
the doc comments in `packages/agent/src/coder/ws.ts` (stream, replay, redial)
and `packages/agent/src/model/translate.ts` (dedup, revision reconciliation);
unit tests under `packages/agent/test/unit/` pin the behavior.

- The `after_id` cursor refers only to committed `message` ids. `message_part`
  deltas carry no message id and replay from `seq` 1 on every (re)connection,
  so a cursor can never advance past a delta — and redials deliberately reuse
  the turn's original cursor (an advanced one would drop same-id revision
  snapshots).
- On the per-chat `/stream` (`streamChatEvents`), an unparseable frame is
  **terminal by design**: a redial replays from the original cursor and would
  deliver the same frame forever. The non-replaying global `/watch` redials
  past malformed frames instead.
- `TurnTranslator` keeps a per-message emitted-content ledger to reconcile
  replays and revisions; consumers must tolerate repeated `message` snapshots.

## Docs conventions

- Lean on [Diátaxis](https://diataxis.fr) (tutorial / how-to / reference /
  explanation) where it fits.
- **README code snippets must typecheck.** Package tsconfigs include
  `examples/`: assemble the snippets into a scratch file there, run
  `pnpm --filter <pkg> typecheck`, then delete the scratch file.
- Platform-behavior claims in docs state their verification tier in the PR
  body: verified against source, verified live against a deployment, or
  upstream-docs-only.
