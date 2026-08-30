/**
 * Effect Schema interop with the Vercel AI SDK's tool-definition and
 * structured-output surfaces.
 *
 * Why this exists: AI SDK v7's `tool()` / `generateObject()` accept Standard
 * Schema V1 values, but deriving the *wire* JSON schema from a standard schema
 * requires the optional `~standard.jsonSchema` converter — which
 * `Schema.standardSchemaV1` from `effect` does not emit. Passing a bare Effect
 * standard schema therefore throws `Standard schema vendor 'effect' does not
 * support JSON Schema conversion` inside the AI SDK. {@link toAiSdkSchema}
 * bridges the gap by pairing the Effect-derived JSON schema with an
 * Effect-Schema-backed validator in the AI SDK's own `Schema` container, which
 * every `FlexibleSchema` surface accepts.
 */
import type { JSONSchema7 } from "@ai-sdk/provider";
import * as Tool from "@effect/ai/Tool";
import * as Either from "effect/Either";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import { jsonSchema, type Schema as AiSdkSchema } from "ai";

/**
 * Derive the wire JSON schema (draft-07) for an Effect Schema, using the same
 * derivation `@effect/ai` uses for its own tool definitions.
 */
export const toJsonSchema = (schema: Schema.Schema.Any): JSONSchema7 =>
  // SAFETY: effect's JsonSchema7 output is structurally a JSON Schema draft-07
  // document; only the nominal type differs from `JSONSchema7`.
  Tool.getJsonSchemaFromSchemaAst(schema.ast) as JSONSchema7;

/**
 * Bridge an Effect Schema to an AI SDK schema usable anywhere the AI SDK
 * accepts a `FlexibleSchema`: `tool({ inputSchema })`, `generateObject`,
 * `streamObject`, ... Validation decodes through the Effect Schema, so values
 * are fully decoded (defaults, transformations) and typed as `A` on the way
 * out — wire types in both directions stay consistent with the JSON schema.
 *
 * The schema must be synchronously decodable and context-free (`R = never`);
 * async or effectful schemas fail validation with a descriptive error.
 */
export const toAiSdkSchema = <A, I>(schema: Schema.Schema<A, I, never>): AiSdkSchema<A> => {
  const decode = Schema.decodeUnknownEither(schema);
  return jsonSchema<A>(toJsonSchema(schema), {
    validate: (value) => {
      const result = decode(value);
      if (Either.isRight(result)) {
        return { success: true, value: result.right };
      }
      return {
        success: false,
        error: new Error(ParseResult.TreeFormatter.formatErrorSync(result.left)),
      };
    },
  });
};
