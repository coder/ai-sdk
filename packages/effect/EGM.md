# @coder/ai-sdk-effect

## Overview

`@coder/ai-sdk-effect` bridges Coder's Vercel AI SDK packages to Effect 4 (`effect/ai`). It
provides `effect/ai` `LanguageModel` services over Coder AI Gateway and Coder Agents,
`AiError` classification, Effect Schema to AI SDK schema conversion, and scoped Coder
workspace `Layer`s. It depends on `@coder/ai-sdk-agent` (`packages/agent`),
`@coder/ai-sdk-provider` (`packages/provider`) and `@coder/ai-sdk-sandbox`
(`packages/sandbox`) through `workspace:^`. User-facing docs: [README](./README.md).

## Interface

- [src](./src/EGM.md): the published API. `src/index.ts` exports the `CoderLanguageModel`
  and `CoderAgentModel` namespaces, the error helpers (`classifyError`, `classifyStatus`,
  `isTransient`, `toAiError`), the sandbox helpers (`acquireWorkspace`, `layerWorkspace`,
  `acquireSession`, `layerSession`, `CoderWorkspace`, `CoderSession`,
  `CoderSandboxError`) and the schema helpers (`toJsonSchema`, `toAiSdkSchema`)
  [./src/index.ts:CoderLanguageModel].
- [examples](./examples/EGM.md): three unpublished scripts run with `tsx`
  [./package.json:scripts].
- The package publishes one entry point, `"."`, with the conditions `types`
  (`./dist/index.d.ts`), `import` and `default` (`./dist/index.js`), plus
  `"./package.json"` [./package.json:exports].
- `main` and `module` are `./dist/index.js`. `types` is `./dist/index.d.ts`
  [./package.json:main] [./package.json:types].
- The tarball contains `dist` and `README.md` [./package.json:files].
- Scripts: `build` (`tsup`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `test:watch`, `test:coverage`, `attw` (`attw --pack --ignore-rules cjs-resolves-to-esm`),
  `example:generate`, `example:structured`, `example:sandbox` [./package.json:scripts].
- The build bundles `src/index.ts` only, as ESM with `.d.ts` files and sourcemaps, for
  target `es2022` [./tsup.config.ts:default].
- Vitest runs `test/**/*.test.ts` with 30-second test and hook timeouts
  [./vitest.config.ts:default].

## Invariants

- The package is ESM only: `"type": "module"` and tsup `format: ["esm"]`. The `attw` script
  ignores the `cjs-resolves-to-esm` rule [./package.json:type]
  [./tsup.config.ts:default] [./package.json:scripts].
- tsup keeps `ai`, `effect`, `effect/*`, `@effect/*`, `@ai-sdk/*` and `@coder/*` out of the
  bundle [./tsup.config.ts:default].
- Peer dependency ranges: `ai` `^7.0.0` and `effect` `~4.0.0 || ~4.1.0`
  [./package.json:peerDependencies].
- Runtime dependencies: an exact `@ai-sdk/provider` pin, and the three Coder packages
  as `workspace:^` [./package.json:dependencies].
- pnpm publishes each `workspace:^` dependency as `^<sibling version in the released
  commit>`. If an effect change needs an unreleased sibling change, release that sibling
  before merging the effect release PR (see `../../AGENTS.md`, "Repo shape")
  [./package.json:dependencies].
- Node `>=22` [./package.json:engines].
- `"sideEffects": false` [./package.json:sideEffects].
- The devDependency `typescript` is `npm:@typescript/typescript6` (used by the tsup
  `.d.ts` build). `typescript-7` is `npm:typescript` (see `../../AGENTS.md`)
  [./package.json:devDependencies].

## Side Effects

- `build` cleans and rewrites `dist/` (`clean: true`, `dts: true`, `sourcemap: true`)
  [./tsup.config.ts:default].
- npm publish uses `access: "public"` and `provenance: true` [./package.json:publishConfig].
- The vitest include glob also matches `test/e2e/agent-model.e2e.test.ts`. That suite uses
  `describe.skip` unless both `CODER_URL` and `CODER_SESSION_TOKEN` are set. With them set,
  it creates chats on that live deployment [./vitest.config.ts:default]
  [./test/e2e/agent-model.e2e.test.ts:suite].
- `attw --pack` packs the package to check its type resolution [./package.json:scripts].

## Verification

`pnpm -r build` first: effect's typecheck and tests resolve the other packages' `dist/`
through `workspace:^`.

```sh
pnpm -r build
pnpm --filter @coder/ai-sdk-effect test
pnpm --filter @coder/ai-sdk-effect typecheck
```

The vitest include `test/**/*.test.ts` also picks up `test/e2e/agent-model.e2e.test.ts`. That
file self-skips (`describe.skip`) unless `CODER_URL` and `CODER_SESSION_TOKEN` are set.
Running `pnpm -r test` with those env vars set runs that live suite.

Publish hygiene (CI runs these; root scripts that cover sandbox, provider and effect):

```sh
pnpm publint
pnpm attw
```
