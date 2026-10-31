# src

## Overview

Source of `@coder/ai-sdk-sandbox`: a Vercel AI SDK v7 harness sandbox provider that runs
agent sessions inside Coder workspaces. `createCoderWorkspace` returns a
`HarnessV1SandboxProvider` whose sessions (`CoderWorkspaceSession`) run commands, move
files and forward ports through a pluggable `CoderTransport`. Two transports exist:

1. `CoderCliTransport` spawns the `coder` CLI and OpenSSH (`coder ssh --stdio` as the
   `ProxyCommand`).
2. `CoderNativeTransport` calls the Coder REST API with `fetch`, and runs commands and TCP
   streams through a Node.js relay program that it starts in a workspace-agent PTY over a
   WebSocket.

`index.ts` is the only published entry point. Every other export below is package-internal.

## Interface

Public (re-exported by `index.ts`):

- `createCoderWorkspace(settings)`: returns a provider with
  `specificationVersion: "harness-sandbox-v1"`, `providerId` `"coder-workspace"`,
  `createSession` and `resumeSession`. Wrap mode uses `settings.workspace`. Create mode
  (`settings.create`) provisions the workspace first. [coder-workspace-provider.ts:createCoderWorkspace]
- `ensureCoderWorkspace(settings)`: provisions or starts an explicitly named workspace
  without a harness session and returns `EnsuredCoderWorkspace` (`WorkspaceStatus` plus
  `created: boolean`). [coder-workspace-provider.ts:ensureCoderWorkspace]
- `CODER_WORKSPACE_PROVIDER_ID = "coder-workspace"`.
  [coder-workspace-provider.ts:CODER_WORKSPACE_PROVIDER_ID]
- Settings types `CoderWorkspaceSettings`, `CoderWorkspaceBaseSettings`,
  `CoderCreateSettings`, `CoderWorkspaceRef` (a string or `(sessionId) => string`),
  `EnsureCoderWorkspaceSettings`, `EnsuredCoderWorkspace`.
  [coder-workspace-provider.ts:CoderWorkspaceBaseSettings]
- Provider defaults: `ports` `[4000]`, `readyTimeoutMs` `300_000`, `create.namePrefix`
  `"agent"`, `create.ifExists` `"attach"`, `create.validate` `true`, `transport`
  `new CoderCliTransport()`, and `defaultWorkingDirectory` from the workspace `$HOME`
  (fallback `"/home/coder"`). [coder-workspace-provider.ts:DEFAULT_BRIDGE_PORT]
  [coder-workspace-provider.ts:createCoderWorkspace]
- `CoderWorkspaceSession` implements `HarnessV1NetworkSandboxSession`: `id`,
  `defaultWorkingDirectory`, `description`, `ports`, `run`, `spawn`, `readFile`,
  `readBinaryFile`, `readTextFile`, `writeFile`, `writeBinaryFile`, `writeTextFile`,
  `stat`, `listDirectory`, `deleteFile`, `getPortEndpoint`, `getPortUrl` (deprecated), `setPorts`, `stop`, `destroy`,
  `restricted`. [coder-workspace-session.ts:CoderWorkspaceSession]
- `CoderWorkspaceSessionConfig`: `transport`, `workspace`, `id`, `defaultWorkingDirectory`,
  `ports`, `ownsLifecycle`. [coder-workspace-session.ts:CoderWorkspaceSessionConfig]
- `CoderTransport`: `exec`, `spawn`, `forwardPort`, `start`, `stop`, `destroy`, `status`,
  `create`, `listPresets`. [transport.ts:CoderTransport]
- Transport data types: `WorkspaceStatus`, `WorkspaceAgentInfo`, `CreateWorkspaceOptions`,
  `ListPresetsOptions`, `PresetInfo`, `TransportExecOptions`, `ExecResult`,
  `SpawnedProcess`, `ForwardPortOptions`, `PortForward`, `LifecycleOptions`.
  [transport.ts:WorkspaceStatus]
