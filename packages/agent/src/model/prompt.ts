import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";
import type { ChatInputPart, DynamicTool, ToolResult } from "../coder/types.js";

/** Concatenated system messages, mapped to chatd's `system_prompt`. */
export function extractSystemPrompt(prompt: LanguageModelV3Prompt): string | undefined {
  const parts = prompt.filter(
    (m): m is Extract<LanguageModelV3Message, { role: "system" }> => m.role === "system",
  );
  if (parts.length === 0) return undefined;
  const joined = parts
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  return joined.length > 0 ? joined : undefined;
}

/** The content array of a user message (text and file parts). */
export type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"];

/**
 * Uploads a file part's bytes and resolves to its chatd file id. Supplied by
 * the language model (which holds the client + organization id); kept abstract
 * here so {@link userContentToInputParts} stays pure and testable.
 */
export type FilePartUploader = (file: {
  data: Uint8Array | string | URL;
  mediaType: string;
  filename?: string;
}) => Promise<string>;

/** Reads a pre-uploaded file id from a file part's `providerOptions.coder.fileId`. */
function coderFileId(providerOptions: unknown): string | undefined {
  const coder = (providerOptions as { coder?: { fileId?: unknown } } | undefined)?.coder;
  return typeof coder?.fileId === "string" ? coder.fileId : undefined;
}

/**
 * Maps a user message's content to chatd input parts. Text passes through;
 * file parts are turned into `file` parts referencing an uploaded file id —
 * either reused from `providerOptions.coder.fileId` (a pre-uploaded handle) or
 * uploaded on the fly via {@link FilePartUploader}.
 */
export async function userContentToInputParts(
  content: UserContent,
  uploadFile: FilePartUploader,
): Promise<ChatInputPart[]> {
  const out: ChatInputPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) out.push({ type: "text", text: part.text });
    } else if (part.type === "file") {
      const fileId =
        coderFileId(part.providerOptions) ??
        (await uploadFile({
          data: part.data,
          mediaType: part.mediaType,
          filename: part.filename,
        }));
      out.push({ type: "file", file_id: fileId });
    }
  }
  return out;
}

function toolResultOutputToChatd(output: LanguageModelV3ToolResultOutput): {
  value: unknown;
  isError: boolean;
} {
  switch (output.type) {
    case "text":
      return { value: output.value, isError: false };
    case "json":
      return { value: output.value, isError: false };
    case "error-text":
      return { value: output.value, isError: true };
    case "error-json":
      return { value: output.value, isError: true };
    case "execution-denied":
      return { value: { execution_denied: true, reason: output.reason }, isError: true };
    case "content":
      return { value: output.value, isError: false };
    default:
      return { value: output, isError: false };
  }
}

export type TurnAction =
  | { kind: "new-turn"; content: UserContent }
  | { kind: "resume"; toolResults: ToolResult[] }
  | { kind: "noop" };

/**
 * Decides what to do with a fresh `doStream`/`doGenerate` prompt:
 *  - trailing `tool` message(s) → resume the in-flight chatd turn by submitting
 *    those tool results (the AI SDK executed a client tool between steps);
 *  - otherwise the trailing `user` message → a new turn.
 */
export function classifyTurnAction(prompt: LanguageModelV3Prompt): TurnAction {
  if (prompt.length === 0) return { kind: "noop" };
  const last = prompt[prompt.length - 1];
  if (!last) return { kind: "noop" };

  if (last.role === "tool") {
    const toolResults: ToolResult[] = [];
    // Collect from all trailing consecutive tool messages.
    for (let i = prompt.length - 1; i >= 0; i--) {
      const m = prompt[i];
      if (!m || m.role !== "tool") break;
      for (const part of m.content) {
        if (part.type !== "tool-result") continue;
        const { value, isError } = toolResultOutputToChatd(part.output);
        toolResults.unshift({ tool_call_id: part.toolCallId, output: value, is_error: isError });
      }
    }
    return { kind: "resume", toolResults };
  }

  if (last.role === "user") {
    return { kind: "new-turn", content: last.content };
  }

  return { kind: "noop" };
}

/** Maps AI SDK function tools to chatd client-executed ("dynamic") tools. */
export function toolsToDynamicTools(tools: LanguageModelV3CallOptions["tools"]): DynamicTool[] {
  if (!tools) return [];
  const out: DynamicTool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") continue; // provider tools are not forwarded
    out.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    });
  }
  return out;
}

/** The set of tool names the AI SDK side owns (i.e. client-executed). */
export function dynamicToolNames(tools: LanguageModelV3CallOptions["tools"]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type === "function") names.add(tool.name);
  }
  return names;
}
