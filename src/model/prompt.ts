import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";
import type { ChatInputPart, DynamicTool, ToolResult } from "../coder/types.js";

/** Concatenated system messages, mapped to chatd's `system_prompt`. */
export function extractSystemPrompt(prompt: LanguageModelV3Prompt): string | undefined {
  const parts = prompt.filter((m): m is Extract<LanguageModelV3Message, { role: "system" }> => m.role === "system");
  if (parts.length === 0) return undefined;
  const joined = parts.map((m) => m.content).join("\n\n").trim();
  return joined.length > 0 ? joined : undefined;
}

function userContentToInputParts(message: Extract<LanguageModelV3Message, { role: "user" }>): ChatInputPart[] {
  const out: ChatInputPart[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0) {
      out.push({ type: "text", text: part.text });
    }
    // NOTE: file/image input parts are not yet forwarded to chatd.
  }
  return out;
}

function toolResultOutputToChatd(output: LanguageModelV3ToolResultOutput): { value: unknown; isError: boolean } {
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
  | { kind: "new-turn"; content: ChatInputPart[] }
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
    return { kind: "new-turn", content: userContentToInputParts(last) };
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
