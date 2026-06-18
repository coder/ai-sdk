// Basic non-streaming generation through AI Gateway.
//   tsx examples/01-generate.ts   (or: pnpm example:generate)
import { generateText } from "ai";
import { createCoder } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseURL, apiKey, model } = loadEnv();

const coder = createCoder({ baseURL, apiKey });

heading(`generateText() — ${model}`);
const { text, usage, finishReason } = await generateText({
  model: coder(model),
  prompt: "In one sentence, what is Coder?",
});

console.log("Answer       :", text);
console.log("Finish reason:", finishReason);
console.log("Usage        :", JSON.stringify(usage));
