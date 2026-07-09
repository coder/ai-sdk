import type { DynamicToolUIPart, UIMessage } from "ai";
import type { ChatMessage, ChatMessagePart } from "../coder/types.js";

/** Options for {@link chatMessagesToUIMessages}. */
export interface ChatMessagesToUIMessagesOptions {
  /**
   * Resolves a persisted `file` part to a URL for its `FileUIPart`. Persisted
   * file parts carry only a `file_id` (no bytes, and usually no `url`), so
   * without a URL there is nothing for the UI to render and the part is
   * skipped. Download the bytes with `CoderChatClient.getChatFile(fileId)`
   * and return a data:/object/proxy URL here to keep attachments visible.
   * Returning `undefined` falls back to the part's own `url`, if any.
   */
  fileUrl?: (part: ChatMessagePart) => string | undefined;
}

function toolErrorText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  return JSON.stringify(result) ?? "";
}

function toDynamicToolPart(
  call: ChatMessagePart,
  result: ChatMessagePart | undefined,
): DynamicToolUIPart | undefined {
  const toolCallId = call.tool_call_id;
  const toolName = call.tool_name;
  if (!toolCallId || !toolName) return undefined;
  const providerExecuted = call.provider_executed ?? result?.provider_executed;
  const base = {
    type: "dynamic-tool" as const,
    toolName,
    toolCallId,
    ...(providerExecuted !== undefined ? { providerExecuted } : {}),
  };
  if (!result) return { ...base, state: "input-available", input: call.args };
  if (result.is_error) {
    return {
      ...base,
      state: "output-error",
      input: call.args,
      errorText: toolErrorText(result.result),
    };
  }
  return { ...base, state: "output-available", input: call.args, output: result.result };
}

function toUIParts(
  content: ChatMessagePart[],
  resultsByCallId: ReadonlyMap<string, ChatMessagePart>,
  opts: ChatMessagesToUIMessagesOptions | undefined,
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text ?? "", state: "done" });
        break;
      case "reasoning":
        parts.push({ type: "reasoning", text: part.text ?? "", state: "done" });
        break;
      case "tool-call": {
        const result = part.tool_call_id ? resultsByCallId.get(part.tool_call_id) : undefined;
        const ui = toDynamicToolPart(part, result);
        if (ui) parts.push(ui);
        break;
      }
      case "source":
        // `sourceId` is required by the AI SDK; fall back to the URL when the
        // wire part has no `source_id`. Without a URL there is nothing to
        // link, so the part is skipped.
        if (part.url) {
          parts.push({
            type: "source-url",
            sourceId: part.source_id || part.url,
            url: part.url,
            ...(part.title ? { title: part.title } : {}),
          });
        }
        break;
      case "file": {
        const url = opts?.fileUrl?.(part) ?? part.url;
        if (url) {
          parts.push({
            type: "file",
            mediaType: part.media_type ?? "application/octet-stream",
            ...(part.name ? { filename: part.name } : {}),
            url,
          });
        }
        break;
      }
      case "tool-result":
        // Folded into the originating `dynamic-tool` part above.
        break;
      default:
        // file-reference / context-file / skill / future kinds: no UI
        // equivalent; skip so history written by newer Coder servers
        // degrades gracefully.
        break;
    }
  }
  return parts;
}

/**
 * Converts persisted chat history (`CoderChatClient.getMessages`) into AI SDK
 * v6 `UIMessage`s, e.g. to rehydrate `useChat({ messages })` for an existing
 * chat. Pure and side-effect free.
 *
 * The mapping mirrors what a live-streamed transcript of the same turn looks
 * like, so rehydrated and live messages type identically:
 * - One `ChatMessage` becomes one `UIMessage` (ids stringified, order
 *   preserved), except `role: "tool"` messages: their `tool-result` parts are
 *   folded into the originating assistant `dynamic-tool` part and the message
 *   itself is dropped.
 * - `text`/`reasoning` parts map to their UI counterparts with
 *   `state: "done"` (history is complete, never streaming).
 * - `tool-call` parts become `dynamic-tool` parts — matching how server tools
 *   stream live (`dynamic: true`) — in state `"output-available"` once a
 *   result exists (`"output-error"` when it is marked `is_error`), or
 *   `"input-available"` while no result has been persisted yet.
 * - `source` parts become `source-url` parts; skipped when the wire part has
 *   no `url`.
 * - `file` parts become `file` UI parts only when a URL is available (see
 *   {@link ChatMessagesToUIMessagesOptions.fileUrl}): persisted file parts
 *   carry only a `file_id`, and `FileUIPart` requires a `url`. Parts without
 *   one are skipped.
 * - `file-reference` / `context-file` / `skill` / unknown part kinds have no
 *   UI equivalent and are skipped silently (forward compatible).
 */
export function chatMessagesToUIMessages(
  messages: ChatMessage[],
  opts?: ChatMessagesToUIMessagesOptions,
): UIMessage[] {
  // Pass 1: index tool results by call id. chatd persists results as separate
  // role:"tool" messages; scan every message so results inlined on assistant
  // snapshots fold identically.
  const resultsByCallId = new Map<string, ChatMessagePart>();
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool-result" || !part.tool_call_id) continue;
      if (!resultsByCallId.has(part.tool_call_id)) resultsByCallId.set(part.tool_call_id, part);
    }
  }

  // Pass 2: one UIMessage per ChatMessage, in order. role:"tool" messages were
  // folded above and produce none.
  const out: UIMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    out.push({
      id: String(message.id),
      role: message.role,
      parts: toUIParts(message.content ?? [], resultsByCallId, opts),
    });
  }
  return out;
}
