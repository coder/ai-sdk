// Basic non-streaming generation.
//   tsx examples/01-generate.ts   (or: pnpm example:generate)
import { CoderAgent } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseUrl, token, organizationId, model } = await loadEnv();

const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  instructions: "You are a concise assistant. Answer in one or two sentences.",
});

try {
  heading("generate()");
  const result = await agent.generate({ prompt: "In one sentence, what is Coder?" });

  console.log("Answer       :", result.text);
  console.log("Finish reason:", result.finishReason);
  console.log("Steps        :", result.steps.length);
  console.log("Usage        :", JSON.stringify(result.usage));
  console.log("Chat id      :", agent.chatId);
} finally {
  // Clean up the chat we created (creates-and-archives; never touches workspaces).
  await agent.archive();
}
