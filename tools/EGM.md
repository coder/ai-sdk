# tools

## Overview

`tools/` holds repo-local development tooling. It has no source files of its own. It is not
a pnpm workspace package: `pnpm-workspace.yaml` lists only `packages/*`
[../pnpm-workspace.yaml:packages]. Its only child is `oxlint/`, which holds the vendored
anti-slop oxlint JS plugin. The root `.oxlintrc.json` loads that plugin through `jsPlugins`
[../.oxlintrc.json:jsPlugins], so `pnpm lint` enforces its rules on the repo's source
files, except the `ignorePatterns` paths (including `tools/oxlint/anti-slop/**` itself), the
rules turned off for test files, and the per-rule ratchet lists [../.oxlintrc.json:overrides].

## Subdirectories & Boundaries

- oxlint: [`./oxlint/EGM.md`](./oxlint/EGM.md) - The vendored
  [anti-slop](https://github.com/dmmulroy/anti-slop) plugin in `oxlint/anti-slop/`.
  `anti-slop/index.ts` registers 15 rules that reject low-evidence TypeScript patterns, such
  as chained or unjustified type assertions, `unknown` in signatures, unsafe dictionary
  types, runtime `typeof` checks and module mocking. `.oxlintrc.json` enables all 15 as
  `"error"`, with per-rule ratchet lists for legacy files. CONTRIBUTING.md says
  `anti-slop/` stays byte-identical to upstream, so the plugin's contract lives in
  `oxlint/EGM.md` and `anti-slop/` has no EGM.md files.
