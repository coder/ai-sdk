# Contributing

A pnpm monorepo of three independently published packages, all targeting Vercel
AI SDK v7: `@coder/ai-sdk-sandbox`, `@coder/ai-sdk-agent`, and
`@coder/ai-sdk-provider` ([what each does](./README.md#packages)).

Review protocol, release quirks, and invariants live in
[AGENTS.md](./AGENTS.md).

## Setup

The toolchain (Node, pnpm, workflow linters) is pinned in
[`mise.toml`](./mise.toml) and locked in `mise.lock`. With
[mise](https://mise.jdx.dev) installed:

```bash
mise install     # install the pinned toolchain
pnpm install     # install workspace dependencies
```

## Commands

Run everything from the repo root:

```bash
pnpm check       # the CI gate: format check + lint + typecheck
pnpm test        # run tests
pnpm build       # build every package
pnpm format      # auto-format with oxfmt
```

Lint and format ([oxc](https://oxc.rs): `oxlint` + `oxfmt`) cover the whole
tree at once. Typecheck, test, and build fan out to each package; target one
with `--filter`:

```bash
pnpm --filter @coder/ai-sdk-agent test
pnpm --filter @coder/ai-sdk-sandbox build
```

Workflows are linted with [`actionlint`](https://github.com/rhysd/actionlint)
and audited with [`zizmor`](https://docs.zizmor.sh), both pinned in
`mise.toml`. Run them locally with `actionlint` and `zizmor .github/workflows`.

### The anti-slop lint rules

[anti-slop](https://github.com/dmmulroy/anti-slop) adds opinionated rules that
reject low-evidence TypeScript patterns: unjustified type assertions, `unknown`
in signatures, ad hoc `typeof` narrowing, and similar. It is **vendored** at
[`tools/oxlint/anti-slop/`](./tools/oxlint/anti-slop/) (as upstream
recommends) and loaded through `jsPlugins` in
[`.oxlintrc.json`](./.oxlintrc.json).

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

PRs are **squash-merged**: the PR title becomes the commit on `main` and drives
releases. The **title must be a valid [Conventional Commit][cc]** (CI enforces
it). Scope it with the package's short name, or omit the scope for repo-wide
changes:

```text
feat(sandbox): add port leasing
fix(agent): handle interrupt mid-stream
ci: bump actions
```

## Releases

Fully automated with
[release-please](https://github.com/googleapis/release-please); never bump
versions or `npm publish` by hand.

1. release-please reads the Conventional Commit history and opens one release
   PR per package.
2. Merging that PR versions the package, tags it (`sandbox-vX.Y.Z` /
   `agent-vX.Y.Z` / `provider-vX.Y.Z`), and publishes to npm with provenance.

Each package versions and releases independently.

[cc]: https://www.conventionalcommits.org
