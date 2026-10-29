# src/coder

## Overview

This directory is the transport layer to Coder chatd. `client.ts` holds `CoderChatClient`, a typed
HTTP client for the chat REST API. It authenticates with the `Coder-Session-Token` header, emits
optional `http:*` transport events, and picks the `/api/v2/chats` or `/api/experimental/chats`
route prefix once per instance. `ws.ts` holds two WebSocket readers, returned as async
generators: `streamChatEvents` reads the per-chat `/stream` (replay dedup, redial backoff,
give-up budget), and `watchChatEvents` reads the per-user `/watch` (redials without a limit).
`types.ts` declares the snake_case wire types plus three runtime constants. `workspaces.ts` holds
small v2 REST helpers for workspace preview URLs and port sharing.

The doc comments on `streamChatEvents` and `watchChatEvents` in `ws.ts` are the authoritative
protocol docs for stream, replay and redial. The behavior below is deliberate design.

## Interface

- `CoderChatClient` (class): typed chat API client. `baseUrl` is the deployment URL with one
  trailing slash removed [client.ts:CoderChatClient]
- Chat methods: `createChat`, `getChat`, `createChatMessage`, `getMessages` (optional
  `before_id`, `after_id`, `limit`), `submitToolResults`, `interruptChat` (optional
  `{ wait: true }`), `deleteQueuedMessage`, `updateChat`, `archiveChat`
  [client.ts:CoderChatClient.createChat]
- File methods: `uploadChatFile` checks media type and size, then uploads a raw body.
  `getChatFile` downloads bytes and the media type (default `"application/octet-stream"`)
  [client.ts:CoderChatClient.uploadChatFile]
- `CoderChatClient.listModelConfigs`: lists model configs. The organization-scoped overload is
  primary. The overload without an organization is deprecated
  [client.ts:CoderChatClient.listModelConfigs]
- `CoderChatClient.resolveModelConfigId`: maps a UUID, `provider:model` id, bare model id,
  display-name substring or model-id substring (last fallback) to a config id, or returns
  `undefined`
  [client.ts:CoderChatClient.resolveModelConfigId]
- `CoderChatClient.streamEvents` and `CoderChatClient.watchChats`: return async generators that
  delegate to `streamChatEvents` and `watchChatEvents` [client.ts:CoderChatClient.streamEvents]
- `ChatFileInput`, `UploadedChatFile`, `CoderChatClientOptions` (interfaces): upload input, upload
  result, and client options (`baseUrl`, `token`, `fetch?`, `webSocketFactory?`,
  `onTransportEvent?`) [client.ts:CoderChatClientOptions]
- `streamChatEvents` (function): opens the per-chat `/stream` socket and returns an
  `AsyncGenerator<ChatStreamEvent>` [ws.ts:streamChatEvents]
- `watchChatEvents` (function): opens the per-user `/watch` socket and returns an
  `AsyncGenerator<ChatWatchEvent>` [ws.ts:watchChatEvents]
- `nextStreamReaderId` (function): returns the next module-global stream reader id
  [ws.ts:nextStreamReaderId]
- `WebSocketLike`, `WebSocketFactory`, `StreamChatEventsOptions`, `WatchChatEventsOptions`
  (types): the minimal socket shape, a pluggable socket constructor
  `(url, { headers }) => WebSocketLike`, and the reader options [ws.ts:WebSocketFactory]
- Wire request types: `CreateChatRequest`, `CreateChatMessageRequest`, `SubmitToolResultsRequest`,
  `ToolResult`, `UpdateChatRequest`, `DynamicTool`, `ChatInputPart` [types.ts:CreateChatRequest]
- Wire response types: `Chat`, `ChatMessage`, `ChatMessagePart` (one flat struct with a `type`
  field), `ChatMessageUsage`, `ChatMessagesResponse`, `CreateChatMessageResponse`,
  `ChatQueuedMessage`, `UploadChatFileResponse`, `ChatErrorPayload`, `ChatModelConfig`,
  `ChatModel`, `ChatModelProviderDescriptor`, `ChatUnsupportedProvider`,
  `OrganizationChatModelsResponse` [types.ts:ChatMessage]
- Stream types: `ChatStreamEvent`, `ChatStreamEventType` (`"message_part"`, `"message"`,
  `"status"`, `"error"`, `"queue_update"`, `"retry"`, `"action_required"`, `"preview_reset"`,
  `"history_reset"`), `ChatStreamMessagePart` (no message id field), `ChatStreamStatus`,
  `ChatStreamToolCall`, `ChatStreamActionRequired`, `ChatStreamRetry`, `ChatWatchEvent`,
  `ChatWatchEventKind` [types.ts:ChatStreamEventType]
- `ChatStatus` (type): `"waiting"`, `"pending"`, `"running"`, `"paused"`, `"completed"`,
  `"error"`, `"requires_action"`, `"interrupting"` [types.ts:ChatStatus]
- `TERMINAL_STATUSES` (const): `"waiting"`, `"completed"`, `"error"`, `"requires_action"`
  [types.ts:TERMINAL_STATUSES]
