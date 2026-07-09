import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatMessagePart, ChatMessagePartType } from "../../src/coder/types.js";
import { chatMessagesToUIMessages } from "../../src/model/history.js";

function msg(id: number, role: ChatMessage["role"], content?: ChatMessagePart[]): ChatMessage {
  return { id, chat_id: "c", role, created_at: "", content };
}

describe("chatMessagesToUIMessages — mixed turn", () => {
  it("maps a full turn and folds the role:tool result into the assistant tool part", () => {
    // Round-trip sanity: the annotation IS the contract — shapes must satisfy
    // the AI SDK's UIMessage types under typecheck.
    const messages: UIMessage[] = chatMessagesToUIMessages([
      msg(1, "user", [{ type: "text", text: "What's the weather in Paris?" }]),
      msg(2, "assistant", [
        { type: "reasoning", text: "Need the weather tool." },
        { type: "text", text: "Let me check." },
        {
          type: "tool-call",
          tool_call_id: "tc1",
          tool_name: "getWeather",
          args: { city: "Paris" },
        },
      ]),
      msg(3, "tool", [
        {
          type: "tool-result",
          tool_call_id: "tc1",
          tool_name: "getWeather",
          result: { tempC: 21 },
        },
      ]),
      msg(4, "assistant", [{ type: "text", text: "21°C and sunny." }]),
    ]);
    expect(messages).toEqual([
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "What's the weather in Paris?", state: "done" }],
      },
      {
        id: "2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Need the weather tool.", state: "done" },
          { type: "text", text: "Let me check.", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "getWeather",
            toolCallId: "tc1",
            state: "output-available",
            input: { city: "Paris" },
            output: { tempC: 21 },
          },
        ],
      },
      {
        id: "4",
        role: "assistant",
        parts: [{ type: "text", text: "21°C and sunny.", state: "done" }],
      },
    ]);
  });

  it("keeps consecutive assistant messages separate and preserves order", () => {
    const messages = chatMessagesToUIMessages([
      msg(5, "assistant", [{ type: "text", text: "one" }]),
      msg(6, "assistant", [{ type: "text", text: "two" }]),
    ]);
    expect(messages.map((m) => m.id)).toEqual(["5", "6"]);
    expect(messages.map((m) => m.parts.length)).toEqual([1, 1]);
  });

  it("maps system messages to role system with text parts", () => {
    const messages = chatMessagesToUIMessages([
      msg(1, "system", [{ type: "text", text: "You are helpful." }]),
    ]);
    expect(messages).toEqual([
      {
        id: "1",
        role: "system",
        parts: [{ type: "text", text: "You are helpful.", state: "done" }],
      },
    ]);
  });
});

