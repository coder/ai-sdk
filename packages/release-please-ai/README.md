# @coder/release-please-ai

AI-written release notes, generated **inside**
[release-please](https://github.com/googleapis/release-please). For each
component release, Claude adds a plain-language summary and a few highlights on
top of release-please's structured changelog.

release-please still owns `CHANGELOG.md`, the release PR, and the GitHub
Release.

> Currently `private` (unpublished), but repo-agnostic: designed to be
> published and reused across repositories.

## What you get

For a release with commits `feat(agent): add streaming responses (#42)`,
`fix(agent): stop dropping the final token (#43)`, and
`feat(agent)!: require Node 22 (#44)`, release-please writes:

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

Only the summary paragraph and **Highlights** (including the PR number each
highlight links to) are AI-written, and they can be wrong: the prompt tells the
model not to invent changes or PR numbers, but nothing checks its output against
the commits. Headers, sections, per-commit links, and the breaking-change list
are release-please's standard output; the model's text is inserted beneath the
version header and cannot change them.

**A release is never blocked on the model.** If it can't run (no API key, a
network/API error, or nothing noteworthy in the release), the generator returns
release-please's standard notes unchanged.

## How it works

1. `release-please-config.json` sets `"changelog-type": "ai"`. Editors may flag
   the value (the published schema lists only `default`/`github`); that is
   cosmetic, as it resolves at runtime once the generator is registered.
2. The CLI registers this custom changelog generator
   (`registerChangelogNotes("ai", …)`), then runs release-please through its
   library API.
3. For each component, the generator receives the parsed, **already
   path-scoped** commits. It renders the structure with release-please's
   default renderer, asks Claude for a `summary` + `highlights`, and splices
   them in just below the version header.

Versioning, tags, the release PR, and publishing are unchanged.

<details>
<summary>Why this drives release-please's library API instead of the action</summary>

release-please only exposes its built-in `default`/`github` changelog types
through its config and action. Selecting a _custom_ type requires registering
it in code first, so this package drives the library API directly instead of
the off-the-shelf action.

</details>

## Usage

### In CI (this repo)

The release job in `.github/workflows/release-please.yml` installs the
workspace and runs the CLI.

- **Required:** an `ANTHROPIC_API_KEY` repository secret. Without it, releases
  still succeed with default notes.
- Step outputs match the stock release-please action
  (`<path>--release_created`, `--tag_name`, `--version`), so downstream publish
  jobs need no changes.

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

The CLI is configured entirely through environment variables:

| Variable                       | Required     | Default                         | Purpose                                       |
| ------------------------------ | ------------ | ------------------------------- | --------------------------------------------- |
| `GITHUB_TOKEN`                 | yes          | —                               | Token release-please uses for the GitHub API. |
| `GITHUB_REPOSITORY`            | yes          | set by Actions                  | `owner/repo`.                                 |
| `ANTHROPIC_API_KEY`            | for AI notes | —                               | Falls back to default notes when unset.       |
| `RELEASE_NOTES_MODEL`          | no           | `claude-opus-4-8`               | Any Claude model id.                          |
| `RELEASE_PLEASE_TARGET_BRANCH` | no           | `main`                          | Release branch.                               |
| `RELEASE_PLEASE_CONFIG_FILE`   | no           | `release-please-config.json`    | Path to the config.                           |
| `RELEASE_PLEASE_MANIFEST_FILE` | no           | `.release-please-manifest.json` | Path to the manifest.                         |

Section headings and visible commit types come from `changelog-sections` in
`release-please-config.json`, so the AI notes and the changelog always stay in
sync.

## Behavior & cost

- **Regeneration:** whenever release-please opens or updates a component's
  release PR (pushes to `main` that change a releasable package), so notes stay
  current while the PR is open.
- **Cost:** commit-driven (no diffs), roughly a few cents per run on Opus 4.8.

## Development

```sh
pnpm --filter @coder/release-please-ai typecheck
pnpm --filter @coder/release-please-ai test       # unit tests; hermetic, model is mocked
pnpm --filter @coder/release-please-ai test:e2e   # live model call; skipped unless ANTHROPIC_API_KEY is set
```

<details>
<summary>Source layout</summary>

| File                     | Responsibility                                                            |
| ------------------------ | ------------------------------------------------------------------------- |
| `src/changelog-notes.ts` | The release-please `ChangelogNotes` implementation and its registration.  |
| `src/cli.ts`             | Runs release-please with the generator registered; emits Actions outputs. |
| `src/generate.ts`        | The model call (`generateObject`) and the editorial markdown renderer.    |
| `src/prompt.ts`          | System prompt and commit-to-prompt formatting.                            |
| `src/sections.ts`        | Section definitions and visible-commit filtering.                         |
| `src/index.ts`           | Public library exports.                                                   |

</details>
