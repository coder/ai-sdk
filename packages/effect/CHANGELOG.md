# Changelog

## 0.1.0 (2026-11-01)

Initial 0.1.0 release of @coder/ai-sdk-effect, an Effect-based bridge that exposes a LanguageModel backed by CoderAgent. It supports Effect 4.1, per-call generation options, and structured error classification.

### Highlights

- Publishes the @coder/ai-sdk-effect package providing an Effect bridge over CoderAgent. ([#324](https://github.com/coder/ai-sdk/pull/324))
- Adds a LanguageModel implementation backed by CoderAgent. ([#241](https://github.com/coder/ai-sdk/pull/241))
- Supports Effect 4.1 (and migrates the bridge to Effect 4). ([#425](https://github.com/coder/ai-sdk/pull/425))
- Adds per-call agent model, reasoning effort, and generation options. ([#242](https://github.com/coder/ai-sdk/pull/242))
- Classifies agent errors, including treating 402 responses as quota errors with raw usage and InvalidResponseError as malformed-response. ([#328](https://github.com/coder/ai-sdk/pull/328))

### Features

* **effect:** add a LanguageModel over CoderAgent ([#241](https://github.com/coder/ai-sdk/issues/241)) ([277c0ce](https://github.com/coder/ai-sdk/commit/277c0ce484c4cf499cb2b45bf5993ebcc6663f06))
* **effect:** add Effect bridge spike package ([#145](https://github.com/coder/ai-sdk/issues/145)) ([1dce33f](https://github.com/coder/ai-sdk/commit/1dce33f5aecb44d46e71a0a690cc9323ee02dd11))
* **effect:** add per-call agent model and reasoning effort options ([#242](https://github.com/coder/ai-sdk/issues/242)) ([286e947](https://github.com/coder/ai-sdk/commit/286e947fbd34969866d19061837056729fa4c4ba))
* **effect:** classify 402 as quota and carry raw usage ([#328](https://github.com/coder/ai-sdk/issues/328)) ([6fb4c63](https://github.com/coder/ai-sdk/commit/6fb4c6310571317b8aad95b0cafd2546a43d1acd))
* **effect:** classify agent errors and add per-call generation options ([#240](https://github.com/coder/ai-sdk/issues/240)) ([fd2eabe](https://github.com/coder/ai-sdk/commit/fd2eabeb81168f5a776dc47400d89b1417f2b023))
* **effect:** forward toolChoice unconditionally and add a live tool-call case ([#319](https://github.com/coder/ai-sdk/issues/319)) ([ef6a0c0](https://github.com/coder/ai-sdk/commit/ef6a0c05624cfbb9d02ddbf5294cc0a09a0e1448))
* **effect:** migrate bridge to effect 4 ([#320](https://github.com/coder/ai-sdk/issues/320)) ([661c4c2](https://github.com/coder/ai-sdk/commit/661c4c250172c3f1f2a22a45d9e53101395680a2))
* **effect:** publish @coder/ai-sdk-effect ([#324](https://github.com/coder/ai-sdk/issues/324)) ([3e44f02](https://github.com/coder/ai-sdk/commit/3e44f028bfe7f92e6fdcdd5929516ebf28163965))
* **effect:** support effect 4.1 ([#425](https://github.com/coder/ai-sdk/issues/425)) ([127c96e](https://github.com/coder/ai-sdk/commit/127c96e1fb645310826b205e17f2c28592d81397))


### Bug Fixes

* **effect:** classify InvalidResponseError as malformed-response ([#381](https://github.com/coder/ai-sdk/issues/381)) ([3098d5b](https://github.com/coder/ai-sdk/commit/3098d5b36b2e06f7a51ac9e57232adb228ef135c))


### Documentation

* **effect:** drop leftover spike wording from source comments ([#331](https://github.com/coder/ai-sdk/issues/331)) ([056fe9b](https://github.com/coder/ai-sdk/commit/056fe9bdb7b644b081a203a95c1037a473d8e737))
* rewrite READMEs for readability and split long guides into docs/ ([#234](https://github.com/coder/ai-sdk/issues/234)) ([1c5079b](https://github.com/coder/ai-sdk/commit/1c5079b103c1719ea49dc1dc07ecc2ad527b163d))