- `CHAT_ATTACHMENT_MEDIA_TYPES` (const set) and `ChatAttachmentMediaType` (type): the nine
  allowed upload media types [types.ts:CHAT_ATTACHMENT_MEDIA_TYPES]
- `MAX_CHAT_FILE_SIZE_BYTES` (const): `10 * 1024 * 1024` [types.ts:MAX_CHAT_FILE_SIZE_BYTES]
- Other literal types: `ChatClientType`, `ChatPlanMode`, `ChatBusyBehavior`, `ReasoningEffort`,
  `ChatMessageRole`, `ChatMessagePartType`, `ChatInputPartType` [types.ts:ReasoningEffort]
- `getWorkspace`, `getAppsHost`, `upsertPortShare` (functions): v2 workspace REST calls
  [workspaces.ts:upsertPortShare]
- `resolveWorkspacePreview` (function): builds the subdomain preview URL for a workspace port and
  returns the agent name it used [workspaces.ts:resolveWorkspacePreview]
- `shareWorkspacePreview` (function): resolves the preview URL, then upserts the port share
  (default share level `"authenticated"`) [workspaces.ts:shareWorkspacePreview]
- Workspace types: `WorkspaceApiConnection`, `WorkspaceSummary`, `AppHostResponse`,
  `PortShareLevel`, `PreviewShareLevel`, `PortShareProtocol`, `UpsertPortShareRequest`,
  `WorkspaceAgentPortShare`, `ResolvePreviewOptions`, `SharePreviewRequest`
  [workspaces.ts:PortShareLevel]

## Invariants

- Stream cursor: `streamChatEventsLoop` builds the `/stream` URL once, with
  `?after_id=${options.afterId}` from the original option, and every redial reuses it. The cursor
  is not advanced past yielded messages: chatd filters ids at or below `after_id` on initial sync,
  so an advanced cursor would lose same-id revision snapshots. `maxCommittedId` tracks progress
  only and never enters the URL [ws.ts:streamChatEventsLoop]
- Delta replay: on reconnect chatd replays the in-progress attempt's `message_part` deltas from
  `seq` 1. The reader drops a delta whose (`history_version`, `generation_attempt`) episode
  matches the last forwarded delta and whose `seq` is at or below the last forwarded `seq`. The
  filter runs at frame arrival, and each frame's `ws:event` carries the `forwarded` verdict
  [ws.ts:streamChatEventsLoop]
- The reader forwards `message` snapshots, replays included. Consumers must dedupe repeated
  `message` snapshots (`TurnTranslator` in `packages/agent/src/model/translate.ts` does)
  [ws.ts:streamChatEvents]
- `/stream` redial budget: only forward progress (a new tracked delta, or a new or changed
  message snapshot) resets the failure count and the backoff. When consecutive failures reach
  `STREAM_MAX_CONSECUTIVE_FAILURES` (`5`), the reader throws `CoderStreamError`
  [ws.ts:STREAM_MAX_CONSECUTIVE_FAILURES]
- An unparseable `/stream` frame is terminal by design: the reader throws `CoderAgentError`
  (`"failed to parse chat stream frame"`) without a redial, because a redial replays the same
  frame [ws.ts:streamChatEventsLoop]
- On `/stream`, an upgrade rejection with a 4xx status outside `TRANSIENT_UPGRADE_STATUSES`
  (`408`, `425`, `429`) is a terminal `CoderApiError`. Those three statuses use the redial budget
  [ws.ts:TRANSIENT_UPGRADE_STATUSES]
- On `/stream`, a drop while deltas without episode coordinates are outstanding throws
  `CoderStreamError` instead of a redial. A new committed `message` clears that state
  [ws.ts:streamChatEventsLoop]
- The non-replaying `/watch` redials past malformed frames: a parse failure ends only that
  connection (`"failed to parse chat watch frame"`). Every 4xx upgrade rejection is a terminal
  `CoderApiError`. `/watch` has no redial cap. A synchronously throwing `webSocketFactory`, or a
  route-prefix probe that throws while the signal is not aborted, ends `/watch` with that error
  and no redial [ws.ts:watchChatEventsLoop]
- On `/stream`, a synchronously throwing `webSocketFactory`, or a route-prefix probe that throws
  while the signal is not aborted, ends the reader with that error and no redial
  [ws.ts:streamChatEventsLoop]
- The generator wrappers abort an internal controller before `return()`, `throw()` or async
  dispose, so teardown closes the socket while a read is pending [ws.ts:streamChatEvents]
- A reader id is fixed at call time (`options.reader ?? nextStreamReaderId()`), so all redials of
  one reader share it [ws.ts:streamChatEvents]
