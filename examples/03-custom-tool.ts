// Custom (client-executed) tools. The model calls your tool; chatd pauses; the
// AI SDK runs your `execute` locally; the result is submitted back and chatd
// resumes. The die roll is un-guessable, so the model MUST call the tool.
//   tsx examples/03-custom-tool.ts   (or: pnpm example:tool)
import { tool } from "ai";
import { z } from "zod";
import { CoderAgent } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseUrl, token, organizationId } = await loadEnv();
// Tool-calling is more reliable on a stronger model; override with CODER_TOOL_MODEL.
const model = process.env.CODER_TOOL_MODEL ?? "sonnet";

const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  instructions:
    "You must use the provided tools. Never invent results you can only get from a tool.",
  tools: {
    rollDice: tool({
      description:
        "Roll an n-sided die and return the result. The result is not knowable without calling this.",
      inputSchema: z.object({
        sides: z.number().int().min(2).describe("number of sides on the die"),
      }),
      execute: async ({ sides }) => {
        const value = 1 + Math.floor(Math.random() * sides);
        console.log(`  [local tool] rollDice({ sides: ${sides} }) -> ${value}`);
        return { value, sides };
      },
    }),
  },
});

try {
  heading("custom tool round-trip");
  const result = await agent.generate({
    prompt: "Roll a 20-sided die using the tool, then tell me the number I rolled.",
  });

  const toolCalls = result.steps.flatMap((s) => s.toolCalls);
  console.log(
    "\nTool calls   :",
    toolCalls.map((c) => `${c.toolName}(${JSON.stringify(c.input)})`).join(", ") || "(none)",
  );
  console.log("Answer       :", result.text);
  console.log("Steps        :", result.steps.length, "(turn 1: tool call, turn 2: final answer)");
  console.log("Chat id      :", agent.chatId);
} finally {
  await agent.archive();
}
