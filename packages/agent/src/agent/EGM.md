# src/agent

## Overview

This directory holds `CoderAgent`, the public entry point of `@coder/ai-sdk-agent`. `CoderAgent`
is an AI SDK v7 `Agent` (`version` `"agent-v1"`). It wraps an AI SDK `ToolLoopAgent` whose model
is a `CoderLanguageModel` from `../model`. One `CoderAgent` instance maps to one Coder chatd chat
(the session). The class also adds cleanup helpers (interrupt, archive, `Symbol.asyncDispose`),
file helpers (chat attachments, workspace uploads) and workspace preview URL helpers. The class
does its I/O through `CoderChatClient` (`../coder/client.ts`), the `../coder/workspaces.ts`
helpers and the caller-supplied `WorkspaceFileStore`. This file has no URL literals.

## Interface

- `CoderAgent` (class, implements `Agent<never, TOOLS>`): the constructor resolves credentials,
  builds or accepts a `CoderChatClient`, then builds a `CoderLanguageModel` and an inner
  `ToolLoopAgent` [coder-agent.ts:CoderAgent]
- `CoderAgent.generate` and `CoderAgent.stream`: forward to the inner `ToolLoopAgent`
  [coder-agent.ts:CoderAgent.generate]
- Getters `id` and `tools` forward to the inner agent. `client` returns the `CoderChatClient`.
  `chatId`, `lastSeenMessageId`, `lastKnownChatId` and `strandedChatIds` read session state
  from the model [coder-agent.ts:CoderAgent]
- `CoderAgent.listModels`: calls `client.listModelConfigs(organizationId, signal)`
  [coder-agent.ts:CoderAgent.listModels]
- `CoderAgent.resetSession`: calls `model.resetSession()`, so the next turn starts a new chat
  [coder-agent.ts:CoderAgent.resetSession]
- `CoderAgent.interrupt`: closes a paused stream, then calls `client.interruptChat` on the
  session chat or the last-known chat. Returns `CoderInterruptResult`
  [coder-agent.ts:CoderAgent.interrupt]
- `CoderAgent.archive`: archives the stranded chats, then the primary chat, and retries 409
  responses inside one shared deadline. Returns `CoderArchiveResult`
  [coder-agent.ts:CoderAgent.archive]
- `CoderAgent[Symbol.asyncDispose]`: best-effort cleanup in the order model dispose, interrupt,
  archive [coder-agent.ts:CoderAgent]
- `CoderAgent.attach`: uploads a file with `client.uploadChatFile` and returns a
  `ChatAttachment` [coder-agent.ts:CoderAgent.attach]
- `CoderAgent.uploadToWorkspace`: writes content with the configured `workspaceFiles.write`
  and returns `{ workspaceId, path }` [coder-agent.ts:CoderAgent.uploadToWorkspace]
- `CoderAgent.getPreview` and `CoderAgent.sharePreview`: resolve a workspace port preview URL
  through `resolveWorkspacePreview`, or upsert its share level through `shareWorkspacePreview`
  [coder-agent.ts:CoderAgent.getPreview]
- `CoderAgentSettings` (interface): constructor settings. Connection: `client`, `baseUrl`,
  `token`, `fetch`, `webSocketFactory`, `onTransportEvent`. Chat: `organizationId`, `model`,
  `reasoningEffort`, `workspaceId`, `workspaceFiles`, `mcpServerIds`, `planMode`, `chatId`,
  `lastSeenMessageId`. Agent: `id`, `instructions`, `tools`, `toolsContext`, `toolChoice`,
  `stopWhen`, `maxRetries`, `requestTimeoutMs`, `settleDeadlineMs`, `settleRetryDelayMs`
  [coder-agent.ts:CoderAgentSettings]
- `ChatAttachment` (interface): an `UploadedChatFile` plus `toFilePart()`, which returns an AI
  SDK file part that carries the uploaded id in `providerOptions.coder.fileId`
  [coder-agent.ts:ChatAttachment]
- `CoderInterruptResult` and `CoderArchiveResult` (types): `{ interrupted: true; chatId }` or
  `{ interrupted: false }`, and `{ archived: true; chatId; archivedChatIds }` or
  `{ archived: false }` [coder-agent.ts:CoderArchiveResult]
- `WorkspacePreviewOptions`, `WorkspacePreview`, `SharePreviewOptions`,
  `SharedWorkspacePreview` (interfaces): preview helper inputs (`port`, `agentName?`,
  `protocol?` `"http"` or `"https"`, `signal?`, `shareLevel?`) and outputs (`url`, `shareLevel`)
  [coder-agent.ts:SharePreviewOptions]
- Internal: `makeChatAttachment` builds the attachment file part with `data: ""`
  [coder-agent.ts:makeChatAttachment]. `archiveWhenSettled` archives one chat with 409 retries
  [coder-agent.ts:archiveWhenSettled]. `sanitizeDelayMs` clamps timer values
  [coder-agent.ts:sanitizeDelayMs]. `sleep` is an abort-aware `setTimeout` promise
  [coder-agent.ts:sleep]

## Invariants

