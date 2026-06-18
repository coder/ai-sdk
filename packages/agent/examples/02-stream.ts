// Streaming generation — tokens arrive incrementally via `textStream`.
//   tsx examples/02-stream.ts   (or: pnpm example:stream)
import { CoderAgent } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseUrl, token, organizationId, model } = await loadEnv();

const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  instructions: "Be vivid but brief.",
});

try {
  heading("stream()");
  const result = await agent.stream({
    prompt: "Describe a sunrise over the mountains in three sentences.",
  });

  process.stdout.write("\n");
  for await (const delta of result.textStream) process.stdout.write(delta);
  process.stdout.write("\n\n");

  console.log("Steps        :", (await result.steps).length);
  console.log("Finish reason:", await result.finishReason);
  console.log("Chat id      :", agent.chatId);
} finally {
  await agent.archive();
}