- Route prefix: `#send` rewrites only paths at or under `"/api/v2/chats"`. A v2 404 retries once
  on `"/api/experimental/chats"`, unless a concurrent call has already locked v2. When both
  routes return 404, the client rethrows the v2 error and leaves the prefix unlocked. The first
  non-404 HTTP response locks the prefix with `??=`, and a locked prefix does not fall back.
  Network and abort errors do not lock it [client.ts:CoderChatClient.#send]
- With an `organizationId`, model listing uses the organization route and falls back to the
  legacy model-configs route only after a 404. When both routes return 404, it rethrows the
  organization route's error. The deprecated overloads without an organization call the legacy
  route directly. These routes do not touch the prefix lock
  [client.ts:CoderChatClient.#fetchModelConfigs]
- Every chat request sends `Coder-Session-Token`. Caller headers spread after it. A non-2xx
  response becomes `CoderApiError` with the message `body.message`, else `statusText` (an empty
  `statusText` gives `""`). `"request failed"` applies only when `statusText` is undefined
  [client.ts:CoderChatClient.#sendOnce]
- Transport events are built only when an `onTransportEvent` subscriber exists, and they carry no
  headers, so the token does not appear in them [client.ts:CoderChatClient.#sendOnce]
- `uploadChatFile` normalizes the media type and checks it against
  `CHAT_ATTACHMENT_MEDIA_TYPES` and a known size against `MAX_CHAT_FILE_SIZE_BYTES`. It throws
  `CoderAgentError` before any network call on a failed check. A `ReadableStream` body resolves
  the prefix first, so a probe never consumes the body [client.ts:CoderChatClient.uploadChatFile]
- `resolveModelConfigId` returns a UUID hint unchanged with no network call. Matching is
  case-insensitive and prefers enabled configs [client.ts:CoderChatClient.resolveModelConfigId]
- Preview ports must be integers from 1000 to 65535. The check runs before any network call
  [workspaces.ts:assertValidPort]
- `resolveWorkspacePreview` throws `CoderAgentError` when the app host is `""`
  [workspaces.ts:resolveWorkspacePreview]
- Without `agentName`, a workspace with zero agents or several agents throws `CoderAgentError`
  [workspaces.ts:defaultAgentName]
- `upsertPortShare` rethrows a 404 as `CoderApiError` `"port sharing is unavailable"` with a
  server-version hint [workspaces.ts:upsertPortShare]

## Side Effects

- REST, `CoderChatClient`: `POST /api/v2/chats`, `GET /api/v2/chats/${chatId}`,
  `PATCH /api/v2/chats/${chatId}` (`updateChat`, `archiveChat` with `{ archived: true }`)
  [client.ts:CoderChatClient.createChat]
- REST: `POST /api/v2/chats/${chatId}/messages`, `GET /api/v2/chats/${chatId}/messages`,
  `POST /api/v2/chats/${chatId}/tool-results`, `POST /api/v2/chats/${chatId}/interrupt`
  (`?wait=true` when requested), `DELETE /api/v2/chats/${chatId}/queue/${queuedMessageId}`
  [client.ts:CoderChatClient.interruptChat]
- REST: `POST /api/v2/chats/files?organization=${encodeURIComponent(organizationId)}`,
  `GET /api/v2/chats/files/${fileId}` [client.ts:CoderChatClient.getChatFile]
- REST: `GET /api/v2/organizations/${encodeURIComponent(organizationId)}/chats/models`, falling
  back to `GET /api/experimental/chats/model-configs` [client.ts:CoderChatClient.#fetchModelConfigs]
- REST: `GET /api/v2/chats` as the prefix probe, with the body cancelled
  [client.ts:CoderChatClient.#resolveApiPrefix]
- Each chat path can be resent once under `/api/experimental/chats` after a v2 404 while the
  prefix is unlocked [client.ts:CoderChatClient.#send]
- WebSocket: `${httpToWs(baseUrl)}${prefix}/${chatId}/stream` plus optional
  `?after_id=${options.afterId}` [ws.ts:streamChatEventsLoop]
- WebSocket: `${httpToWs(baseUrl)}${prefix}/watch` [ws.ts:watchChatEventsLoop]
- Default socket: `new NodeWebSocket(url, { headers })` from the `ws` package. Every dial sends the
  `Coder-Session-Token` handshake header, not a URL token [ws.ts:defaultFactory]
- Backoff timers: `STREAM_BACKOFF_INITIAL_MS` / `WATCH_BACKOFF_INITIAL_MS` (`1_000`) doubling to
  `STREAM_BACKOFF_CAP_MS` / `WATCH_BACKOFF_CAP_MS` (`30_000`). The `sleep` timer stays ref'd and an
  abort clears it [ws.ts:sleep]
- Module-global state: `readerSeq`, incremented by `nextStreamReaderId` [ws.ts:nextStreamReaderId]
- Transport events through `safeTransportEmitter`: `http:request`, `http:response`, `http:error`
  from the client, and `ws:dial`, `ws:open`, `ws:event`, `ws:error`, `ws:close`, `ws:redial` from
  `/stream` only. `/watch` emits none [ws.ts:streamChatEventsLoop]
- REST, workspaces: `GET /api/v2/workspaces/${workspaceId}`, `GET /api/v2/applications/host`,
  `POST /api/v2/workspaces/${workspaceId}/port-share` [workspaces.ts:getWorkspace]
- No env var reads and no console logging in this directory [client.ts:CoderChatClient]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent test`
- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Unit tests: `packages/agent/test/unit/client.test.ts`,
  `packages/agent/test/unit/workspaces.test.ts`,
  `packages/agent/test/unit/transport-events.test.ts`
