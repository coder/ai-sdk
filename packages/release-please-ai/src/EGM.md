# @coder/release-please-ai source (`src`)

## Overview

This directory runs release-please as a library and adds an AI-written editorial intro
(a summary and highlights) to each component's changelog section. `AiChangelogNotes`
delegates the changelog structure to release-please's `DefaultChangelogNotes` and splices
the editorial in beneath the version heading. `cli.ts` is the CI harness: it registers the
hook, creates releases and release PRs, writes GitHub Actions outputs, and restarts release
PR workflow runs that wait at `action_required`.

## Interface

- `index.ts` re-exports `AI_CHANGELOG_TYPE`, `AiChangelogNotes` and
  `registerAiChangelogNotes` from `./changelog-notes.js`, where they are defined. Nothing
  else is re-exported [changelog-notes.ts:AI_CHANGELOG_TYPE]
- `AI_CHANGELOG_TYPE` is `"ai"`, the `changelog-type` value for
  `release-please-config.json` [changelog-notes.ts:AI_CHANGELOG_TYPE]
- `AiChangelogNotes` implements release-please's `ChangelogNotes`. It has
  `constructor(options: ChangelogNotesFactoryOptions)` and
  `buildNotes(commits, options): Promise<string>` [changelog-notes.ts:AiChangelogNotes]
- `registerAiChangelogNotes()` registers an `AiChangelogNotes` builder under `"ai"`
  [changelog-notes.ts:registerAiChangelogNotes]
- `runReleasePlease(loadManifest, onReleasesCreated?)` returns
  `{ pullRequests, releases, pullRequestError? }` [cli.ts:runReleasePlease]
- `rerunActionRequiredChecks(client, repository, pullRequests, options?)` returns the
  number of distinct workflow runs it restarted [check-reruns.ts:rerunActionRequiredChecks]
- `generateEditorial(input)` calls the model and returns `ReleaseNotes`
  [generate.ts:generateEditorial]
- `renderEditorial(notes, ctx)` renders the editorial Markdown block
  [generate.ts:renderEditorial]
- `ReleaseNotesSchema` is the zod schema
  `{ summary: string, highlights: { text: string, prNumber: number | null }[] }`.
  `ReleaseNotes` is its inferred type [generate.ts:ReleaseNotesSchema]
- `MODEL_ID` is `process.env.RELEASE_NOTES_MODEL ?? "claude-opus-4-8"` [generate.ts:MODEL_ID]
- `SYSTEM_PROMPT` holds the editor instructions. `renderUserPrompt(input)` renders the
  commit list [prompt.ts:renderUserPrompt]
- `DEFAULT_SECTIONS` lists release-please's default sections. `build`, `ci`, `test`,
  `style` and `chore` are marked `hidden` [sections.ts:DEFAULT_SECTIONS]
- `visibleCommits(commits, sections?)` drops commits whose type is in a hidden section
  [sections.ts:visibleCommits]
- `CommitView`, `EditorialInput` and `EditorialContext` are the data types passed to the
  prompt and render steps [types.ts:EditorialInput]
- Internal (not exported) in `changelog-notes.ts`: `toCommitView`, `injectAfterHeader`
  [changelog-notes.ts:injectAfterHeader]
- Internal (not exported) in `generate.ts`: `flatten` [generate.ts:flatten]
- Internal (not exported) in `cli.ts`: `required`, `main`, `emitReleaseOutputs`,
  `emitPullRequestOutputs`, `writeOutputs`, `warnNonFatal` [cli.ts:main]

## Invariants

- The editorial step is skipped (no model call) when no visible commits exist or when
  `process.env.ANTHROPIC_API_KEY` is unset or empty [changelog-notes.ts:AiChangelogNotes]
- Errors from `generateEditorial` or `renderEditorial` are caught and logged. Then
  `buildNotes` returns the default notes unchanged. Errors from the base
  `DefaultChangelogNotes.buildNotes` are not caught [changelog-notes.ts:AiChangelogNotes]
- `injectAfterHeader` matches `/^#{1,6} .*(?:\r?\n|$)/` (no `m` flag), so it inserts the
  editorial only after a heading on the first line of the notes. If the notes do not start
  with a heading, it appends the editorial after the notes
  [changelog-notes.ts:injectAfterHeader]
- `renderEditorial` collapses all whitespace in model text to single spaces, so each model
  text stays on one line. Highlights get a `- ` prefix. The summary line gets no prefix, so
  a summary that starts with one to six `#` characters and a space still renders as a
  heading line. It drops empty
  highlights, adds `### Highlights` only when one remains, and returns `""` when there is
  nothing to render [generate.ts:renderEditorial]
