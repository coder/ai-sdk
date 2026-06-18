import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  classifyTurnAction,
  dynamicToolNames,
  extractSystemPrompt,
  toolsToDynamicTools,
} from "../../src/model/prompt.js";

describe("classifyTurnAction", () => {
  it("treats a trailing user message as a new turn", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "user", content: [{ type: "text", text: "hi there" }] },
    ];
    const action = classifyTurnAction(prompt);
    expect(action.kind).toBe("new-turn");
    if (action.kind === "new-turn")
      expect(action.content).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("treats a trailing tool message as a resume with mapped tool results", () => {
    const prompt: LanguageModelV3Prompt = [
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
    const prompt: LanguageModelV3Prompt = [
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
    const prompt: LanguageModelV3Prompt = [
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

describe("toolsToDynamicTools / dynamicToolNames", () => {
  const tools: LanguageModelV3CallOptions["tools"] = [
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
