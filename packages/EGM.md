# packages

## Overview

`packages/` holds the pnpm workspace packages: `pnpm-workspace.yaml` lists `packages/*`
[../pnpm-workspace.yaml:packages]. This folder has no source files of its own. Four packages
publish to npm and are versioned independently by release-please
[../release-please-config.json:packages]. Three of them target Vercel AI SDK v7 and do not
depend on each other. `@coder/ai-sdk-effect` depends on those three through `workspace:^`
[effect/package.json:dependencies]. The fifth package, `@coder/release-please-ai`, is private
and drives the release workflow [release-please-ai/package.json:private].

All four published packages are ESM only, require Node `>=22`, and build one entry point
(`src/index.ts`) to `dist/` with tsup. Each published package's `tsconfig.json` includes
`examples/` (and `scripts/` in sandbox), so `typecheck` compiles the example scripts. The
examples are not published, and release-please ignores them
[../release-please-config.json:exclude-paths].

## Subdirectories & Boundaries

- agent: [`./agent/EGM.md`](./agent/EGM.md) - `@coder/ai-sdk-agent`. `CoderAgent` (an AI SDK
  v7 `Agent`) and `CoderLanguageModel` (a `LanguageModelV4`) run turns on Coder Agents
  (chatd). One instance owns one active chat at a time. `resetSession` and retried fresh-chat
  failures start new chats. The transport is the chat REST API under
  `/api/v2/chats` (with a one-time `/api/experimental/chats` fallback) plus the per-chat
  `/stream` and per-user `/watch` WebSockets. Its replay, dedup and redial rules are
  deliberate design (see `src/coder/EGM.md` and `src/model/EGM.md`).
- effect: [`./effect/EGM.md`](./effect/EGM.md) - `@coder/ai-sdk-effect`. Bridges the agent,
  provider and sandbox packages to Effect 4 `effect/ai`: `CoderLanguageModel` and
  `CoderAgentModel` `LanguageModel` services, `AiError` mapping and retry classification,
  scoped workspace and session `Layer`s, and Effect Schema conversion. Build the siblings
  first (`pnpm -r build`): its typecheck and tests resolve their `dist/`.
- provider: [`./provider/EGM.md`](./provider/EGM.md) - `@coder/ai-sdk-provider`.
  `createCoder` returns an AI SDK provider over a Coder deployment's AI Gateway, at
  `${baseURL}${aiGatewayPath ?? "/api/v2/aibridge"}/<name>/v1`. It fronts an
  OpenAI-compatible surface and an Anthropic surface and picks one per model id. Embedding
  models throw `NoSuchModelError`.
- release-please-ai: [`./release-please-ai/EGM.md`](./release-please-ai/EGM.md) -
  `@coder/release-please-ai` (private). Runs release-please as a library and adds an
  Anthropic-written summary and highlights to a changelog section (`changelog-type: "ai"`)
  only when `ANTHROPIC_API_KEY` is set, the section has visible commits, and the model call
  succeeds with a non-empty summary or highlights. Otherwise it returns release-please's
  default notes unchanged, so the model never blocks a release.
  `.github/workflows/release-please.yml` runs its `src/cli.ts` on push to `main` to create
  tags, releases and release PRs, to write the outputs that the publish jobs read, and to
  re-run `action_required` workflow runs on the release PR branches.
- sandbox: [`./sandbox/EGM.md`](./sandbox/EGM.md) - `@coder/ai-sdk-sandbox`.
  `createCoderWorkspace` is an AI SDK harness sandbox provider (`"harness-sandbox-v1"`) that
  runs `HarnessAgent` sessions in Coder workspaces, in wrap mode or create mode.
  `CoderCliTransport` uses the `coder` CLI with OpenSSH. `CoderNativeTransport` uses the
  Coder REST API and a Node relay over a workspace-agent PTY WebSocket. `examples/template`
  holds a sample Coder Terraform template.
