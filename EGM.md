# coder/ai-sdk Blueprint

## System Overview

`coder/ai-sdk` is the monorepo for Coder's Vercel AI SDK packages [package.json:description].
It is a pnpm workspace over `packages/*` [pnpm-workspace.yaml:packages]. `mise.toml` pins the
toolchain (Node, pnpm, actionlint, zizmor) [mise.toml:tools], and the root `package.json` pins
`packageManager` and requires Node `>=22` [package.json:packageManager] [package.json:engines].
Human docs: [README.md](./README.md), [CONTRIBUTING.md](./CONTRIBUTING.md) and
[AGENTS.md](./AGENTS.md).

The four published packages are libraries. Their network effects happen in the process that
imports them, against the Coder deployment that the caller configures.
`@coder/release-please-ai` is a private CLI. Its only caller in the repo is the release
workflow:

| Package                    | Talks to                     | Through                                                                                   |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `@coder/ai-sdk-provider`   | Coder AI Gateway             | HTTP from `@ai-sdk/openai-compatible` and `@ai-sdk/anthropic` sub-providers               |
| `@coder/ai-sdk-agent`      | Coder Agents (chatd)         | REST under `/api/v2/chats`, plus the per-chat `/stream` and per-user `/watch` WebSockets  |
| `@coder/ai-sdk-sandbox`    | Coder workspaces             | `coder` CLI and OpenSSH child processes, or REST `/api/v2/...` plus a PTY WebSocket relay |
| `@coder/ai-sdk-effect`     | The three packages above     | In-process calls (`workspace:^` dependencies)                                             |
| `@coder/release-please-ai` | GitHub API and Anthropic API | release-please and Octokit, in the release workflow only                                  |

`tools/oxlint` runs only at lint time. It has no runtime effects.

## Subdirectories & System Boundaries

- packages: [`./packages/EGM.md`](./packages/EGM.md) - The five workspace packages. Four
  publish to npm (`agent`, `effect`, `provider`, `sandbox`) and one is private
  (`release-please-ai`). Only `effect` depends on sibling packages.
- tools: [`./tools/EGM.md`](./tools/EGM.md) - Repo-local tooling: the vendored anti-slop oxlint
  plugin that `pnpm lint` loads through `.oxlintrc.json` `jsPlugins`. Its contract is
  `tools/oxlint/EGM.md`, because `tools/oxlint/anti-slop/` stays byte-identical to upstream.

## Global Invariants

- Build before effect: `pnpm -r build` comes first, because effect's typecheck and tests
  resolve the other packages' `dist/` through `workspace:^` [AGENTS.md:Validation gates].
- Two TypeScript majors on purpose: `typecheck` uses TypeScript 7 from the `typescript-7`
  alias, and the tsup packages keep `typescript` on `@typescript/typescript6` for the `.d.ts`
  build [AGENTS.md:Repo shape].
- Effect release ordering: pnpm publishes each `workspace:^` dependency as `^<sibling version
  in the released commit>`. If an effect change needs an unreleased sibling change, release
  that sibling first [AGENTS.md:Repo shape].
- One zod copy: `pnpm-workspace.yaml` overrides `zod` to a single version so the AI SDK chain
  shares one `@ai-sdk/provider-utils` and keeps `HarnessAgent` type identity
  [pnpm-workspace.yaml:overrides].
- Lint and format: oxlint enables the `correctness` category, `typescript/no-explicit-any`,
  `typescript/no-non-null-assertion` (off in `test/` and `scripts/`) and the 15 `anti-slop/*`
  rules as errors, with per-rule ratchet lists for legacy files [.oxlintrc.json:rules]
  [.oxlintrc.json:overrides]. oxfmt also formats Markdown, including TypeScript in fenced code
  blocks, so run `pnpm format` after editing any `.md` file (EGM.md files included)
  [AGENTS.md:Validation gates].
- PR titles are Conventional Commits. PRs are squash-merged through the merge queue, and
  release-please derives versions and changelogs from those titles
  [AGENTS.md:Commits, PRs, merging].
- release-please owns every `CHANGELOG.md`. It ignores `packages/*/examples`, so commits that
  touch only examples cut no release [AGENTS.md:Releases]
  [release-please-config.json:exclude-paths].
- The `packages/agent` transport invariants (`after_id` cursor reuse, delta replay from `seq`
  1, terminal unparseable `/stream` frames) are deliberate design. Do not "fix" them
  [AGENTS.md:Transport invariants (`packages/agent`)].

## Global Side Effects

- Consumer processes: HTTP and WebSocket calls to the configured Coder deployment (AI Gateway,
  chat API, workspace API), and `coder` or `ssh` child processes when the sandbox CLI transport
  is used. See each package contract under [`./packages/EGM.md`](./packages/EGM.md).
- Release workflow: on push to `main`, `.github/workflows/release-please.yml` runs
  `@coder/release-please-ai` to create release tags, GitHub releases and release PRs, and to
  re-run `action_required` workflow runs on the release PR branches. The publish jobs publish
  released packages to npm with provenance
  [.github/workflows/release-please.yml:jobs.release-please] [AGENTS.md:Releases].
- Live test suites: the agent and effect e2e suites call a live deployment when `CODER_URL`
  and `CODER_SESSION_TOKEN` are set. The effect suite sits inside its default `test` include,
  so `pnpm -r test` runs it when those variables are set. The release-please-ai e2e suite calls
  the Anthropic API when `ANTHROPIC_API_KEY` is set. See the package contracts.

## System Verification

Run from the repo root, in this order:

```sh
pnpm -r build
pnpm check
pnpm -r test
```

- `pnpm check` runs the oxfmt format check, oxlint and every package typecheck
  [package.json:scripts].
- CI (`.github/workflows/ci.yml`) also runs `pnpm publint` and `pnpm attw` for sandbox,
  provider and effect, and lints the workflows with `actionlint` and `zizmor`. Its aggregate
  `Required` job is the single required status check [AGENTS.md:Commits, PRs, merging].
- Optional live check: `pnpm --filter @coder/ai-sdk-agent test:e2e`, which self-skips unless
  `CODER_URL` and `CODER_SESSION_TOKEN` are set.
