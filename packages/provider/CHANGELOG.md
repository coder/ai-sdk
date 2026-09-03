# Changelog

## [0.4.8](https://github.com/coder/ai-sdk/compare/provider-v0.4.7...provider-v0.4.8) (2026-09-03)

A maintenance release with internal changes and no documented user-facing updates.

## [0.4.7](https://github.com/coder/ai-sdk/compare/provider-v0.4.6...provider-v0.4.7) (2026-09-02)

A maintenance release with internal changes and no documented user-facing updates.

## [0.4.6](https://github.com/coder/ai-sdk/compare/provider-v0.4.5...provider-v0.4.6) (2026-08-31)

A maintenance release with no user-facing changes.

## [0.4.5](https://github.com/coder/ai-sdk/compare/provider-v0.4.4...provider-v0.4.5) (2026-08-30)

A maintenance release with internal changes and no user-facing API modifications.

## [0.4.4](https://github.com/coder/ai-sdk/compare/provider-v0.4.3...provider-v0.4.4) (2026-08-29)

A maintenance release with no user-facing changes.

## [0.4.3](https://github.com/coder/ai-sdk/compare/provider-v0.4.2...provider-v0.4.3) (2026-08-28)

A maintenance release with internal updates and no documented user-facing changes.

## [0.4.2](https://github.com/coder/ai-sdk/compare/provider-v0.4.1...provider-v0.4.2) (2026-08-27)

A maintenance release with no user-facing changes documented.

## [0.4.1](https://github.com/coder/ai-sdk/compare/provider-v0.4.0...provider-v0.4.1) (2026-08-26)

A maintenance release with no user-facing changes.

## [0.4.0](https://github.com/coder/ai-sdk/compare/provider-v0.3.5...provider-v0.4.0) (2026-08-25)

Adds sub-provider accessors so you can access custom-named gateway providers.

### Highlights

- You can now use sub-provider accessors to reach custom-named gateway providers. ([#105](https://github.com/coder/ai-sdk/pull/105))

### Features

* **provider:** add sub-provider accessors for custom-named gateway providers ([#105](https://github.com/coder/ai-sdk/issues/105)) ([c049a45](https://github.com/coder/ai-sdk/commit/c049a4596875bb6d9afbb67efeefa389e86f341e))

## [0.3.5](https://github.com/coder/ai-sdk/compare/provider-v0.3.4...provider-v0.3.5) (2026-08-25)

A maintenance release with no user-facing changes.

## [0.3.4](https://github.com/coder/ai-sdk/compare/provider-v0.3.3...provider-v0.3.4) (2026-08-25)

The provider now throws a NoSuchModelError immediately when textEmbeddingModel is requested, rather than failing later.

### Highlights

- Calling textEmbeddingModel now fails fast with a NoSuchModelError instead of erroring downstream. ([#80](https://github.com/coder/ai-sdk/pull/80))

### Bug Fixes

* **provider:** fail fast with NoSuchModelError for textEmbeddingModel ([#80](https://github.com/coder/ai-sdk/issues/80)) ([ebc7003](https://github.com/coder/ai-sdk/commit/ebc700302a281869697a70f205b6982a5324ea9c))

## [0.3.3](https://github.com/coder/ai-sdk/compare/provider-v0.3.2...provider-v0.3.3) (2026-08-24)

Adds an enterprise governance and security reference to the provider documentation.

### Highlights

- New documentation covering enterprise governance and security for the provider. ([#68](https://github.com/coder/ai-sdk/pull/68))

### Documentation

* **provider:** add enterprise governance & security reference ([#68](https://github.com/coder/ai-sdk/issues/68)) ([ed44fea](https://github.com/coder/ai-sdk/commit/ed44fea4385584e93fe25510fc3d52f04ac71ef1))

## [0.3.2](https://github.com/coder/ai-sdk/compare/provider-v0.3.1...provider-v0.3.2) (2026-08-24)

Documentation-only release that corrects inconsistencies across the README and CONTRIBUTING files.

### Highlights

- Fixed documentation drift across the READMEs and CONTRIBUTING guide. ([#51](https://github.com/coder/ai-sdk/pull/51))

### Documentation

* fix drift across READMEs and CONTRIBUTING ([#51](https://github.com/coder/ai-sdk/issues/51)) ([6c0001b](https://github.com/coder/ai-sdk/commit/6c0001b612830ca4d653a7ef828a7cd89c6b1f70))

## [0.3.1](https://github.com/coder/ai-sdk/compare/provider-v0.3.0...provider-v0.3.1) (2026-08-18)

A maintenance release with no user-facing changes.

## [0.3.0](https://github.com/coder/ai-sdk/compare/provider-v0.2.0...provider-v0.3.0) (2026-07-14)

This release upgrades the provider to AI SDK v7 stable. This is a breaking change and requires updating your dependencies accordingly.

### Highlights

- All packages have been upgraded to AI SDK v7 stable, which is a breaking change requiring you to update your integration. ([#21](https://github.com/coder/ai-sdk/pull/21))

### ⚠ BREAKING CHANGES

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21))

### Features

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21)) ([cba261c](https://github.com/coder/ai-sdk/commit/cba261c5e08225a54765cf998fe793a67745ca0c))

## [0.2.0](https://github.com/coder/ai-sdk/compare/provider-v0.1.0...provider-v0.2.0) (2026-06-24)

Adds agent cancellation and timeout support, typed errors, and lifecycle helpers to the provider package.

### Highlights

- Agents now support cancellation, timeouts, typed errors, and lifecycle helpers for more robust control over agent execution. ([#13](https://github.com/coder/ai-sdk/pull/13))

### Features

* **agent:** cancellation, timeouts, typed errors, and lifecycle helpers ([#13](https://github.com/coder/ai-sdk/issues/13)) ([08fa1dd](https://github.com/coder/ai-sdk/commit/08fa1ddacdd38934ec103a6d4bef2523255a81f4))

## [0.1.0](https://github.com/coder/ai-sdk/compare/provider-v0.1.0...provider-v0.1.0) (2026-06-18)

Initial release of @coder/ai-sdk-provider, an AI SDK provider for the AI Gateway.

### Highlights

- Adds the @coder/ai-sdk-provider package for integrating with the AI Gateway. ([#6](https://github.com/coder/ai-sdk/pull/6))

### Features

* **provider:** add @coder/ai-sdk-provider for AI Gateway ([f61f401](https://github.com/coder/ai-sdk/commit/f61f40121ac823cf979a607615b67f0ff46c0410))
* **provider:** add @coder/ai-sdk-provider for AI Gateway ([10c35b1](https://github.com/coder/ai-sdk/commit/10c35b1579696e09596b1318bf70f491c05b9180))
