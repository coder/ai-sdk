# Changelog

## [0.3.0](https://github.com/coder/ai-sdk/compare/sandbox-v0.2.0...sandbox-v0.3.0) (2026-07-14)

All packages in the sandbox package now target the stable AI SDK v7. This is a breaking change that requires consumers to upgrade to AI SDK v7.

### Highlights

- Upgraded to AI SDK v7 stable, a breaking change that requires consumers to migrate to the v7 API. ([#21](https://github.com/coder/ai-sdk/pull/21))

### ⚠ BREAKING CHANGES

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21))

### Features

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21)) ([cba261c](https://github.com/coder/ai-sdk/commit/cba261c5e08225a54765cf998fe793a67745ca0c))

## [0.2.0](https://github.com/coder/ai-sdk/compare/sandbox-v0.1.0...sandbox-v0.2.0) (2026-07-09)

Adds streaming correctness improvements, lifecycle handling, and additional helper methods to the agent, along with general hardening based on a bug-report sweep.

### Highlights

- Improved streaming correctness and reliability in the agent, plus hardening and new helper methods. ([#19](https://github.com/coder/ai-sdk/pull/19))

### Features

* **agent:** stream correctness, hardening, lifecycle, and missing helpers from the bug-report sweep ([#19](https://github.com/coder/ai-sdk/issues/19)) ([fb0f858](https://github.com/coder/ai-sdk/commit/fb0f858be24bef0ddd2b1bdaec52b003ac4b665c))

## [0.1.0](https://github.com/coder/ai-sdk/compare/sandbox-v0.1.0...sandbox-v0.1.0) (2026-06-18)

Initial release of the sandbox package, migrated from @coder/ai-sdk-sandbox into the monorepo.

### Highlights

- The @coder/ai-sdk-sandbox package has been migrated into the monorepo and published as sandbox.

### Code Refactoring

* **sandbox:** migrate @coder/ai-sdk-sandbox into the monorepo ([5c4785d](https://github.com/coder/ai-sdk/commit/5c4785d2a6b0976fa87d4aeb6d0972c04ef95a61))
