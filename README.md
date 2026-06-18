# coder/ai-sdk

Coder's integrations with the [Vercel AI SDK](https://ai-sdk.dev), in one monorepo.

| Package                                       | npm                                                                                                                   | What it is                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`@coder/ai-sdk-sandbox`](./packages/sandbox) | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-sandbox.svg)](https://www.npmjs.com/package/@coder/ai-sdk-sandbox) | A sandbox provider that runs the AI SDK v7 **HarnessAgent** (Claude Code / Codex) inside a **Coder workspace**.         |
| [`@coder/ai-sdk-agent`](./packages/agent)     | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)     | A Vercel AI SDK–compliant **`Agent`** backed by Coder `chatd` — `new CoderAgent()` gives you `generate()` / `stream()`. |

Each package has its own README with usage and API docs.

> Status: both packages are pre-1.0 and track experimental upstreams (the AI SDK
> harness is on `canary`; Coder's chat API is experimental). Expect change.

## Repository layout

```
packages/
  sandbox/   @coder/ai-sdk-sandbox   (Vercel AI SDK v7 / @ai-sdk/harness)
  agent/     @coder/ai-sdk-agent     (Vercel AI SDK v6 / ai)
```

The two packages deliberately target different AI SDK generations; pnpm keeps
their dependency trees isolated, so they coexist without forcing a single
`ai` version.

## Development

Toolchain versions (node, pnpm) are pinned in [`mise.toml`](./mise.toml) and
locked in `mise.lock`. With [mise](https://mise.jdx.dev) installed:

```bash
mise install          # install the pinned node + pnpm
pnpm install          # install workspace dependencies
```

Quality and build commands run from the repo root and fan out across packages:

```bash
pnpm lint             # oxlint across the whole workspace
pnpm format           # oxfmt (write); `pnpm format:check` to verify
pnpm typecheck        # tsc --noEmit per package
pnpm test             # vitest per package
pnpm build            # tsup per package
pnpm check            # format:check + lint + typecheck
```

Lint and format are centralized at the root via [oxc](https://oxc.rs)
(`oxlint` + `oxfmt`); build, typecheck, and test live in each package.

Target one package with pnpm's `--filter`:

```bash
pnpm --filter @coder/ai-sdk-agent test
pnpm --filter @coder/ai-sdk-sandbox build
```

## Releases

Releases are automated with
[release-please](https://github.com/googleapis/release-please) in manifest mode
— each package is versioned, tagged, and published to npm independently from
[Conventional Commit](https://www.conventionalcommits.org) history.

Because the repo squash-merges, **the PR title becomes the release commit**, so
PR titles must follow Conventional Commits and are validated in CI. Scope a
change to a package with its name:

```
feat(sandbox): add port leasing
fix(agent): handle interrupt during stream
ci: bump actions
```

release-please opens a release PR per package; merging it tags the package
(`sandbox-vX.Y.Z` / `agent-vX.Y.Z`) and publishes to npm with provenance.

## License

[Apache-2.0](./LICENSE)