- Open string unions: `WorkspaceBuildStatus` (`"pending"`, `"starting"`, `"running"`,
  `"stopping"`, `"stopped"`, `"failed"`, `"canceling"`, `"canceled"`, `"deleting"`,
  `"deleted"`), `WorkspaceAgentStatus` (`"connecting"`, `"connected"`, `"disconnected"`,
  `"timeout"`), `WorkspaceAgentLifecycle` (`"created"`, `"starting"`, `"start_timeout"`,
  `"start_error"`, `"ready"`, `"shutting_down"`, `"shutdown_timeout"`, `"shutdown_error"`,
  `"off"`). Each union also admits any other string. [transport.ts:WorkspaceBuildStatus]
- `CoderCliTransport` implements `CoderTransport`. Option defaults: `coderBinary` `"coder"`,
  `sshBinary` `"ssh"`, `env` `{}`, `loginShell` `true`, `waitMode` `"no"`,
  `silenceProxyStderr` `true`, `portForwardTimeoutMs` `30_000`. `url` and `token` have no
  default. [cli-transport.ts:CoderCliTransport] [cli-transport.ts:CoderCliTransportOptions]
- `CoderNativeTransport` implements `CoderTransport` and adds `close()`. Option defaults:
  `url` from `CODER_URL`, `token` from `CODER_SESSION_TOKEN`, `fetch` `globalThis.fetch`,
  `buildPollIntervalMs` `1_000`, `buildTimeoutMs` `30 * 60_000`, `relayConnectTimeoutMs`
  `30_000`, `relayNodeCommand` `"node"`, `loginShell` `true`. `headers` has no default and
  is sent on both HTTP and WebSocket requests.
  [native-transport.ts:CoderNativeTransport] [native-transport.ts:CoderNativeTransportOptions]
- `CoderNativeApiError`: `status`, `method`, `path`, `detail?`. Message format
  `Coder API ${method} ${path} failed (${status}): ${message}`.
  [native-api.ts:CoderNativeApiError]

Package-internal:

- `shellQuote`, `buildRemoteScript`. [shell.ts:shellQuote] [shell.ts:buildRemoteScript]
- `buildSshArgs`, `sshHostAlias`, `buildLocalForwardArgs`, `buildCreateArgs`,
  `parseWorkspaceRef`, `parseWorkspaceStatus`, `parsePresetsOutput`, `parsePresetList`.
  [cli-transport.ts:buildSshArgs]
- `file-io.ts` helpers used by the session: `resolveRemotePath`, `readBinaryFile`,
  `readFile`, `readTextFile`, `writeBinaryFile`, `writeFile`, `writeTextFile`, `stat`,
  `listDirectory`, `deleteFile`, `sliceLines`, `normalizeEncoding`. [file-io.ts:readBinaryFile]
- `CoderApiClient`, a REST client. `parseNativeWorkspaceRef`, `parseDurationMillis`.
  [native-api.ts:CoderApiClient]
- `NativeRelay`, `NativeSpawnedProcess`, `openNativePortForward`, `NATIVE_RELAY_SOURCE`,
  `NATIVE_RELAY_BOOTSTRAP_MARKER` (`"__CODER_AI_SDK_RELAY_BOOTSTRAP_READY_V1__"`).
  [native-relay.ts:NativeRelay]

## Invariants

Provider and session:

- Create mode with a derived name requires a non-empty `sessionId`. The name is
  `${sanitized prefix || "agent"}-${sha1(sessionId) hex, first 12 chars}`, cut to 32
  characters. A non-empty `create.owner` prefixes it as `owner/name`.
  [coder-workspace-provider.ts:deriveWorkspaceName]
- `sanitizeNameSegment` lowercases, turns each run of `[^a-z0-9]` into `-`, and trims
  leading and trailing `-`. [coder-workspace-provider.ts:sanitizeNameSegment]
- Lifecycle ownership: wrap mode uses `ownsLifecycle ?? false`. Create mode uses
  `ownsLifecycle ?? true` for a derived name, and additionally requires that this run
  created the workspace for an explicit name. [coder-workspace-provider.ts:createCoderWorkspace]
- `ensureCoderWorkspace` without `create` throws for a missing workspace. With `create`,
  the provider validates the preset (unless `validate` is `false`) and then creates it. An
  existing workspace with `ifExists: "error"` throws. Otherwise it reuses the workspace.
  [coder-workspace-provider.ts:ensureWorkspaceReady]
- `createCoderWorkspace` wrap mode does not check that the workspace exists or is ready.
  [coder-workspace-provider.ts:ensureWorkspace]
