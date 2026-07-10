import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  classifyTurnAction,
  dynamicToolNames,
  extractSystemPrompt,
  toolsToDynamicTools,
  type UserContent,
  userContentToInputParts,
} from "../../src/model/prompt.js";

describe("classifyTurnAction", () => {
  it("treats a trailing user message as a new turn", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "hi there" }] },
    ];
    const action = classifyTurnAction(prompt);
    expect(action.kind).toBe("new-turn");
    if (action.kind === "new-turn")
      expect(action.content).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("treats a trailing tool message as a resume with mapped tool results", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "t", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "t",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ];
    const action = classifyTurnAction(prompt);
    expect(action.kind).toBe("resume");
    if (action.kind === "resume") {
      expect(action.toolResults).toEqual([
        { tool_call_id: "tc1", output: { ok: true }, is_error: false },
      ]);
    }
  });

  it("maps error tool outputs to is_error", () => {
    const prompt: LanguageModelV4Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "x",
            toolName: "t",
            output: { type: "error-text", value: "boom" },
          },
        ],
      },
    ];
    const action = classifyTurnAction(prompt);
    if (action.kind === "resume") {
      expect(action.toolResults[0]).toEqual({ tool_call_id: "x", output: "boom", is_error: true });
    } else {
      throw new Error("expected resume");
    }
  });
});

describe("extractSystemPrompt", () => {
  it("joins system messages", () => {
    const prompt: LanguageModelV4Prompt = [
      { role: "system", content: "be terse" },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ];
    expect(extractSystemPrompt(prompt)).toBe("be terse");
  });
  it("returns undefined when no system message", () => {
    expect(
      extractSystemPrompt([{ role: "user", content: [{ type: "text", text: "q" }] }]),
    ).toBeUndefined();
  });
});

describe("userContentToInputParts", () => {
  it("passes non-empty text through and drops empty text", async () => {
    const content: UserContent = [
      { type: "text", text: "hello" },
      { type: "text", text: "" },
    ];
    const parts = await userContentToInputParts(content, async () => "unused");
    expect(parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("uploads a file part and emits a file input part with the returned id", async () => {
    const upload = vi.fn(async () => "file-123");
    const content: UserContent = [
      { type: "text", text: "summarize" },
      {
        type: "file",
        data: { type: "data", data: new Uint8Array([1, 2]) },
        mediaType: "application/pdf",
        filename: "r.pdf",
      },
    ];
    const parts = await userContentToInputParts(content, upload);

    expect(parts).toEqual([
      { type: "text", text: "summarize" },
      { type: "file", file_id: "file-123" },
    ]);
    expect(upload).toHaveBeenCalledWith({
      data: { type: "data", data: new Uint8Array([1, 2]) },
      mediaType: "application/pdf",
      filename: "r.pdf",
    });
  });

  it("reuses a pre-uploaded id from providerOptions.coder.fileId without uploading", async () => {
    const upload = vi.fn(async () => "unused");
    const content: UserContent = [
      {
        type: "file",
        data: { type: "data", data: "" },
        mediaType: "application/pdf",
        providerOptions: { coder: { fileId: "pre-789" } },
      },
    ];
    const parts = await userContentToInputParts(content, upload);

    expect(parts).toEqual([{ type: "file", file_id: "pre-789" }]);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("toolsToDynamicTools / dynamicToolNames", () => {
  const tools: LanguageModelV4CallOptions["tools"] = [
    {
      type: "function",
      name: "getWeather",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  it("maps function tools to chatd dynamic tools", () => {
    expect(toolsToDynamicTools(tools)).toEqual([
      { name: "getWeather", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
  });
  it("collects tool names", () => {
    expect([...dynamicToolNames(tools)]).toEqual(["getWeather"]);
  });
});