- The constructor calls `assertSupportedAiVersion()` first, so an unsupported `ai` major fails
  at construction [coder-agent.ts:CoderAgent]
- Explicit `baseUrl` and `token` settings win over `CODER_URL` and `CODER_SESSION_TOKEN`. With no
  `client` and no resolved `baseUrl` plus `token`, the constructor throws `CoderAgentError`
  [coder-agent.ts:CoderAgent]
- With a supplied `client`, the agent does not use `fetch` and `webSocketFactory` for chat
  traffic. The agent forwards `onTransportEvent` only to the model, which emits only `segment:*`
  events. `fetch` still serves the preview helpers' REST connection [coder-agent.ts:CoderAgent]
- A `lastSeenMessageId` that is not a positive safe integer, or one set without `chatId`, makes
  the constructor throw `CoderAgentError` (validated by `CoderLanguageModel`)
  [../model/language-model.ts:CoderLanguageModel]
- The constructor reads the environment through `globalThis.process?.env`, so it does not throw a
  `ReferenceError` where `process` is missing [coder-agent.ts:CoderAgent]
- If `workspaceFiles` and `workspaceId` are both set and `workspaceFiles.workspaceId` differs, the
  constructor throws `CoderAgentError` [coder-agent.ts:CoderAgent]
- The inner agent defaults `stopWhen` to `isStepCount(64)` and `maxRetries` to `0`. SDK-level
  retries can duplicate a server-side turn [coder-agent.ts:DEFAULT_STOP]
- Settle timings default to `SETTLE_DEADLINE_MS` (`15_000`) and `SETTLE_RETRY_DELAY_MS`
  (`1_000`). `sanitizeDelayMs` replaces undefined, NaN, negative or non-finite values with the
  default (except `+Infinity`, which becomes `2**31-1`), and floors and caps other values at
  `2**31-1` [coder-agent.ts:sanitizeDelayMs]
- `interrupt` and `archive` target `model.chatId ?? model.lastKnownChatId`. With neither, they
  return `{ interrupted: false }` or `{ archived: false }` and make no server call. Both call
  `model.closePausedStream()` before the server call [coder-agent.ts:CoderAgent.archive]
- `archive` archives the deduplicated `strandedChatIds` (oldest first), then the primary chat,
  inside one deadline. It calls `model.noteChatCleanedUp(id)` only after that chat's archive
  succeeds. A failure rethrows and leaves the remaining ids as targets. Each target gets only the
  remaining batch budget, floored at 1 ms, so a target that starts after the window closes gets
  a 1 ms budget [coder-agent.ts:CoderAgent.archive]
- `archiveWhenSettled` retries only `CoderApiError` with status 409. It rethrows other errors at
  once, and rethrows the last 409 when the next pause would pass the deadline. Each archive
  request also aborts on `AbortSignal.timeout(opts.deadlineMs)`, combined with the caller signal
  [coder-agent.ts:archiveWhenSettled]
- `[Symbol.asyncDispose]` does not throw: model dispose, interrupt and archive each run in their
  own `try`/`catch`. `interrupt` and `archive` share one `AbortSignal.timeout(settleDeadlineMs)`,
  which is created after model dispose [coder-agent.ts:CoderAgent]
- `getPreview` and `sharePreview` need `workspaceId` and a REST connection (resolved `baseUrl` and
  `token`, even when `client` is supplied). Otherwise they throw `CoderAgentError`
  [coder-agent.ts:CoderAgent]
- `uploadToWorkspace` throws `CoderAgentError` when no `workspaceFiles` adapter is configured
  [coder-agent.ts:CoderAgent.uploadToWorkspace]

## Side Effects

- Reads the env vars `CODER_URL` and `CODER_SESSION_TOKEN` when the matching setting is absent
  [coder-agent.ts:CoderAgent]
- Network, through the inner `CoderLanguageModel` (see `../model`): `generate` and `stream` send
  each turn's chat REST and WebSocket traffic on the same `CoderChatClient`
  [coder-agent.ts:CoderAgent.generate]
- Network, delegated to `CoderChatClient`: `listModelConfigs`, `interruptChat`, `archiveChat`,
  `uploadChatFile`. Routes are defined in `../coder/client.ts` [coder-agent.ts:CoderAgent]
- Network, delegated to `resolveWorkspacePreview` and `shareWorkspacePreview` in
  `../coder/workspaces.ts` [coder-agent.ts:CoderAgent.sharePreview]
- Writes to the workspace filesystem through the caller-supplied `WorkspaceFileStore.write`
  [coder-agent.ts:CoderAgent.uploadToWorkspace]
- Timers: `sleep` waits between 409 retries. `archiveWhenSettled` and `[Symbol.asyncDispose]`
  create `AbortSignal.timeout` deadlines [coder-agent.ts:sleep]
- Mutates model session state through `resetSession`, `closePausedStream`, `noteChatCleanedUp`
  and the model's `[Symbol.asyncDispose]`, which releases a retained WebSocket stream
  [coder-agent.ts:CoderAgent]
- No logging. `[Symbol.asyncDispose]` swallows errors silently [coder-agent.ts:CoderAgent]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent test`
- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Unit tests: `packages/agent/test/unit/agent.test.ts`