- PR links use `${host}/${owner}/${repository}/pull/${n}`. `host` defaults to
  `"https://github.com"` and loses trailing slashes [generate.ts:renderEditorial]
- `visibleCommits` uses `DEFAULT_SECTIONS` only when `sections` is missing or empty
  [sections.ts:visibleCommits]
- `main` requires `GITHUB_TOKEN` and `GITHUB_REPOSITORY` (`"owner/repo"`). It reads
  `RELEASE_PLEASE_TARGET_BRANCH` (default `"main"`), `RELEASE_PLEASE_CONFIG_FILE`
  (default `"release-please-config.json"`) and `RELEASE_PLEASE_MANIFEST_FILE` (default
  `".release-please-manifest.json"`) [cli.ts:main]
- `required(name)` throws `Missing required environment variable: <name>` when the
  variable is unset or empty [cli.ts:required]
- `main` calls `registerAiChangelogNotes()` before it builds the `Manifest`, so
  `changelog-type: "ai"` resolves [cli.ts:main]
- `runReleasePlease` runs in this order: load manifest, `createReleases`, call
  `onReleasesCreated`, load the manifest again, `createPullRequests`. Errors from the
  second load or from `createPullRequests` are returned as `pullRequestError` with
  `pullRequests: []`. Earlier errors propagate [cli.ts:runReleasePlease]
- When `pullRequestError` is set, `main` writes a warning and skips the check restarts.
  A failure in `rerunActionRequiredChecks` is also only a warning. Any other error in
  `main` sets `process.exitCode = 1` [cli.ts:main]
- `rerunActionRequiredChecks` returns 0 for an empty PR list without validating its other
  arguments. Otherwise it throws when owner or repo is empty, when `attempts` is not a
  positive integer, when `delayMs` is negative or not finite, or when a PR has no head
  branch or head SHA
  [check-reruns.ts:rerunActionRequiredChecks]
- It polls `attempts` rounds (default 15, `DEFAULT_ATTEMPTS`) with `delayMs` between rounds
  (default 1,000 ms, `DEFAULT_DELAY_MS`). It restarts a run only when `head_sha` equals the
  PR head SHA and `conclusion` is `"action_required"`, and each run id at most once
  [check-reruns.ts:rerunActionRequiredChecks]

## Side Effects

- Importing `cli.ts` runs `main()` unless `process.env.NODE_ENV` is `"test"` [cli.ts:main]
- `main` calls the GitHub API through release-please (`GitHub.create`,
  `Manifest.fromManifest`, `createReleases`, `createPullRequests`). This creates tags,
  GitHub releases and release PRs [cli.ts:main]
- `generateEditorial` sends a request to Anthropic through `generateObject` with
  `anthropic(MODEL_ID)` [generate.ts:generateEditorial]
- `anthropic` is the default `@ai-sdk/anthropic` instance. It reads `ANTHROPIC_API_KEY`,
  and `ANTHROPIC_BASE_URL` when set, from the environment [generate.ts:generateEditorial]
- `MODEL_ID` reads `RELEASE_NOTES_MODEL` once, at module load [generate.ts:MODEL_ID]
- `registerAiChangelogNotes` adds a builder to release-please's global registry
  [changelog-notes.ts:registerAiChangelogNotes]
- `rerunActionRequiredChecks` calls `pulls.get`, `actions.listWorkflowRunsForRepo`
  (`event: "pull_request"`, `per_page: 20`) and `actions.reRunWorkflow`
  [check-reruns.ts:rerunActionRequiredChecks]
- `writeOutputs` appends `key=value` lines to the file named by `GITHUB_OUTPUT` when it is
  set, and echoes them to stderr [cli.ts:writeOutputs]
- Output keys: `releases_created`, and per release `<path>--release_created`,
  `<path>--tag_name` and `<path>--version` [cli.ts:emitReleaseOutputs]
- Output key `prs_created` [cli.ts:emitPullRequestOutputs]
- `warnNonFatal` writes a `::warning title=release-please::` annotation to stdout and the
  error to stderr [cli.ts:warnNonFatal]

## Verification

- Run: `pnpm --filter @coder/release-please-ai test`
- Run: `pnpm --filter @coder/release-please-ai typecheck`
- Unit tests: `packages/release-please-ai/test/unit/changelog-notes.test.ts`,
  `packages/release-please-ai/test/unit/check-reruns.test.ts`,
  `packages/release-please-ai/test/unit/cli.test.ts`,
  `packages/release-please-ai/test/unit/editorial.test.ts`
