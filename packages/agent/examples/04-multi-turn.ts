// Multi-turn session. One CoderAgent maps to one chatd chat, so server-side
// history carries across turns — the second turn recalls the first.
//   tsx examples/04-multi-turn.ts   (or: pnpm example:multi-turn)
import { CoderAgent } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseUrl, token, organizationId, model } = await loadEnv();

const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  instructions: "You are concise and remember what the user told you.",
});

try {
  heading("multi-turn session");

  const turn1 = await agent.generate({
    prompt: "Remember that my favorite color is teal. Reply with just 'ok'.",
  });
  console.log("Turn 1:", turn1.text);
  console.log("  chat:", agent.chatId);

  const turn2 = await agent.generate({ prompt: "What is my favorite color?" });
  console.log("Turn 2:", turn2.text);
  console.log("  chat:", agent.chatId, "(same chat reused as a session)");

  if (/teal/i.test(turn2.text))
    console.log("\n✓ The agent remembered across turns via server-side history.");
} finally {
  await agent.archive();
}