describe("chatMessagesToUIMessages — tool calls", () => {
  it("maps a call without a persisted result to state input-available", () => {
    const messages = chatMessagesToUIMessages([
      msg(2, "assistant", [
        {
          type: "tool-call",
          tool_call_id: "tc1",
          tool_name: "getWeather",
          args: { city: "Paris" },
        },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: "getWeather",
        toolCallId: "tc1",
        state: "input-available",
        input: { city: "Paris" },
      },
    ]);
  });

  it("maps an is_error result to state output-error with errorText", () => {
    const messages = chatMessagesToUIMessages([
      msg(2, "assistant", [
        { type: "tool-call", tool_call_id: "tc1", tool_name: "run", args: { cmd: "ls" } },
      ]),
      msg(3, "tool", [
        {
          type: "tool-result",
          tool_call_id: "tc1",
          tool_name: "run",
          result: "command not found",
          is_error: true,
        },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: "run",
        toolCallId: "tc1",
        state: "output-error",
        input: { cmd: "ls" },
        errorText: "command not found",
      },
    ]);
  });

  it("stringifies non-string error results for errorText", () => {
    const messages = chatMessagesToUIMessages([
      msg(2, "assistant", [{ type: "tool-call", tool_call_id: "tc1", tool_name: "run", args: {} }]),
      msg(3, "tool", [
        {
          type: "tool-result",
          tool_call_id: "tc1",
          tool_name: "run",
          result: { message: "boom" },
          is_error: true,
        },
      ]),
    ]);
    const part = messages.at(0)!.parts.at(0)!;
    expect(part).toMatchObject({ state: "output-error", errorText: '{"message":"boom"}' });
  });

  it("passes provider_executed through and folds results inlined on the assistant snapshot", () => {
    const messages = chatMessagesToUIMessages([
      msg(2, "assistant", [
        {
          type: "tool-call",
          tool_call_id: "s1",
          tool_name: "read_file",
          args: { path: "/x" },
          provider_executed: true,
        },
        {
          type: "tool-result",
          tool_call_id: "s1",
          tool_name: "read_file",
          result: { content: "data" },
        },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: "read_file",
        toolCallId: "s1",
        providerExecuted: true,
        state: "output-available",
        input: { path: "/x" },
        output: { content: "data" },
      },
    ]);
  });

  it("produces no UIMessage for role:tool messages, even orphaned ones", () => {
    const messages = chatMessagesToUIMessages([
      msg(7, "tool", [
        { type: "tool-result", tool_call_id: "gone", tool_name: "web_search", result: { hits: 3 } },
      ]),
    ]);
    expect(messages).toEqual([]);
  });
});

describe("chatMessagesToUIMessages — sources", () => {
  it("maps sources to source-url parts, falls back sourceId to url, and skips url-less ones", () => {
    const messages = chatMessagesToUIMessages([
      msg(2, "assistant", [
        { type: "source", source_id: "s1", url: "https://a.example", title: "A" },
        { type: "source", url: "https://b.example" },
        { type: "source", source_id: "s3", title: "no url" },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      { type: "source-url", sourceId: "s1", url: "https://a.example", title: "A" },
      { type: "source-url", sourceId: "https://b.example", url: "https://b.example" },
    ]);
  });
});

describe("chatMessagesToUIMessages — files", () => {
  it("maps file parts through the fileUrl resolver", () => {
    const messages = chatMessagesToUIMessages(
      [msg(1, "user", [{ type: "file", file_id: "f1", media_type: "image/png", name: "cat.png" }])],
      { fileUrl: (part) => `https://coder.example/files/${part.file_id}` },
    );
    expect(messages.at(0)!.parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "cat.png",
        url: "https://coder.example/files/f1",
      },
    ]);
  });

  it("falls back to the part's own url and defaults the media type", () => {
    const messages = chatMessagesToUIMessages([
      msg(1, "user", [{ type: "file", file_id: "f1", url: "https://a.example/f1" }]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      { type: "file", mediaType: "application/octet-stream", url: "https://a.example/f1" },
    ]);
  });

  it("skips file parts when no url can be resolved", () => {
    const messages = chatMessagesToUIMessages([
      msg(1, "user", [
        { type: "file", file_id: "f1", media_type: "image/png" },
        { type: "text", text: "see attachment" },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([
      { type: "text", text: "see attachment", state: "done" },
    ]);
  });
});

describe("chatMessagesToUIMessages — forward compatibility", () => {
  it("skips file-reference/context-file/skill and unknown part kinds silently", () => {
    const messages = chatMessagesToUIMessages([
      msg(1, "user", [
        { type: "file-reference", file_id: "f1", file_name: "main.go" },
        { type: "context-file", file_name: "ctx.md", content: "…" },
        { type: "skill", skill_name: "review" },
        { type: "brand-new-kind" as ChatMessagePartType },
        { type: "text", text: "hi" },
      ]),
    ]);
    expect(messages.at(0)!.parts).toEqual([{ type: "text", text: "hi", state: "done" }]);
  });

  it("keeps the one-ChatMessage-to-one-UIMessage mapping for empty content", () => {
    const messages = chatMessagesToUIMessages([msg(1, "user"), msg(2, "assistant", [])]);
    expect(messages).toEqual([
      { id: "1", role: "user", parts: [] },
      { id: "2", role: "assistant", parts: [] },
    ]);
  });
});
