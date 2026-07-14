# Changelog

## [0.4.0](https://github.com/coder/ai-sdk/compare/agent-v0.3.0...agent-v0.4.0) (2026-07-14)

Upgrades the agent package to AI SDK v7 stable. This is a breaking change that requires consumers to migrate to the v7 AI SDK APIs.

### Highlights

- All dependencies have been upgraded to AI SDK v7 stable, which is a breaking change requiring consumers to update accordingly. ([#21](https://github.com/coder/ai-sdk/pull/21))

### ⚠ BREAKING CHANGES

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21))

### Features

* upgrade all packages to AI SDK v7 stable ([#21](https://github.com/coder/ai-sdk/issues/21)) ([cba261c](https://github.com/coder/ai-sdk/commit/cba261c5e08225a54765cf998fe793a67745ca0c))

## [0.3.0](https://github.com/coder/ai-sdk/compare/agent-v0.2.1...agent-v0.3.0) (2026-07-09)

This release improves streaming correctness and overall robustness of the agent, adds previously missing helper functions, and refines lifecycle handling. It also bounds recovery requests and hardens the structured-output example.

### Highlights

- Streaming correctness and lifecycle handling were improved, along with additional hardening and previously missing helper functions. ([#19](https://github.com/coder/ai-sdk/pull/19))
- Recovery requests are now bounded and the structured-output example has been hardened. ([#17](https://github.com/coder/ai-sdk/pull/17))

### Features

* **agent:** stream correctness, hardening, lifecycle, and missing helpers from the bug-report sweep ([#19](https://github.com/coder/ai-sdk/issues/19)) ([fb0f858](https://github.com/coder/ai-sdk/commit/fb0f858be24bef0ddd2b1bdaec52b003ac4b665c))


### Bug Fixes

* **agent:** bound recovery requests and harden the structured-output example ([#17](https://github.com/coder/ai-sdk/issues/17)) ([5577db9](https://github.com/coder/ai-sdk/commit/5577db94149f684e28fa1779afce25d08acab73b))

## [0.2.1](https://github.com/coder/ai-sdk/compare/agent-v0.2.0...agent-v0.2.1) (2026-07-08)

Fixes an issue where server tool calls were not marked as dynamic, causing the agent's tool loop to stop prematurely. The loop now correctly continues past server tool calls.

### Highlights

- Server tool calls are now marked as dynamic so the agent's tool loop continues past them instead of halting. ([#15](https://github.com/coder/ai-sdk/pull/15))

### Bug Fixes

* **agent:** mark server tool calls dynamic so the tool loop continues past them ([#15](https://github.com/coder/ai-sdk/issues/15)) ([7d31dd8](https://github.com/coder/ai-sdk/commit/7d31dd879bc4e2efd2bef01323b8e7b350e327bc))

## [0.2.0](https://github.com/coder/ai-sdk/compare/agent-v0.1.0...agent-v0.2.0) (2026-06-24)

Adds cancellation, timeouts, typed errors, and lifecycle helpers for more robust agent control. Also introduces file upload support for chat attachments and workspace files.

### Highlights

- Agents now support cancellation, timeouts, typed errors, and lifecycle helpers for finer-grained control over execution. ([#13](https://github.com/coder/ai-sdk/pull/13))
- Added file upload support, covering both chat attachments and workspace files. ([#10](https://github.com/coder/ai-sdk/pull/10))

### Features

* **agent:** add file uploads (chat attachments + workspace files) ([#10](https://github.com/coder/ai-sdk/issues/10)) ([cfc5dd9](https://github.com/coder/ai-sdk/commit/cfc5dd9290ee435442dc91a58867526cfde2542f))
* **agent:** cancellation, timeouts, typed errors, and lifecycle helpers ([#13](https://github.com/coder/ai-sdk/issues/13)) ([08fa1dd](https://github.com/coder/ai-sdk/commit/08fa1ddacdd38934ec103a6d4bef2523255a81f4))

## [0.1.0](https://github.com/coder/ai-sdk/compare/agent-v0.1.0...agent-v0.1.0) (2026-06-18)

Initial release of the agent package, migrated into the coder/ai-sdk monorepo. Documentation has been cleaned up to remove internal naming and point at the new repository.

### Highlights

- The @coder/ai-sdk-agent package has been migrated into the monorepo.
- User-facing docs no longer reference the internal 'chatd' name.

### Documentation

* **agent:** drop the internal 'chatd' name from user-facing docs ([917ca09](https://github.com/coder/ai-sdk/commit/917ca0936f4eac4df4043bf9318728e36c1df462))
* **agent:** point CI badge at the coder/ai-sdk monorepo ([8b9cfaa](https://github.com/coder/ai-sdk/commit/8b9cfaae8b0ea53b1b14c353062b713f0700e7d9))


### Code Refactoring

* **agent:** migrate @coder/ai-sdk-agent into the monorepo ([c376372](https://github.com/coder/ai-sdk/commit/c376372f5552cc2fe62413276e631757d1cc9edb))
