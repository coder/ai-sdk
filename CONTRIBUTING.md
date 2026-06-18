# Contributing

`coder/ai-sdk` is a pnpm monorepo of two independent, independently-published
packages — see the [README](./README.md) for what each one is. The two target
different Vercel AI SDK generations (`@coder/ai-sdk-sandbox` on v7,
`@coder/ai-sdk-agent` on v6); pnpm isolates their dependency trees, so both `ai`
versions coexist without conflict.

## Setup

The toolchain — node, pnpm, and the workflow linters — is pinned in
[`mise.toml`](./mise.toml) and locked in `mise.lock`. With
[mise](https://mise.jdx.dev) installed:

```bash
mise install     # install the pinned toolchain
pnpm install     # install workspace dependencies
```

## Commands

Everything runs from the repo root:

```bash
pnpm check       # the CI gate: format check + lint + typecheck
pnpm test        # run tests
pnpm build       # build every package
pnpm format      # auto-format with oxfmt
```

Lint and format are centralized at the root via [oxc](https://oxc.rs) (`oxlint` +
`oxfmt`) and cover the whole tree at once; typecheck, test, and build fan out to
each package. To work on just one, use pnpm's `--filter`:

```bash
pnpm --filter @coder/ai-sdk-agent test
pnpm --filter @coder/ai-sdk-sandbox build
```

GitHub Actions workflows are linted with [`actionlint`](https://github.com/rhysd/actionlint)
and audited with [`zizmor`](https://docs.zizmor.sh) (both pinned in `mise.toml`);
run them locally with `actionlint` and `zizmor .github/workflows`.

## Commits & pull requests

PRs are **squash-merged**, and the PR title becomes the commit on `main` — which is
what drives releases. So the **PR title must be a valid [Conventional Commit][cc]**
(CI enforces it). Use the package's short name as the scope, or omit the scope for
repo-wide changes:

```text
feat(sandbox): add port leasing
fix(agent): handle interrupt mid-stream
ci: bump actions
```

## Releases

Releases are fully automated with
[release-please](https://github.com/googleapis/release-please) — no manual version
bumps or `npm publish`. It reads Conventional Commit history and opens a release PR
per package; merging that PR versions the package, tags it (`sandbox-vX.Y.Z` /
`agent-vX.Y.Z`), and publishes to npm with provenance. The two packages version and
release independently.

[cc]: https://www.conventionalcommits.org
