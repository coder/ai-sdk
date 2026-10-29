# src

## Overview

This directory is the source root of `@coder/ai-sdk-agent`. `index.ts` is the package entry point
and re-exports the public API of the child directories. Five shared modules sit beside it:
`ai-version.ts` checks the installed `ai` major, `errors.ts` defines the error classes, `files.ts`
normalizes upload content, `transport-events.ts` defines the observability event types, and
`workspace-files.ts` defines the workspace file-store adapter types.

## Interface

- Child contracts:
  - [agent/EGM.md](./agent/EGM.md): `CoderAgent`, the AI SDK v7 `Agent` over one chatd chat.
  - [coder/EGM.md](./coder/EGM.md): `CoderChatClient` (REST), the `/stream` and `/watch`
    WebSocket readers, wire types, and workspace preview helpers.
  - [model/EGM.md](./model/EGM.md): `CoderLanguageModel` (`LanguageModelV4`), `TurnTranslator`,
    `SessionChatStream`, prompt and history mapping.
- `index.ts` re-exports, values: `CoderAgent`, `CoderLanguageModel`, `CoderChatClient`,
  `TurnTranslator`, `chatMessagesToUIMessages`, `streamChatEvents`, `watchChatEvents`,
  `resolveFileContent`, `dataContentToFileContent`, `CODER_PROVIDER_OPTIONS`,
  `classifyTurnAction`, `dynamicToolNames`, `extractSystemPrompt`, `toolsToDynamicTools`,
  `userContentToInputParts`, `CoderAgentError`, `CoderApiError`, `CoderChatError`,
  `CoderStreamError`, `CHAT_ATTACHMENT_MEDIA_TYPES`, `MAX_CHAT_FILE_SIZE_BYTES`,
  `TERMINAL_STATUSES` [agent/coder-agent.ts:CoderAgent] [coder/ws.ts:streamChatEvents]
  [errors.ts:CoderStreamError]
- `index.ts` re-exports, types: the `CoderAgent` settings and result types, `ChatAttachment`,
  the workspace preview types `WorkspacePreview`, `WorkspacePreviewOptions`,
  `SharedWorkspacePreview` and `SharePreviewOptions`, `CoderLanguageModelConfig`,
  `ChatFileInput`, `CoderChatClientOptions`, `UploadedChatFile`, `FileContent`, `ResolvedFile`,
  `WorkspaceFileStore`, `WorkspacePlacement`, `TurnTranslatorOptions`,
  `ChatMessagesToUIMessagesOptions`, the prompt types, `WatchChatEventsOptions`,
  `WebSocketFactory`, `WebSocketLike`, all transport event types, `PreviewShareLevel`, and every
  type in `./coder/types.js` (`export type *`) [agent/coder-agent.ts:WorkspacePreview]
  [coder/workspaces.ts:PreviewShareLevel]
- `index.ts` does not re-export `nextStreamReaderId`, `resolveWorkspacePreview`,
  `shareWorkspacePreview`, `SessionChatStream`, `assertSupportedAiVersion` or
  `safeTransportEmitter` [coder/ws.ts:nextStreamReaderId]
  [model/session-stream.ts:SessionChatStream]
- `CoderAgentError` (class extends `Error`): base error with optional `cause`
  [errors.ts:CoderAgentError]
- `CoderApiError` (class extends `CoderAgentError`): failed HTTP call with `status`, `detail`,
  `method`, `path` [errors.ts:CoderApiError]
- `CoderChatError` (class extends `CoderAgentError`): built from a `ChatErrorPayload`, with
  `kind`, `provider`, `retryable`, `statusCode` [errors.ts:CoderChatError]
- `CoderStreamError` (class extends `APICallError` from `@ai-sdk/provider`): the per-chat stream
  dropped and could not be re-established within its redial budget, or could not be safely
  resumed. Carries `chatId` [errors.ts:CoderStreamError]
- `assertSupportedAiVersion` (function, internal to the package): throws `CoderAgentError` when
  the installed `ai` major is not supported [ai-version.ts:assertSupportedAiVersion]
