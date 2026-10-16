# Changelog

## 0.1.0 (2026-10-16)

Initial public release of @coder/ai-sdk-effect, an Effect-based bridge that exposes a LanguageModel over CoderAgent with per-call generation options and classified error handling. The package has been migrated to Effect 4 and is now published.

### Highlights

- The @coder/ai-sdk-effect package is now published for public consumption. ([#324](https://github.com/coder/ai-sdk/pull/324))
- The bridge has been migrated to Effect 4. ([#320](https://github.com/coder/ai-sdk/pull/320))
- Added a LanguageModel implementation over CoderAgent. ([#241](https://github.com/coder/ai-sdk/pull/241))
- Added per-call agent model, reasoning effort, and generation options. ([#242](https://github.com/coder/ai-sdk/pull/242))
- Agent errors are now classified, with 402 responses treated as quota errors and raw usage data carried through. ([#328](https://github.com/coder/ai-sdk/pull/328))

### Features

* **effect:** add a LanguageModel over CoderAgent ([#241](https://github.com/coder/ai-sdk/issues/241)) ([277c0ce](https://github.com/coder/ai-sdk/commit/277c0ce484c4cf499cb2b45bf5993ebcc6663f06))
* **effect:** add Effect bridge spike package ([#145](https://github.com/coder/ai-sdk/issues/145)) ([1dce33f](https://github.com/coder/ai-sdk/commit/1dce33f5aecb44d46e71a0a690cc9323ee02dd11))
* **effect:** add per-call agent model and reasoning effort options ([#242](https://github.com/coder/ai-sdk/issues/242)) ([286e947](https://github.com/coder/ai-sdk/commit/286e947fbd34969866d19061837056729fa4c4ba))
* **effect:** classify 402 as quota and carry raw usage ([#328](https://github.com/coder/ai-sdk/issues/328)) ([6fb4c63](https://github.com/coder/ai-sdk/commit/6fb4c6310571317b8aad95b0cafd2546a43d1acd))
* **effect:** classify agent errors and add per-call generation options ([#240](https://github.com/coder/ai-sdk/issues/240)) ([fd2eabe](https://github.com/coder/ai-sdk/commit/fd2eabeb81168f5a776dc47400d89b1417f2b023))
* **effect:** forward toolChoice unconditionally and add a live tool-call case ([#319](https://github.com/coder/ai-sdk/issues/319)) ([ef6a0c0](https://github.com/coder/ai-sdk/commit/ef6a0c05624cfbb9d02ddbf5294cc0a09a0e1448))
* **effect:** migrate bridge to effect 4 ([#320](https://github.com/coder/ai-sdk/issues/320)) ([661c4c2](https://github.com/coder/ai-sdk/commit/661c4c250172c3f1f2a22a45d9e53101395680a2))
* **effect:** publish @coder/ai-sdk-effect ([#324](https://github.com/coder/ai-sdk/issues/324)) ([3e44f02](https://github.com/coder/ai-sdk/commit/3e44f028bfe7f92e6fdcdd5929516ebf28163965))


### Documentation

* **effect:** drop leftover spike wording from source comments ([#331](https://github.com/coder/ai-sdk/issues/331)) ([056fe9b](https://github.com/coder/ai-sdk/commit/056fe9bdb7b644b081a203a95c1037a473d8e737))
* rewrite READMEs for readability and split long guides into docs/ ([#234](https://github.com/coder/ai-sdk/issues/234)) ([1c5079b](https://github.com/coder/ai-sdk/commit/1c5079b103c1719ea49dc1dc07ecc2ad527b163d))
