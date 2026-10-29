# @coder/ai-sdk-sandbox

## Overview

`@coder/ai-sdk-sandbox` is the Coder workspace sandbox provider for the Vercel AI SDK v7
`HarnessAgent`. It runs harness sessions (for example Claude Code) inside Coder
workspaces. It can wrap an existing workspace or create one per session, and it reaches
the workspace through the `coder` CLI with OpenSSH or through the Coder REST API with a
PTY WebSocket relay. The package ships one ESM entry point built from `src/index.ts`.
User docs: [README.md](./README.md) and
[template-authoring.md](./docs/template-authoring.md).

## Interface

- Published entry points: `exports` maps `"."` to `./dist/index.js` (`types`
  `./dist/index.d.ts`) and exposes `"./package.json"`. `main` and `types` point to the same
  files. [package.json:exports]
- Published files: `dist`, `docs`, `README.md`. [package.json:files]
- ESM only (`"type": "module"`) and `"sideEffects": false`. [package.json:type]
  [package.json:sideEffects]
- Build: `tsup src/index.ts --format esm --dts --clean`. [package.json:scripts]
- Runtime dependencies `ws` and `yaml`. Peer dependencies
  `@ai-sdk/harness` (`^1.0.0`) and `@ai-sdk/provider-utils` (`^5.0.0`).
  [package.json:dependencies] [package.json:peerDependencies]
- Node.js `>=22`. [package.json:engines]
- Package scripts: `build`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `test:watch`, `test:coverage`, `attw`, `verify:real`, `verify:native`, `verify:create`,
  `prepublishOnly`. [package.json:scripts]
- Children:
  - [src](./src/EGM.md) - `createCoderWorkspace`, `ensureCoderWorkspace`,
    `CODER_WORKSPACE_PROVIDER_ID`, the provider settings types (`CoderWorkspaceSettings`,
    `CoderCreateSettings`, `EnsureCoderWorkspaceSettings`), `CoderWorkspaceSession`,
    `CoderCliTransport`, `CoderNativeTransport`, `CoderNativeApiError`, and the
    `CoderTransport` types.
  - [scripts](./scripts/EGM.md) - live verification scripts run with `tsx`.
  - [examples](./examples/EGM.md) - Claude Code examples and a sample Coder template.

## Invariants

- Vitest runs only `test/**/*.test.ts`, with a 20000 ms test timeout. Coverage uses `v8`
  over `src/**`. [vitest.config.ts:default]
- The package tsconfig includes `src`, `test`, `examples` and `scripts`, so `typecheck`
  compiles the examples and scripts too. [tsconfig.json:include]
- The `typescript` devDependency is `npm:@typescript/typescript6` and
  `typescript-7` is `npm:typescript`. The repo AGENTS.md explains that tsup needs
  the TypeScript 6 compiler API for `.d.ts` output. [package.json:devDependencies]
- `prepublishOnly` chains build, typecheck, test, `publint` and `attw` with `&&`, so the
  first failure stops a publish. [package.json:scripts]
- `attw` ignores only the `cjs-resolves-to-esm` rule, which matches the ESM-only build.
  [package.json:scripts]

## Side Effects

- `build` empties `dist/` (`--clean`) and writes `dist/index.js` and `dist/index.d.ts`.
  [package.json:scripts]
- `test:coverage` prints a text report and writes an HTML report.
  [vitest.config.ts:default]
- `attw --pack` packs the package into a tarball to check it. [package.json:scripts]
- `verify:real`, `verify:native` and `verify:create` run against a live Coder deployment.
  `verify:create` creates and deletes a workspace. [package.json:scripts]
- Publishing uses `"access": "public"` and `"provenance": true`.
  [package.json:publishConfig]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-sandbox test`
- Run: `pnpm --filter @coder/ai-sdk-sandbox typecheck`
- Publish hygiene (CI runs these): `pnpm publint` and `pnpm attw`
