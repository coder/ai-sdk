# Changelog

## [0.9.0](https://github.com/coder/ai-sdk/compare/agent-v0.8.0...agent-v0.9.0) (2026-08-26)

Agent now retains stranded chat IDs so they can be cleaned up and stamped onto stream errors, and it annotates transport events with replay disposition and operation names for improved observability.

### Highlights

- Stranded chat IDs are retained for cleanup and included in stream error metadata. ([#116](https://github.com/coder/ai-sdk/pull/116))
- Transport events are now stamped with replay disposition and operation names. ([#117](https://github.com/coder/ai-sdk/pull/117))

### Features

* **agent:** stamp replay disposition and operation names on transport events ([#117](https://github.com/coder/ai-sdk/issues/117)) ([c601ed8](https://github.com/coder/ai-sdk/commit/c601ed8ed55d98497965da52ec6af1af56762f31))


### Bug Fixes

* **agent:** retain stranded chat id for cleanup and stamp it on stream errors ([#116](https://github.com/coder/ai-sdk/issues/116)) ([0bf18db](https://github.com/coder/ai-sdk/commit/0bf18dbf4141b8e7674b33268941ac64a8f235c6))

## [0.8.0](https://github.com/coder/ai-sdk/compare/agent-v0.7.2...agent-v0.8.0) (2026-08-26)

The agent now falls back to the CODER_URL and CODER_SESSION_TOKEN environment variables for its default connection settings, simplifying configuration in environments where those variables are already present.

### Highlights

- Connection settings now default to the CODER_URL and CODER_SESSION_TOKEN environment variables when not explicitly provided. ([#109](https://github.com/coder/ai-sdk/pull/109))

### Features

* **agent:** default connection settings from CODER_URL / CODER_SESSION_TOKEN ([#109](https://github.com/coder/ai-sdk/issues/109)) ([2e4748c](https://github.com/coder/ai-sdk/commit/2e4748c1b0d6cb46acb46ed991e8cf10f805389d))

## [0.7.2](https://github.com/coder/ai-sdk/compare/agent-v0.7.1...agent-v0.7.2) (2026-08-25)

A maintenance release for the agent package with no user-facing changes.

## [0.7.1](https://github.com/coder/ai-sdk/compare/agent-v0.7.0...agent-v0.7.1) (2026-08-25)

Documentation updates covering attempt-scoped journaling, send write-ahead behavior, and client-tool text handling during crash recovery.

### Highlights

- Expanded crash-recovery documentation detailing attempt-scoped journaling, send write-ahead, and client-tool text cut behavior. ([#97](https://github.com/coder/ai-sdk/pull/97))

### Documentation

* **agent:** attempt-scoped journal, send write-ahead, and client-tool text cut in crash recovery ([#97](https://github.com/coder/ai-sdk/issues/97)) ([1cf3291](https://github.com/coder/ai-sdk/commit/1cf32915f4d49af1b1bcd35aa4a5539af28df93e))

## [0.7.0](https://github.com/coder/ai-sdk/compare/agent-v0.6.3...agent-v0.7.0) (2026-08-25)

Adds a monotonic reader id stamped onto ws:* transport events, giving consumers a reliable way to order and correlate WebSocket transport events.

### Highlights

- ws:* transport events now carry a monotonic reader id for ordering and correlation. ([#95](https://github.com/coder/ai-sdk/pull/95))

### Features

* **agent:** stamp ws:* transport events with a monotonic reader id ([#95](https://github.com/coder/ai-sdk/issues/95)) ([11f88c2](https://github.com/coder/ai-sdk/commit/11f88c2446b2f94cdd71c48cd88790b0e546ba1a)), refs [#94](https://github.com/coder/ai-sdk/issues/94)

## [0.6.3](https://github.com/coder/ai-sdk/compare/agent-v0.6.2...agent-v0.6.3) (2026-08-25)

Adds a fix ensuring deferred revisions are flushed when a run finishes and revision suffixes are emitted in wire order, along with expanded durability documentation covering crash-safe client tools and result recovery.

### Highlights

- Deferred revisions are now flushed at finish, with revision suffixes emitted in wire order. ([#88](https://github.com/coder/ai-sdk/pull/88))
- The durability guide now documents crash-safe client tools and result recovery. ([#89](https://github.com/coder/ai-sdk/pull/89))

### Bug Fixes

* **agent:** flush deferred revisions at finish and emit revision suffixes in wire order ([#88](https://github.com/coder/ai-sdk/issues/88)) ([b5fd5fc](https://github.com/coder/ai-sdk/commit/b5fd5fc3ec50b73d2be45d5880fb118fa4863903))


### Documentation

* **agent:** crash-safe client tools and result recovery in the durability guide ([#89](https://github.com/coder/ai-sdk/issues/89)) ([0e65041](https://github.com/coder/ai-sdk/commit/0e6504197c7487e843005e937666be256f6653fc))

## [0.6.2](https://github.com/coder/ai-sdk/compare/agent-v0.6.1...agent-v0.6.2) (2026-08-25)

Documentation-only release that adds a session resumption and durability how-to and expands the workspaces and quota guide into an operational fleet sizing and troubleshooting reference.

### Highlights

- New how-to guide covering session resumption and durability for durable workflows. ([#84](https://github.com/coder/ai-sdk/pull/84))
- Expanded workspaces and quota documentation into an operational fleet sizing and troubleshooting guide. ([#81](https://github.com/coder/ai-sdk/pull/81))

### Documentation

* **agent:** expand workspaces & quota into an operational fleet sizing and troubleshooting guide ([#81](https://github.com/coder/ai-sdk/issues/81)) ([18ecf88](https://github.com/coder/ai-sdk/commit/18ecf88bef723378ebfe11e98518df4877566d16))
* **agent:** session resumption & durability how-to for durable workflows ([#84](https://github.com/coder/ai-sdk/issues/84)) ([b270c87](https://github.com/coder/ai-sdk/commit/b270c8735ec8066100a30681e7bd281a0fd1115d))

## [0.6.1](https://github.com/coder/ai-sdk/compare/agent-v0.6.0...agent-v0.6.1) (2026-08-24)

Fixes several correctness issues in snapshot reconciliation and settle/retry handling. Replayed and revised snapshots are now reconciled through a per-message emitted-content ledger, and corner cases around MCP-effectful exhaustion, frame-batched error status, and timeout settle classification are resolved.

### Highlights

- Replayed and revised snapshots are now reconciled correctly via a per-message emitted-content ledger. ([#77](https://github.com/coder/ai-sdk/pull/77))
- Fixed settle/retry corner cases involving the MCP-effectful exhaustion gate, frame-batched error status, and timeout settle classification. ([#75](https://github.com/coder/ai-sdk/pull/75))

### Bug Fixes

* **agent:** reconcile replayed and revised snapshots via a per-message emitted-content ledger ([#77](https://github.com/coder/ai-sdk/issues/77)) ([71f64bf](https://github.com/coder/ai-sdk/commit/71f64bf791e92dc641af16c2222ecb8f9f129db0))
* **agent:** settle/retry corner cases — MCP-effectful exhaustion gate, frame-batched error status, timeout settle classification ([#75](https://github.com/coder/ai-sdk/issues/75)) ([cf7d4ab](https://github.com/coder/ai-sdk/commit/cf7d4ab94937858135bb1a280c8111dd55c2616d))

## [0.6.0](https://github.com/coder/ai-sdk/compare/agent-v0.5.0...agent-v0.6.0) (2026-08-24)

Adds first-class transport observability hooks to the agent, giving developers built-in insight into transport-level activity.

### Highlights

- New first-class transport observability hooks let you monitor and instrument transport behavior directly. ([#70](https://github.com/coder/ai-sdk/pull/70))

### Features

* **agent:** first-class transport observability hooks ([#70](https://github.com/coder/ai-sdk/issues/70)) ([37f5862](https://github.com/coder/ai-sdk/commit/37f58620ec4f67dd96f0b05e51af5b7675f09fee))

## [0.5.0](https://github.com/coder/ai-sdk/compare/agent-v0.4.3...agent-v0.5.0) (2026-08-24)

Turn segments now share a single chat stream instead of opening a new one per segment, improving efficiency during multi-segment turns.

### Highlights

- The agent reuses one chat stream across turn segments rather than creating a separate stream for each. ([#64](https://github.com/coder/ai-sdk/pull/64))

### Features

* **agent:** reuse one chat stream across turn segments ([#64](https://github.com/coder/ai-sdk/issues/64)) ([7986e0c](https://github.com/coder/ai-sdk/commit/7986e0c28f22e6efa0f57f0f07a607b6e8498831))

## [0.4.3](https://github.com/coder/ai-sdk/compare/agent-v0.4.2...agent-v0.4.3) (2026-08-24)

This patch fixes several agent reliability issues around streaming and event handling, including recovering dropped chat streams and lost action_required events. It also exports TERMINAL_STATUSES at runtime and refreshes documentation.

### Highlights

- Dropped per-chat streams are now redialed instead of terminating the turn, improving resilience to connection interruptions. ([#55](https://github.com/coder/ai-sdk/pull/55))
- action_required events that were lost are now recovered from chat history. ([#62](https://github.com/coder/ai-sdk/pull/62))
- TERMINAL_STATUSES is now exported at runtime from the entry point. ([#61](https://github.com/coder/ai-sdk/pull/61))

### Bug Fixes

* **agent:** export TERMINAL_STATUSES at runtime from the entry point ([#61](https://github.com/coder/ai-sdk/issues/61)) ([cfe9bb2](https://github.com/coder/ai-sdk/commit/cfe9bb2dfcd78c5b6d33b746bddaee28038d740e)), refs [#56](https://github.com/coder/ai-sdk/issues/56)
* **agent:** recover lost action_required events from chat history ([#62](https://github.com/coder/ai-sdk/issues/62)) ([815de65](https://github.com/coder/ai-sdk/commit/815de6518a73d13237abeecc93b7fc627473882e))
* **agent:** redial a dropped per-chat stream instead of killing the turn ([#55](https://github.com/coder/ai-sdk/issues/55)) ([f4d1478](https://github.com/coder/ai-sdk/commit/f4d147873d8b217835d04bceca79e4758cbf4d3e))


### Documentation

* fix drift across READMEs and CONTRIBUTING ([#51](https://github.com/coder/ai-sdk/issues/51)) ([6c0001b](https://github.com/coder/ai-sdk/commit/6c0001b612830ca4d653a7ef828a7cd89c6b1f70))

## [0.4.2](https://github.com/coder/ai-sdk/compare/agent-v0.4.1...agent-v0.4.2) (2026-08-20)

Token consumption reporting now accounts for the entire turn rather than only the last step's uncached slice, giving accurate usage metrics.

### Highlights

- Fixed token consumption reporting to reflect the whole turn instead of just the last step's uncached slice. ([#40](https://github.com/coder/ai-sdk/pull/40))

### Bug Fixes

* **agent:** report the whole turn's token consumption, not the last step's uncached slice ([#40](https://github.com/coder/ai-sdk/issues/40)) ([1edacd3](https://github.com/coder/ai-sdk/commit/1edacd3aab52e2a4893ce51c648441120bea4a9d))

## [0.4.1](https://github.com/coder/ai-sdk/compare/agent-v0.4.0...agent-v0.4.1) (2026-08-18)

A maintenance release with no documented user-facing changes. Refer to the structured changelog below for details.

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
