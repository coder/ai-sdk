/**
 * Minimal text generation through the Effect `LanguageModel` bridge.
 *
 * Run with a real deployment:
 *
 *   CODER_URL=https://coder.example.com CODER_SESSION_TOKEN=... \
 *   CODER_MODEL=gpt-5.1 pnpm example:generate
 */
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import { CoderLanguageModel } from "../src/index.js";

const modelId = process.env.CODER_MODEL ?? "gpt-5.1";

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: "In one sentence, what is Coder AI Gateway?",
  });
  yield* Effect.log(response.text);
  yield* Effect.log(`finishReason=${response.finishReason}`);
  yield* Effect.log(`usage=${JSON.stringify(response.usage)}`);
});

program.pipe(
  Effect.provide(
    CoderLanguageModel.layer(modelId, {
      baseURL: process.env.CODER_URL ?? "https://coder.example.com",
      apiKey: process.env.CODER_SESSION_TOKEN,
    }),
  ),
  Effect.runPromise,
);