- `validatePreset` skips validation for an undefined preset or `"none"` in any case, a
  failed `listPresets`, or an empty preset list. Otherwise an unknown name throws and lists
  the available presets. [coder-workspace-provider.ts:validatePreset]
- A workspace counts as stopped when `buildStatus` is `"stopped"` or `"stopping"`, or
  `transition` is `"stop"`. Create mode and `ensureCoderWorkspace` start the workspace when
  it counts as stopped, then wait for readiness. [coder-workspace-provider.ts:isStopped]
  [coder-workspace-provider.ts:ensureWorkspaceReady]
- Wrap mode calls `transport.start` on every session build when `ensureStarted` is set. It
  does not check `isStopped` and does not wait for readiness.
  [coder-workspace-provider.ts:ensureWorkspace]
- `waitForReady` polls every 2000 ms. It succeeds when `buildStatus` is `"running"` and an
  agent is `"connected"` with lifecycle `"ready"`. It throws on build `"failed"`,
  `"canceled"` or `"deleted"`, agent `"start_error"` or `"start_timeout"`, and on timeout.
  [coder-workspace-provider.ts:waitForReady]
- `onFirstCreate` runs in `createSession` only when the provider created the workspace
  (create mode) or `ownsLifecycle` is `true` (wrap mode). `resumeSession` does not call it.
  [coder-workspace-provider.ts:createCoderWorkspace]
- `spawn` with `stdin: true` throws before it calls the transport.
  [coder-workspace-session.ts:CoderWorkspaceSession]
- `getPortEndpoint` throws after `stop` or `destroy`. It reuses a cached forward only while
  that forward is not `closed`, and returns `${scheme}://${localHost}:${localPort}` with
  scheme `ws` for `ws` and `http` for `http` and `https` (default protocol `ws`).
  [coder-workspace-session.ts:localScheme]
- `stop` and `destroy` close every port forward. They call `transport.stop` or
  `transport.destroy` only when `ownsLifecycle` is `true`. A second `stop` call returns
  early. `destroy` has no such guard.
  [coder-workspace-session.ts:CoderWorkspaceSession]
- `setPorts` closes the cached forwards for ports that are not in the new list.
  [coder-workspace-session.ts:CoderWorkspaceSession]

File I/O and shell:

- Relative paths join `defaultWorkingDirectory` with `path.posix.join`. Absolute paths pass
  through. [file-io.ts:resolveRemotePath]
- A read returns `null` when `[ -f path ]` fails (exit `66`). Any other non-zero exit
  throws. [file-io.ts:MISSING_FILE_EXIT] [file-io.ts:readBinaryFile]
- `run` and `spawn` resolve a relative `workingDirectory` the same way.
  [coder-workspace-session.ts:CoderWorkspaceSession]
- `stat` runs `stat -L` (`-c '%F|%s'`, BSD fallback `-f '%HT|%z'`) in the C locale,
  so it follows symlinks and needs no read permission. `stat`, `listDirectory` and
  `deleteFile` report a missing path (`null`, `null`, `false`) only for the ENOENT
  message (exit `66`). Other failures, such as a symlink loop or a permission
  error, throw. [file-io.ts:ENOENT_OR_FAIL] [file-io.ts:statScript]
- `listDirectory` throws for a non-directory (exit `67`). It enumerates with
  `find -mindepth 1 -maxdepth 1 -print0` under `pipefail`, so login-profile glob
  options do not apply and an unreadable directory throws. It reports symlinks as
  `symlink` and moves names as NUL-separated base64. [file-io.ts:listDirectory]
- `deleteFile` throws for a directory (exit `67`), runs `rm` with stdin from
  `/dev/null`, and removes a symlink itself. [file-io.ts:deleteFile]
- `sliceLines` uses 1-based, inclusive line numbers and clamps out-of-range bounds.
  [file-io.ts:sliceLines]
- `normalizeEncoding` maps known labels and returns `utf8` for unknown or missing labels.
  It does not throw. [file-io.ts:normalizeEncoding]
- `shellQuote` wraps a value in single quotes and escapes each `'` as `'\''`.
  [shell.ts:shellQuote]

CLI transport:

- `parseWorkspaceRef` accepts `[owner/]name[.agent]`, with a missing or empty owner
  becoming `me`. It throws on more than one `/` or a name segment (before the first `.`)
  that fails `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`. It does not validate the owner or agent parts.
  [cli-transport.ts:parseWorkspaceRef]
