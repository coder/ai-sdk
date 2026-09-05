# Changelog

## [0.4.13](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.12...sandbox-v0.4.13) (2026-09-05)

A maintenance release for the sandbox package with no user-facing changes.

## [0.4.12](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.11...sandbox-v0.4.12) (2026-09-04)

Maintenance release for the sandbox package with internal changes only.

## [0.4.11](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.10...sandbox-v0.4.11) (2026-09-03)

A maintenance release for the sandbox package with no user-facing changes.

## [0.4.10](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.9...sandbox-v0.4.10) (2026-09-02)

A maintenance release for the sandbox package with no user-facing changes.

## [0.4.9](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.8...sandbox-v0.4.9) (2026-08-31)

A maintenance release with no user-facing changes.

## [0.4.8](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.7...sandbox-v0.4.8) (2026-08-30)

A maintenance release with no user-facing changes.

## [0.4.7](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.6...sandbox-v0.4.7) (2026-08-29)

A maintenance release with no user-facing functional changes.

## [0.4.6](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.5...sandbox-v0.4.6) (2026-08-28)

A maintenance release for the sandbox package with no user-facing changes.

## [0.4.5](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.4...sandbox-v0.4.5) (2026-08-27)

A maintenance release for the sandbox package with no user-facing changes.

## [0.4.4](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.3...sandbox-v0.4.4) (2026-08-26)

Maintenance release with no user-facing changes.

## [0.4.3](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.2...sandbox-v0.4.3) (2026-08-25)

A maintenance release with no user-facing changes.

## [0.4.2](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.1...sandbox-v0.4.2) (2026-08-24)

Adds a new documentation guide covering how to author zero-install templates.

### Highlights

- New zero-install template authoring guide is now available in the docs. ([#66](https://github.com/coder/ai-sdk/pull/66))

### Documentation

* **sandbox:** add zero-install template authoring guide ([#66](https://github.com/coder/ai-sdk/issues/66)) ([5d8959c](https://github.com/coder/ai-sdk/commit/5d8959c13d2b7700188ec5fc65d4393be8e8954d))

## [0.4.1](https://github.com/coder/ai-sdk/compare/sandbox-v0.4.0...sandbox-v0.4.1) (2026-08-24)

Documentation-only release that corrects inconsistencies across the READMEs and CONTRIBUTING files.

### Highlights

- Fixed documentation drift across the READMEs and CONTRIBUTING guide. ([#51](https://github.com/coder/ai-sdk/pull/51))

### Documentation

* fix drift across READMEs and CONTRIBUTING ([#51](https://github.com/coder/ai-sdk/issues/51)) ([6c0001b](https://github.com/coder/ai-sdk/commit/6c0001b612830ca4d653a7ef828a7cd89c6b1f70))

## [0.4.0](https://github.com/coder/ai-sdk/compare/sandbox-v0.3.0...sandbox-v0.4.0) (2026-08-18)

Adds a native Coder transport to the sandbox package, expanding how sandboxes can connect and run.

### Highlights

- Introduces a native Coder transport for sandboxes. ([#33](https://github.com/coder/ai-sdk/pull/33))

### Features

* **sandbox:** add native Coder transport ([#33](https://github.com/coder/ai-sdk/issues/33)) ([c684683](https://github.com/coder/ai-sdk/commit/c684683b0113b4dd68cade78b6fdea940941e039))

## [0.3.0](https://github.com/coder/ai-sdk/compare/sandbox-v0.2.0...sandbox-v0.3.0) (2026-07-14)

Upgrades all packages to AI SDK v7 stable, which is a breaking change requiring consumers to migrate to the new SDK version.

### Highlights

- All packages now depend on AI SDK v7 stable, a breaking change that requires updating your integration accordingly. ([#21](https://github.com/coder/ai-sdk/pull/21))

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
