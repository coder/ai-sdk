# @coder/release-please-ai (`packages/release-please-ai`)

## Overview

`@coder/release-please-ai` is a private workspace package. npm does not publish it. It runs
release-please as a library and adds an AI-written editorial intro to each changelog
section. The release workflow runs it from source with `tsx` to open release PRs, tag
releases and write the per-package outputs that the publish jobs read. For human docs, see
[README.md](./README.md).

## Interface

- [src/EGM.md](./src/EGM.md): the `changelog-type: "ai"` hook (`AiChangelogNotes`,
  `registerAiChangelogNotes`, `AI_CHANGELOG_TYPE`) and the CI harness `src/cli.ts`
  (`runReleasePlease`, `rerunActionRequiredChecks`).
- The package is `"private": true` and has no `main`, `exports`, `bin` or `files` key
  [package.json:private]
- Scripts: `typecheck` (`tsc --noEmit`), `test` and `test:unit` (`vitest run test/unit`),
  `test:e2e` (`vitest run test/e2e`), `release` (`tsx src/cli.ts`) [package.json:scripts]
- CI runs `pnpm --filter @coder/release-please-ai exec tsx src/cli.ts` in the step
  `id: release`, with `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and `ANTHROPIC_API_KEY` set
  [../../.github/workflows/release-please.yml:jobs.release-please]
- The workflow reads the step outputs `packages/<pkg>--release_created` as the job outputs
  `sandbox_released`, `agent_released`, `provider_released` and `effect_released`
  [../../.github/workflows/release-please.yml:jobs.release-please.outputs]

## Invariants

- Dependencies: `release-please` with a `~` range (patch updates only), `@ai-sdk/anthropic`,
  `ai`, and an exact `zod` pin. `package.json` holds the current versions
  [package.json:dependencies]
- `src/` deep-imports `release-please/build/src/...` paths, so a `release-please` upgrade
  must keep that build layout. `changelog-notes.ts` imports `DefaultChangelogNotes`
  [src/changelog-notes.ts:AiChangelogNotes]
- `check-reruns.ts` deep-imports the `GitHubApi` type
  [src/check-reruns.ts:rerunActionRequiredChecks]
- Vitest includes `test/**/*.test.ts`, which matches both unit and e2e files. Only the
  `test/unit` path argument in the `test` script keeps the e2e test out. Timeouts are 60 s
  [vitest.config.ts:default]
- The e2e suite runs only when `ANTHROPIC_API_KEY` is set and non-empty:
  `describe.skipIf(!hasKey)` with `hasKey = Boolean(process.env.ANTHROPIC_API_KEY)`
  [test/e2e/generate.e2e.test.ts:hasKey]
- The CI job runs only on `push` events, with `actions`, `contents` and `pull-requests`
  write permissions [../../.github/workflows/release-please.yml:jobs.release-please]
- Node `>=22` is required [package.json:engines]

## Side Effects

- The CI step creates release tags, GitHub releases and release PRs, writes changelogs,
  and restarts release PR workflow runs (see [src/EGM.md](./src/EGM.md))
  [../../.github/workflows/release-please.yml:jobs.release-please]
- `test:e2e` sends live requests to the Anthropic API when `ANTHROPIC_API_KEY` is set
  [test/e2e/generate.e2e.test.ts:hasKey]

## Verification

- Run: `pnpm --filter @coder/release-please-ai test`
- Run: `pnpm --filter @coder/release-please-ai typecheck`
- Optional live check (needs `ANTHROPIC_API_KEY`): `pnpm --filter @coder/release-please-ai test:e2e`
- Unit tests: `packages/release-please-ai/test/unit/` (`changelog-notes.test.ts`,
  `check-reruns.test.ts`, `cli.test.ts`, `editorial.test.ts`)