- The remote command is passed to OpenSSH as one argv element, prefixed `bash -lc` or
  `bash -c` by `loginShell`. [cli-transport.ts:buildSshArgs]
- `exec` returns non-zero exit codes. Lifecycle, `status`, `create` and `listPresets`
  throw on a non-zero `coder` exit. [cli-transport.ts:CoderCliTransport]
- A child that exits from a signal (`code === null`) reports `exitCode` `0` from `exec` and
  `spawn`, so a killed `ssh` looks like success. The native relay reports `128 + signal`
  instead. [cli-transport.ts:CoderCliTransport] [cli-transport.ts:toSpawnedProcess]
  [native-relay.ts:NATIVE_RELAY_SOURCE]
- `forwardPort` probes the local port every 200 ms until `portForwardTimeoutMs`. On early
  ssh exit, abort or timeout it sends `SIGTERM` to ssh and throws.
  [cli-transport.ts:waitForLocalPort]

Native transport and API:

- `CoderNativeTransport` throws when `url` or `token` is missing after the env fallback.
  `CoderApiClient` accepts only `http:` and `https:` URLs.
  [native-transport.ts:CoderNativeTransport] [native-api.ts:CoderApiClient]
- `request` follows at most 10 redirects (`MAX_API_REDIRECTS`) and throws on a redirect to
  a different origin, so the `Coder-Session-Token` header goes only to the configured
  origin. A non-ok response throws `CoderNativeApiError`. [native-api.ts:MAX_API_REDIRECTS]
- Workspace builds are polled until the job `succeeded`. `failed`, `canceled` (unless
  allowed) and the build timeout throw. `start`, `stop` and `destroy` are serialized per
  workspace inside one client. [native-api.ts:DEFAULT_BUILD_TIMEOUT_MS]
  [native-api.ts:CoderApiClient]
- `start` on a workspace whose latest build is a failed `start` first runs a cleanup
  `stop` build. It uses `template_active_version_id` for the start build when
  `automatic_updates` is `"always"` or `template_require_active_version` is set.
  [native-api.ts:CoderApiClient]
- Without `preset`, `create` applies the template's default preset, if one exists. The CLI
  `create` passes `--preset` only when `preset` is set. An unknown preset name (other than
  `"none"` in any case) throws, whatever `validate` is. `stopAfter` becomes `ttl_ms`.
  [native-api.ts:CoderApiClient] [cli-transport.ts:buildCreateArgs]
- `create` merges parameters in this order, later wins: parameter file, `parameters`,
  `ephemeralParameters`, preset values. [native-api.ts:CoderApiClient]
- A required parameter without a value throws. An optional, non-ephemeral parameter without
  a value takes its template default only when `useParameterDefaults` is `true` and
  `default_valid` is not `false`. Otherwise it throws. An optional ephemeral parameter
  without a value is left out. [native-api.ts:resolveCreateParameterValues]
- `resolveAgent` picks the agent named by `.agent`. Without `.agent` it picks the only
  agent and throws when the latest build has several agents or none.
  [native-api.ts:CoderApiClient]
- The parameter file is parsed as YAML (JSON is valid YAML) and must be a mapping.
  [native-api.ts:readParameterFile]
- `parseDurationMillis` accepts concatenated `<number>(ms|s|m|h)` segments such as `1h30m`.
  [native-api.ts:parseDurationMillis]
- Relays are cached per workspace reference and per agent and rebuilt when closed. A relay
  needs build status `"running"` and agent status `"connected"`.
  `forwardPort` requires an integer port from 1 to 65535. [native-transport.ts:CoderNativeTransport]
- `stop`, `destroy`, and `start` (when the build is not `"running"`) close that workspace's
  cached relays before the API call. [native-transport.ts:CoderNativeTransport]
- Relay frames are newline-delimited JSON with `v: 1`. These fail the relay and every open
  process and socket: an unparseable line after `ready`, a frame whose `v` is not 1, an
  `error` frame without an id, and any line (terminated or not) longer than 1,048,576
  characters (65,536 before `ready`).
  [native-relay.ts:PROTOCOL_FRAME_LIMIT] [native-relay.ts:BOOTSTRAP_FRAME_LIMIT]
