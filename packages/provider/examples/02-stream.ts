// Streaming generation through AI Gateway.
//   tsx examples/02-stream.ts   (or: pnpm example:stream)
import { streamText } from "ai";
import { createCoder } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

const { baseURL, apiKey, model } = loadEnv();

const coder = createCoder({ baseURL, apiKey });

heading(`streamText() — ${model}`);
const result = streamText({
  model: coder(model),
  prompt: "Write a short haiku about remote development environments.",
});

for await (const delta of result.textStream) process.stdout.write(delta);
process.stdout.write("\n");

console.log("Usage        :", JSON.stringify(await result.usage));
