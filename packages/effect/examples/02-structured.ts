/**
 * Structured output through the Effect `LanguageModel` bridge: the object is
 * generated against a JSON schema derived from the Effect Schema and decoded
 * back through it.
 *
 * Run with a real deployment:
 *
 *   CODER_URL=https://coder.example.com CODER_SESSION_TOKEN=... \
 *   CODER_MODEL=gpt-5.1 pnpm example:structured
 */
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CoderLanguageModel } from "../src/index.js";

const modelId = process.env.CODER_MODEL ?? "gpt-5.1";

const City = Schema.Struct({
  name: Schema.String,
  country: Schema.String,
  population: Schema.Number,
});

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateObject({
    prompt: "Describe the largest city in Germany.",
    objectName: "city",
    schema: City,
  });
  yield* Effect.log(JSON.stringify(response.value));
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
