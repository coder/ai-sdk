import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // The AI SDK chain stays external: `ai`/`zod` are peers, and the
  // sub-providers we compose are real runtime dependencies — never bundle them
  // (bundling would fork the LanguageModelV3 type identity from the consumer's).
  external: [
    "ai",
    "zod",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/provider",
    "@ai-sdk/provider-utils",
  ],
});
