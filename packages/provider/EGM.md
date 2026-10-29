# @coder/ai-sdk-provider (`packages/provider`)

## Overview

`@coder/ai-sdk-provider` is a published npm package. It is a Vercel AI SDK v7 provider that
sends model calls through a Coder deployment's AI Gateway. The runtime lives in `src/`.
`examples/` holds live scripts that are not published. This root holds the package manifest
and the build and test configs. For user-facing docs, see [README.md](./README.md) and
[docs/security.md](./docs/security.md).

## Interface

- [src/EGM.md](./src/EGM.md): the runtime. `createCoder` (alias `coder`) returns a
  `CoderProvider` over AI Gateway's OpenAI-compatible and Anthropic surfaces.
  `isAnthropicModelId` picks the surface for a bare model id.
- [examples/EGM.md](./examples/EGM.md): three `tsx` scripts that call a live deployment.
- The published entry point is `"."`, with `types` `./dist/index.d.ts` and `import` and
  `default` `./dist/index.js`. `./package.json` is also exported. There is no `require`
  condition [package.json:exports]
- `main` and `module` are `./dist/index.js`. `types` is `./dist/index.d.ts`
  [package.json:main]
- `files` lists `dist`, `docs` and `README.md`. npm also packs `package.json` and
  `LICENSE` [package.json:files]
- `publishConfig` is `{ "access": "public", "provenance": true }`
  [package.json:publishConfig]
- tsup builds `src/index.ts` to ESM with `.d.ts` files and sourcemaps, `target: "es2022"`
  [tsup.config.ts:default]
- Scripts: `build` (`tsup`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `test:watch`, `test:coverage`, `attw` (`attw --pack --ignore-rules cjs-resolves-to-esm`),
  `example:generate`, `example:stream`, `example:anthropic` [package.json:scripts]

## Invariants

- tsup keeps `ai`, `zod`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`,
  `@ai-sdk/provider` and `@ai-sdk/provider-utils` external. The config comment says
  bundling them would fork the `LanguageModelV4` type identity from the consumer's
  [tsup.config.ts:default]
- Runtime dependencies are `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` and an exact
  `@ai-sdk/provider` pin. `package.json` holds the current ranges [package.json:dependencies]
- `ai` `^7.0.0` is a required peer. `zod` `^3.25.76 || ^4.1.8` is an optional peer
  [package.json:peerDependencies]
- The package is ESM only (`"type": "module"`, tsup `format: ["esm"]`). The `attw` script
  ignores the `cjs-resolves-to-esm` rule for that reason [package.json:scripts]
- The `typescript` dev dependency is `npm:@typescript/typescript6`, beside
  `typescript-7` (`npm:typescript`). The repo `AGENTS.md` says tsup needs the
  TypeScript 6 compiler API to build `.d.ts` files [package.json:devDependencies]
- Node `>=22` is required [package.json:engines]
- Vitest runs `test/**/*.test.ts` with 30 s test and hook timeouts. The config comment says
  the unit tests stub `fetch` and need no live deployment [vitest.config.ts:default]

## Side Effects

- `"sideEffects": false` tells bundlers that the package modules have no import-time side
  effects [package.json:sideEffects]
- `pnpm build` cleans the output folder (`clean: true`) and then writes `dist/`
  [tsup.config.ts:default]
- `attw --pack` packs the package into a tarball to check its published types
  [package.json:scripts]
- The `example:*` scripts send requests to a live Coder deployment (see
  [examples/EGM.md](./examples/EGM.md)) [package.json:scripts]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-provider test`
- Run: `pnpm --filter @coder/ai-sdk-provider typecheck`
- Publish hygiene (CI runs these from the repo root): `pnpm publint` and `pnpm attw`
- Unit tests: `packages/provider/test/provider.test.ts`
