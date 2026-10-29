# src/model

## Overview

This directory maps the AI SDK model protocol onto Coder chatd chats. `CoderLanguageModel`
(`language-model.ts`) is a `LanguageModelV4` backed by one chatd chat (the session). Each
`doStream` or `doGenerate` call runs one chatd segment: it creates the chat, posts a message or
submits tool results over REST, then reads the chat event stream until the chat settles or pauses
for client tools. `TurnTranslator` (`translate.ts`) turns one turn's `ChatStreamEvent`s into
`LanguageModelV4StreamPart`s. `SessionChatStream` (`session-stream.ts`) keeps one event stream
open across the segments of a turn. `prompt.ts` maps AI SDK prompts to chatd inputs, and
`history.ts` converts persisted chat messages to AI SDK `UIMessage`s.

The doc comments on `TurnTranslator` in `translate.ts` are the authoritative docs for dedup,
revision reconciliation and restarted generation attempts (issue #407). The behavior below is
deliberate design.

## Interface

- `CoderLanguageModel` (class, implements `LanguageModelV4`): `specificationVersion` `"v4"`,
  `provider` `"coder.chatd"`, `modelId` `config.model ?? "chatd"`
  [language-model.ts:CoderLanguageModel]
- `CoderLanguageModel.doStream` and `CoderLanguageModel.doGenerate`: run one segment as a
  `ReadableStream` of parts, or drain it into content, usage, finish reason, warnings and
  optional `providerMetadata`. `doGenerate` throws on the first `error` part
  [language-model.ts:CoderLanguageModel.doGenerate]
- Session getters `chatId`, `lastSeenMessageId` (resume cursor, `undefined` while 0),
  `lastKnownChatId` (cleanup target that survives `resetSession`) and `strandedChatIds` (a copy)
  [language-model.ts:CoderLanguageModel]
- `CoderLanguageModel.resetSession`: clears the chat id, cursor and submitted tool-call ids, and
  closes a retained stream without awaiting it [language-model.ts:CoderLanguageModel.resetSession]
- `CoderLanguageModel.closePausedStream`: closes the retained stream only when no segment is
  attached to it [language-model.ts:CoderLanguageModel.closePausedStream]
- `CoderLanguageModel.noteChatCleanedUp`: removes a chat id from the stranded set and clears
  `lastKnownChatId` when it matches [language-model.ts:CoderLanguageModel.noteChatCleanedUp]
- `CoderLanguageModel[Symbol.asyncDispose]`: awaits the close of a retained stream
  [language-model.ts:CoderLanguageModel]
- `CoderLanguageModelConfig` (interface): `client`, `organizationId`, `model`, `reasoningEffort`,
  `workspaceId`, `mcpServerIds`, `planMode`, `chatId`, `lastSeenMessageId`, `requestTimeoutMs`,
  `onTransportEvent` [language-model.ts:CoderLanguageModelConfig]
- `TurnTranslator` (class): `ingest(ev)` maps one event to zero or more parts. `finish()` returns
  the closing parts and one `finish` part. Getters: `terminalStatus`, `clientToolCallSeen`,
  `maxMessageId`, `error`, `turnCursor`, `awaitingQueuedSubmission`, `queuedSubmissionDeadEnd`,
  `settledAtPromotionBoundary` [translate.ts:TurnTranslator]
- `TurnTranslatorOptions` (interface): `dynamicToolNames`, `turnCursor?`,
  `submittedToolCallIds?`, `queuedSubmission?` (`{ id?, content? }`)
  [translate.ts:TurnTranslatorOptions]
- `SessionChatStream` (class): wraps one chat event generator for a turn. Members: `chatId`,
  `reader`, `closed`, `attached`, `canAttach`, `read`, `consumed`, `attach`, `pause`, `close`
  [session-stream.ts:SessionChatStream]
- `classifyTurnAction` (function) and `TurnAction` (type): classify a prompt as `new-turn`,
  `resume` (with tool results) or `noop` [prompt.ts:classifyTurnAction]
- Tool-result outputs map to chatd results: `error-text` and `error-json` set `is_error`,
  `execution-denied` becomes `{ execution_denied: true, reason }` with `is_error`, and `content`
  is flattened to one text string [prompt.ts:toolResultOutputToChatd]
- `userContentToInputParts` (function): maps user content to `ChatInputPart[]`. File parts reuse
  a non-empty `providerOptions.coder.fileId` or call the injected `FilePartUploader`. Empty text
  parts and other part types are dropped [prompt.ts:userContentToInputParts]
- `extractSystemPrompt`, `toolsToDynamicTools`, `dynamicToolNames` (functions): join system
  messages, map `function` tools to chatd `DynamicTool`s, and collect client tool names
  [prompt.ts:toolsToDynamicTools]
- `CODER_PROVIDER_OPTIONS` (const `"coder"`), `CoderFileProviderOptions`, `UserContent`,
  `FilePartUploader` (types) [prompt.ts:CODER_PROVIDER_OPTIONS]
- `chatMessagesToUIMessages` (function) and `ChatMessagesToUIMessagesOptions` (interface):
  convert persisted `ChatMessage[]` to `UIMessage[]`, with an optional `fileUrl(part)` resolver
  [history.ts:chatMessagesToUIMessages]

## Invariants

- Emitted-content ledger: `#emittedByMessageId` records, per assistant message id, the committed
  text and reasoning that the translator emitted. A byte-identical replay emits no text or
  reasoning. A snapshot whose text (or reasoning) does not extend the entry's text (or reasoning)
  emits none of that kind [translate.ts:TurnTranslator]
- `message_part` deltas carry no message id. Their text and reasoning join `#pending`, the
  current attempt's content as one ordered list of text and reasoning runs (`Segment`). While
  `#replay` is unset, each delta is emitted at once [translate.ts:TurnTranslator.#streamDelta]
- Attempt restart: `#restartAttempt` moves a non-empty `#pending` into `#replay` (the abandoned
  content that the AI SDK already got) when `#replay` is unset, then empties `#pending`. A
  `retry` event calls it, and `preview_reset` does not [translate.ts:TurnTranslator.#restartAttempt]
- Episodes: `#trackEpisode` records the episode (`history_version`:`generation_attempt`) of each
  assistant or tool `message_part` that carries both coordinates, and calls `#restartAttempt`
  when it differs from the recorded one. A part without both coordinates does not restart
  [translate.ts:TurnTranslator.#trackEpisode]
- Held-back deltas: while `#replay` is set, `#streamDelta` emits nothing for a delta that keeps
  `#pending` an in-order prefix of `#replay` (`isSegmentPrefix`), and unsets `#replay` when the
  two are equal. A delta that runs past `#replay` in order unsets it and emits only the part
  beyond it. Any other delta (other text, or another order of text and reasoning) unsets
  `#replay`, closes the open blocks and emits all of `#pending` from its start in new blocks, so
  the output is the abandoned content followed by the new attempt
  [translate.ts:TurnTranslator.#streamDelta]
- Commit reconciliation: an assistant snapshot on the attribution path (first sight, or a
  re-snapshot of the current message that is not deferred) compares each kind with its ledger
  entry plus the step's emitted deltas (`#replay`, else `#pending`). Outside the divergence cases
  below, a kind that extends it emits only the suffix beyond it. The path then empties `#pending`
  and unsets `#replay`, also when it suppresses a kind [translate.ts:TurnTranslator.#ingestMessage]
- Commit divergence: while `#replay` is set and the snapshot extends its ledger entry, a snapshot
  whose content beyond the entry does not extend `#replay` in order across both kinds
  (`contentSegments`, `isSegmentPrefix`) closes the open blocks and emits all of that content in
  new blocks. When `#replay` is unset, or the snapshot does not extend its entry, text that
  extends the entry but not the entry plus the emitted text is emitted in full beyond the entry,
  in a new text block. Such reasoning stays suppressed. In both cases the emitted content stays
  in the output, before the committed content [translate.ts:TurnTranslator.#ingestMessage]
- A revision of an earlier assistant message emits a suffix only when its content strictly extends
  the ledger, in its own closed block [translate.ts:TurnTranslator.#reconcileRevision]
- A same-id revision that arrives while the next step's deltas are open is deferred (latest wins)
  and reconciled when the next snapshot settles, before an `error` part, before a new client tool
  call, or in `finish` [translate.ts:TurnTranslator.#flushDeferredRevisions]
- Messages with an id at or below the effective turn cursor are skipped (no content, no usage).
  This filters replays, because redials reuse the turn's original `after_id`
  [translate.ts:TurnTranslator.#ingestMessage]
- Promotion boundary: a user-role snapshot past a non-zero effective cursor settles the turn,
  clears the recorded terminal status and freezes the translator, so `ingest` returns `[]` for
  later events. With a zero cursor, the first user snapshot (this turn's own prompt) becomes the
  cursor instead [translate.ts:TurnTranslator.#ingestMessage]
- Queued gate: for a queued submission, nothing is attributed until the queue entry appears as
  this turn's user message. An entry that leaves the queue without a match, or an `error` event
  while gated, sets `queuedSubmissionDeadEnd` (kind `queued_submission_lost`, non-retryable).
  The model throws it as a `CoderChatError` [translate.ts:TurnTranslator.#ingestGated]
- chatd server tools surface as `tool-call` parts with `providerExecuted` and `dynamic`, and
  `tool-result` parts with `dynamic`, deduplicated by call id. A result whose call was not
  emitted in the same segment is dropped [translate.ts:TurnTranslator.#emitServerToolResult]
- `source` parts are deduplicated by `source_id || url`, and a part without a url is skipped
  [translate.ts:TurnTranslator.#emitSource]
- Usage comes only from assistant messages, keyed by message id, so a revision replaces its entry.
  `USAGE_FIELD_KINDS` marks `context_limit` as newest-wins and the counters as summed. Unknown
  fields are newest-wins [translate.ts:accumulateUsage]
- Usage mapping: `inputTokens.total` is `input_tokens + cache_read_tokens +
  cache_creation_tokens`, and the accumulated wire usage, when present, is kept as `usage.raw`
  [translate.ts:mapUsage]
- `finish` adds `providerMetadata.coder` with `total_cost_micros` and `total_runtime_ms` when the
  usage has them [translate.ts:TurnTranslator.finish]
- Each client tool call from `action_required` is emitted at most once, and ids in
  `submittedToolCallIds` are skipped [translate.ts:TurnTranslator.ingest]
- Finish reason order: an `error` event or a terminal `error` status gives `"error"`, then a
  promotion boundary gives `"stop"`, then a client tool call or `requires_action` gives
  `"tool-calls"`, else `"stop"`. `raw` is the terminal status (undefined at a promotion boundary)
  [translate.ts:TurnTranslator.finish]
- Single flight: a turn that starts while another runs throws `CoderAgentError`
  [language-model.ts:CoderLanguageModel.#runTurnInner]
- A `noop` prompt throws `CoderAgentError`. A resume before a chat exists throws
  `CoderChatError` (`"cannot submit tool results before a chat exists"`)
  [language-model.ts:CoderLanguageModel.#runTurnInner]
- A consumer `cancel()` on the `doStream` stream aborts the segment (interrupting the server run)
  and ends the stream cleanly. A caller abort still errors the stream
  [language-model.ts:CoderLanguageModel.doStream]
- The constructor calls `assertSupportedAiVersion()`. `lastSeenMessageId` must be a safe integer
  above 0 and needs `chatId`, otherwise the constructor throws `CoderAgentError`
  [language-model.ts:CoderLanguageModel]
- Tool results whose call id was already submitted are not resubmitted
  [language-model.ts:CoderLanguageModel.#runTurnInner]
- `responseFormat.type === "json"` adds an unsupported-feature warning (`"responseFormat"`) to
  `stream-start` [language-model.ts:CoderLanguageModel.#runTurnInner]
- Stream retention: the segment keeps the stream open (`pause()`) only when the signal is not
  aborted, the status is `requires_action`, a client tool call was seen and there is no error.
  Other exits close it [language-model.ts:CoderLanguageModel.#runTurnInner]
- A resume segment re-attaches to the retained stream when `canAttach(chatId)` is true. Other
  segments close it and dial a new `SessionChatStream`
  [language-model.ts:CoderLanguageModel.#acquireStream]
- `requires_action` without a client tool call starts an `ACTION_REQUIRED_GRACE_MS` (`2_000`)
  timer, then REST recovery from the last assistant message
  [language-model.ts:CoderLanguageModel.#recoverRequiresAction]
- Errors: the per-segment `requestTimeoutMs` (one `doStream`/`doGenerate` call) gives a
  retryable `CoderChatError` (kind `"timeout"`). A stream end with no terminal status, no `error`
  event and no promotion boundary gives a retryable `CoderChatError` (kind `"stream_closed"`). A
  bare `CoderAgentError` thrown by the reader is wrapped the same way. A caller abort rethrows the
  abort reason [language-model.ts:CoderLanguageModel.#runTurnInner]
- `CoderStreamError` on a chat this call created strands that chat and resets the session. The
  error stays retryable only with no workspace, no MCP server and no uploaded attachment
  [language-model.ts:CoderLanguageModel.#runTurnInner]
- An unsettled teardown or abort interrupts the chat at most once per segment, and never after a
  promotion-boundary settle. A queued turn that never anchored deletes its queue entry instead,
  and does nothing when the entry has no id [language-model.ts:CoderLanguageModel.#runTurnInner]
- `SessionChatStream` keeps at most one `next()` call outstanding: `read()` returns the same
  promise until `consumed(p)` [session-stream.ts:SessionChatStream.read]
- `SessionChatStream.attach` throws `CoderAgentError` unless `canAttach(chatId)` is true and no
  segment is attached. `close()` is idempotent [session-stream.ts:SessionChatStream.attach]
- `classifyTurnAction` builds `resume` only from the trailing consecutive tool messages, and
  `new-turn` from a trailing user message [prompt.ts:classifyTurnAction]
- `chatMessagesToUIMessages` sorts output by numeric id, emits no message for `role: "tool"`, and
  folds tool results into `dynamic-tool` parts [history.ts:chatMessagesToUIMessages]

## Side Effects

- REST through `CoderChatClient`: `createChat` (with `client_type` `"api"`),
  `createChatMessage`, `submitToolResults`, `getMessages` (`limit: 1` for cursor seeding),
  `interruptChat` and `deleteQueuedMessage` (not awaited, errors swallowed)
  [language-model.ts:CoderLanguageModel.#runTurnInner]
- REST recovery: `getMessages(chatId, { limit: 200 })`
  [language-model.ts:CoderLanguageModel.#recoverRequiresAction]
- File uploads through `client.uploadChatFile` [language-model.ts:CoderLanguageModel.#buildContent]
- Model lookup through `client.resolveModelConfigId`, memoized per instance
  [language-model.ts:CoderLanguageModel.#resolveModelConfigId]
- WebSocket through `client.streamEvents` inside `SessionChatStream`, with a reader id from
  `nextStreamReaderId()` [language-model.ts:CoderLanguageModel.#acquireStream]
- Timers: `AbortSignal.timeout(requestTimeoutMs)` when positive, and `setTimeout` grace timers
  [language-model.ts:startGraceTimer]
- Transport events `segment:start` and `segment:settle` through `safeTransportEmitter`, only when
  `onTransportEvent` is configured [language-model.ts:CoderLanguageModel.#runTurn]
- `SessionChatStream.close` aborts its private `AbortController` and calls `events.return()`
  [session-stream.ts:SessionChatStream.close]
- `userContentToInputParts` calls the injected uploader for each file part without a reusable id
  [prompt.ts:userContentToInputParts]
- `translate.ts` and `history.ts` have no side effects. No env var reads, logging or module-level
  mutable state in this directory [translate.ts:TurnTranslator]

## Verification

- Run: `pnpm --filter @coder/ai-sdk-agent test`
- Run: `pnpm --filter @coder/ai-sdk-agent typecheck`
- Run: `.agents/skills/verify-agent-stream-exactly-once/check.sh` (the bounded exactly-once check
  of the stream path in `packages/agent/test/formal/`, not part of `pnpm test`)
- Unit tests: `packages/agent/test/unit/language-model.test.ts`,
  `packages/agent/test/unit/translate.test.ts`, `packages/agent/test/unit/session-stream.test.ts`,
  `packages/agent/test/unit/prompt.test.ts`, `packages/agent/test/unit/history.test.ts`,
  `packages/agent/test/unit/transport-events.test.ts`