- WebSocket backpressure pauses TCP sinks at 1 MiB buffered and resumes at 256 KiB.
  [native-relay.ts:CARRIER_HIGH_WATER_MARK] [native-relay.ts:CARRIER_LOW_WATER_MARK]
- Process stdin is sent in chunks of at most 64 KiB, or 16384 UTF-16 units for strings,
  without splitting a surrogate pair. [native-relay.ts:processInputChunk]
- `NativeRelay.connect` refuses a WebSocket redirect to a different origin and fails on
  abort or `connectTimeoutMs`. [native-relay.ts:NativeRelay.connect]

## Side Effects

- `CoderCliTransport` spawns `ssh` for `exec`, `spawn` and `forwardPort`, and `coder` for
  `list`, `create`, `start`, `stop`, `delete` and `templates presets list`. The child env is
  `process.env`, plus `CODER_URL` and `CODER_SESSION_TOKEN` from `url` and `token` when set,
  plus `env`. [cli-transport.ts:CoderCliTransport]
- The ssh `ProxyCommand` runs `coder ssh --stdio --wait=<mode> <workspace>` against host
  alias `coder.<workspace>`. Host key checking is off (`StrictHostKeyChecking=no`,
  `UserKnownHostsFile=/dev/null`). [cli-transport.ts:buildSshArgs] [cli-transport.ts:sshHostAlias]
- `forwardPort` (CLI) picks a free port on `127.0.0.1` and runs
  `ssh -N -L <local>:127.0.0.1:<remote>`. [cli-transport.ts:allocateLocalPort]
- `CoderApiClient` sends HTTP requests to `/api/v2/...` endpoints on the deployment,
  including `GET /api/v2/users/${owner}/workspace/${name}`,
  `POST /api/v2/workspaces/${workspaceId}/builds` and
  `POST /api/v2/users/${owner}/workspaces`. These change remote workspace state.
  [native-api.ts:CoderApiClient]
- `start` on a dormant workspace sends `PUT /api/v2/workspaces/${workspace.id}/dormant` with
  `{ dormant: false }` before the start build. A failed `start` build left as the latest
  build gets a cleanup `stop` build first. [native-api.ts:CoderApiClient]
- `NativeRelay.connect` opens a WebSocket to
  `/api/v2/workspaceagents/${agentId}/pty`, runs `exec bash -lc` with a bootstrap script,
  and starts `<relayNodeCommand> -e <NATIVE_RELAY_SOURCE>` in the workspace.
  [native-relay.ts:NativeRelay.connect] [native-relay.ts:relayBootstrapCommand]
- The remote relay spawns `bash -lc` or `bash -c` children (detached into their own
  process groups except on `win32`),
  signals the groups on `kill`, opens TCP connections to `127.0.0.1:<port>`, and on shutdown
  sends `SIGTERM` then `SIGKILL` after 500 ms. [native-relay.ts:NATIVE_RELAY_SOURCE]
- `openNativePortForward` listens on `127.0.0.1` on an ephemeral port and tunnels each
  connection through the relay. [native-relay.ts:openNativePortForward]
- File I/O runs `base64 < <file>` to read and `mkdir -p <dir> && base64 -d > <file>` to
  write, through `transport.exec`. Writes create parent folders and overwrite the file.
  [file-io.ts:readBinaryFile] [file-io.ts:writeBinaryFile]
- `readParameterFile` reads a local file when `parameterFile` is set.
  [native-api.ts:readParameterFile]
- The provider runs `printf %s "$HOME"` in the workspace unless `defaultWorkingDirectory`
  is set. [coder-workspace-provider.ts:resolveHomeDirectory]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-sandbox test`
- Run: `pnpm --filter @coder/ai-sdk-sandbox typecheck`
- Unit tests: `packages/sandbox/test/provider.test.ts`, `packages/sandbox/test/session.test.ts`,
  `packages/sandbox/test/cli-transport-args.test.ts`,
  `packages/sandbox/test/file-io-helpers.test.ts`, `packages/sandbox/test/shell.test.ts`,
  `packages/sandbox/test/native-api.test.ts`, `packages/sandbox/test/native-relay.test.ts`,
  `packages/sandbox/test/native-transport.test.ts`,
  `packages/sandbox/test/integration-local.test.ts`.
