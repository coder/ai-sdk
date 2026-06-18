# @coder/release-please-ai

AI-written release notes, generated **inside** [release-please](https://github.com/googleapis/release-please).

It plugs into release-please as a custom changelog generator: for every component
release, it keeps release-please's accurate, structured changelog and adds a short
editorial intro — a plain-language summary plus a few highlights — written by Claude.
release-please still owns the `CHANGELOG.md`, the release pull request, and the GitHub
Release; this package only enriches the notes it produces.

> Currently `private` (unpublished). The generator is repo-agnostic — designed to be published and reused across repositories.

## What you get

For a release whose commits are `feat(agent): add streaming responses (#42)`,
`fix(agent): stop dropping the final token (#43)`, `feat(agent)!: require Node 22 (#44)`,
release-please writes:

```markdown
## [0.2.0](https://github.com/coder/ai-sdk/compare/agent-v0.1.0...agent-v0.2.0) (2026-06-18)

Adds streaming response support and fixes a bug where the final token was dropped
when closing a stream. This release also raises the minimum supported runtime to
Node 22, which is a breaking change.

### Highlights

- Agent responses can now be streamed. ([#42](https://github.com/coder/ai-sdk/pull/42))
- Fixed an issue where the final token was dropped when a stream was closed. ([#43](https://github.com/coder/ai-sdk/pull/43))
- Breaking: Node 22 is now the minimum required version. ([#44](https://github.com/coder/ai-sdk/pull/44))

### ⚠ BREAKING CHANGES

- **agent:** require Node 22 (#44)

### Features

- **agent:** add streaming responses (#42)
  …
```

Everything from the version header down is release-please's standard output; only the
summary paragraph and **Highlights** list are AI-written. The model only writes prose —
the version header, section grouping, PR/commit links, and breaking-change list all come
from release-please, so there is nothing for it to get factually wrong.

## How it works

1. `release-please-config.json` sets `"changelog-type": "ai"`.
2. The CLI registers the generator (`registerChangelogNotes("ai", …)`) and then runs
   release-please. release-please only exposes its built-in `default`/`github` changelog
   types through its config and action; selecting a _custom_ type requires registering it
   in code first, so this package drives release-please's library API directly instead of
   the off-the-shelf action. The rest of the release pipeline (versioning, tags, the
   release PR, publishing) is unchanged.
3. For each component, release-please hands the generator the parsed, **already
   path-scoped** commits for that package. The generator:
   - delegates to release-please's own default changelog renderer for all structure, then
   - asks Claude for a `summary` + `highlights` and splices that block in just below the
     version header.

If the model can't run — no API key, a network/API error, or simply nothing
noteworthy in the release — the generator returns release-please's standard notes
unchanged. **A release is never blocked on the model.**

## Usage

### In CI (this repo)

Wired into `.github/workflows/release-please.yml`. The release job installs the workspace
and runs the CLI; it emits the same step outputs the stock release-please action does
(`<path>--release_created`, `--tag_name`, `--version`), so downstream publish jobs need no
changes.

**Required:** add an `ANTHROPIC_API_KEY` repository secret. Without it, releases still
succeed — they just use release-please's default notes.

### As a library

```ts
import { registerAiChangelogNotes } from "@coder/release-please-ai";
import { GitHub, Manifest } from "release-please";

registerAiChangelogNotes(); // must run before constructing the Manifest
const github = await GitHub.create({ owner, repo, token });
const manifest = await Manifest.fromManifest(github, "main");
await manifest.createPullRequests();
await manifest.createReleases();
```

### CLI directly

```sh
GITHUB_TOKEN=… GITHUB_REPOSITORY=coder/ai-sdk ANTHROPIC_API_KEY=… \
  pnpm --filter @coder/release-please-ai exec tsx src/cli.ts
```

## Configuration

The CLI is configured entirely through the environment:

| Variable                       | Required     | Default                         | Purpose                                       |
| ------------------------------ | ------------ | ------------------------------- | --------------------------------------------- |
| `GITHUB_TOKEN`                 | yes          | —                               | Token release-please uses for the GitHub API. |
| `GITHUB_REPOSITORY`            | yes          | set by Actions                  | `owner/repo`.                                 |
| `ANTHROPIC_API_KEY`            | for AI notes | —                               | Falls back to default notes when unset.       |
| `RELEASE_NOTES_MODEL`          | no           | `claude-opus-4-8`               | Any Claude model id.                          |
| `RELEASE_PLEASE_TARGET_BRANCH` | no           | `main`                          | Release branch.                               |
| `RELEASE_PLEASE_CONFIG_FILE`   | no           | `release-please-config.json`    | Path to the config.                           |
| `RELEASE_PLEASE_MANIFEST_FILE` | no           | `.release-please-manifest.json` | Path to the manifest.                         |

The headings and which commit types are shown/hidden come from `changelog-sections` in
`release-please-config.json` — the same source release-please uses — so the AI notes and
the changelog always stay in sync.

> The published release-please JSON schema only lists `default` and `github` for
> `changelog-type`, so editors may flag `"ai"`. That warning is cosmetic; the value is
> resolved at runtime once the generator is registered.

## Behavior & cost

release-please rebuilds a release's notes whenever it opens or updates that component's
release PR — i.e. on pushes to `main` that change a releasable package — so the notes stay
current while the PR is open. Generation is commit-driven (no diffs), so it's cheap:
roughly a few cents per run on Opus 4.8.

## Development

```sh
pnpm --filter @coder/release-please-ai typecheck
pnpm --filter @coder/release-please-ai test       # unit tests; hermetic, model is mocked
pnpm --filter @coder/release-please-ai test:e2e   # live model call; skipped unless ANTHROPIC_API_KEY is set
```

Source layout:

| File                     | Responsibility                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `src/changelog-notes.ts` | The release-please `ChangelogNotes` implementation and its registration.  |
| `src/cli.ts`             | Runs release-please with the generator registered; emits Actions outputs. |
| `src/generate.ts`        | The model call (`generateObject`) and the editorial markdown renderer.    |
| `src/prompt.ts`          | System prompt and commit-to-prompt formatting.                            |
| `src/sections.ts`        | Section definitions and visible-commit filtering.                         |
| `src/index.ts`           | Public library exports.                                                   |
