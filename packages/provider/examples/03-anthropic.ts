// Explicitly target AI Gateway's Anthropic surface (native Claude / Bedrock-Claude).
//   tsx examples/03-anthropic.ts   (or: pnpm example:anthropic)
import { generateText } from "ai";
import { createCoder } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseURL, apiKey } = loadEnv();

const coder = createCoder({ baseURL, apiKey });
const model = process.env.CODER_ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

// `coder.anthropic(...)` pins the Anthropic surface regardless of the id, so it
// also works for Bedrock-hosted Claude ids served on that surface.
heading(`anthropic surface — ${model}`);
const { text } = await generateText({
  model: coder.anthropic(model),
  prompt: "Name three things developers use Coder for. Be brief.",
});

console.log(text);