- `unsupportedAiVersionMessage` and `resetAiVersionCheckForTests` (functions, internal): build the
  error message for a version string, and clear the cached verdict
  [ai-version.ts:unsupportedAiVersionMessage]
- `resolveFileContent` (function): normalizes `FileContent` into a `ResolvedFile`
  (`body`, `mediaType`, `name`, `size`) [files.ts:resolveFileContent]
- `dataContentToFileContent` (function): converts AI SDK file data of type `"data"` or `"text"`
  to `FileContent` [files.ts:dataContentToFileContent]
- `FileContent` (type): `Blob | ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer`
  [files.ts:FileContent]
- `CoderTransportEvent` (type): union of the `http:request`, `http:response`, `http:error`,
  `ws:dial`, `ws:open`, `ws:event`, `ws:close`, `ws:error`, `ws:redial`, `segment:start` and
  `segment:settle` event interfaces [transport-events.ts:CoderTransportEvent]
- `TransportEventHandler` (type) and `CoderClientOperation` (type): the subscriber signature and
  the union of client operation names [transport-events.ts:TransportEventHandler]
- `safeTransportEmitter` (function, internal): wraps a handler so it swallows exceptions
  [transport-events.ts:safeTransportEmitter]
- `WorkspaceFileStore` (interface): `workspaceId` and `write({ content, path, signal? })`
  [workspace-files.ts:WorkspaceFileStore]
- `WorkspacePlacement` (interface): `{ workspaceId, path }` [workspace-files.ts:WorkspacePlacement]

## Invariants

- `SUPPORTED_AI_MAJOR` is `7`. The check passes when the parsed major equals 7 or cannot be parsed
  [ai-version.ts:unsupportedAiVersionMessage]
- The version check fails open: if `ai/package.json` cannot be read or has no string `version`,
  the check passes [ai-version.ts:resolveInstalledAiVersion]
- `assertSupportedAiVersion` caches its verdict in `cachedMessage` and throws the cached message
  on each later call when the version is unsupported [ai-version.ts:assertSupportedAiVersion]
- `CoderApiError` and `CoderChatError` extend `CoderAgentError`. `CoderStreamError` extends
  `APICallError` and is not a `CoderAgentError` [errors.ts:CoderStreamError]
- `CoderStreamError` defaults `isRetryable` to `true` [errors.ts:CoderStreamError]
- `CoderChatError.retryable` defaults to `false` when the payload omits it
  [errors.ts:CoderChatError]
- `CoderApiError` formats its message as `Coder API ${method} ${path} failed (${status}): ...`
  [errors.ts:CoderApiError]
- `resolveFileContent` prefers explicit `mediaType` and `name` over Blob metadata, sets `size` to
  `byteLength` for bytes and to `undefined` for a `ReadableStream`, and throws `CoderAgentError`
  for unsupported content or a missing media type [files.ts:resolveFileContent]
- `dataContentToFileContent` throws `CoderAgentError` for `"url"` data and provider references
  [files.ts:dataContentToFileContent]
- `safeTransportEmitter` returns `undefined` without a handler, so emit sites build no event
  objects. It catches sync throws and attaches a no-op `.catch` to async results
  [transport-events.ts:safeTransportEmitter]

## Side Effects

- `resolveInstalledAiVersion` reads `ai/package.json` through `createRequire(import.meta.url)`,
  only when `process.getBuiltinModule` exists [ai-version.ts:resolveInstalledAiVersion]
- Module-global state: `cachedMessage`, written by `assertSupportedAiVersion` and cleared by
  `resetAiVersionCheckForTests` [ai-version.ts:assertSupportedAiVersion]
- `safeTransportEmitter` calls the user handler synchronously [transport-events.ts:safeTransportEmitter]
- `errors.ts`, `files.ts`, `workspace-files.ts` and `index.ts` have no side effects. Network, timer
  and WebSocket effects live in the child directories [errors.ts:CoderAgentError]
  [files.ts:resolveFileContent] [workspace-files.ts:WorkspaceFileStore]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent test`
- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Unit tests: `packages/agent/test/unit/exports.test.ts`, `packages/agent/test/unit/ai-version.test.ts`,
  `packages/agent/test/unit/files.test.ts`, `packages/agent/test/unit/transport-events.test.ts`
