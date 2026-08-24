# Contributing

`coder/ai-sdk` is a pnpm monorepo of three independent, independently-published
packages — `@coder/ai-sdk-sandbox`, `@coder/ai-sdk-agent`, and
`@coder/ai-sdk-provider`; see the [README](./README.md) for what each one is.
All three target Vercel AI SDK v7, and pnpm keeps their dependency trees
isolated.

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

### The anti-slop lint rules

On top of oxlint's built-in rules, the repo enforces
[anti-slop](https://github.com/dmmulroy/anti-slop) — opinionated rules that
reject low-evidence TypeScript patterns (unjustified type assertions, `unknown`
in signatures, ad hoc `typeof` narrowing, and similar). The plugin is
**vendored** at [`tools/oxlint/anti-slop/`](./tools/oxlint/anti-slop/) as
upstream recommends, and loaded through `jsPlugins` in
[`.oxlintrc.json`](./.oxlintrc.json). Notes:

- **Updating**: copy `skills/install-anti-slop/assets/anti-slop/` from upstream
  over `tools/oxlint/anti-slop/` and record the upstream commit in the PR. The
  directory is excluded from oxfmt and oxlint so it stays byte-identical to
  upstream.
- **Versions**: `oxlint` and `@oxlint/plugins` are released in lockstep and
  must stay on the same version (JS plugins are alpha and not covered by
  semver). Bump them together.
- **Node**: loading the plugin from TypeScript source needs Node ≥ 22.18
  (native type stripping). The mise-pinned toolchain and every CI matrix cell
  satisfy this.
- **Ratchet**: files that predate the plugin are listed per rule in the
  `overrides` section of `.oxlintrc.json` with that rule switched off. New
  files are fully enforced. When you clean up a legacy file, delete it from
  the list so it can't regress; never add new files to the lists.
- **Tests**: the type-assertion-centric rules are off in test files, where
  casting fixtures is idiomatic — same policy as the existing
  `typescript/no-non-null-assertion` relaxation.

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
`agent-vX.Y.Z` / `provider-vX.Y.Z`), and publishes to npm with provenance. The
three packages version and release independently.

[cc]: https://www.conventionalcommits.org
