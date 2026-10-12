/**
 * Effect Schema interop with the Vercel AI SDK's tool-definition and
 * structured-output surfaces.
 *
 * Why this exists: AI SDK v7's `tool()` / `generateObject()` accept Standard
 * Schema V1 values, but deriving the *wire* JSON schema from a standard schema
 * requires the optional `~standard.jsonSchema` converter — which
 * `Schema.toStandardSchemaV1` from `effect` does not emit. Passing a bare
 * Effect standard schema therefore throws `Standard schema vendor 'effect'
 * does not support JSON Schema conversion` inside the AI SDK.
 * {@link toAiSdkSchema} bridges the gap by pairing the Effect-derived JSON
 * schema with an Effect-Schema-backed validator in the AI SDK's own `Schema`
 * container, which every `FlexibleSchema` surface accepts.
 */
import type { JSONSchema7 } from "@ai-sdk/provider";
import * as Tool from "effect/ai/Tool";
import * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { jsonSchema, type Schema as AiSdkSchema } from "ai";

/**
 * Rewrite an `effect/ai` JSON schema (draft 2020-12, with any shared
 * definitions under `$defs`) as JSON Schema draft-07, the dialect of the AI
 * SDK's `JSONSchema7`.
 *
 * Effect's own `JsonSchema.toDocumentDraft07` does the rewrite (`$defs`
 * become `definitions`, tuples use array `items`) and throws on keywords
 * draft-07 cannot express, rather than emitting a schema the provider would
 * read differently.
 */
export const toDraft07 = (schema: JsonSchema.JsonSchema): JSONSchema7 => {
  const { $defs, ...root } = schema;
  // SAFETY: `effect/ai` puts the document's definitions, a JSON schema map,
  // under `$defs` (see `Tool.getJsonSchemaFromSchema`).
  const definitions = ($defs ?? {}) as JsonSchema.Definitions;
  const document = JsonSchema.toDocumentDraft07({
    dialect: "draft-2020-12",
    schema: root,
    definitions,
  });
  const result = { ...document.schema };
  if (Object.keys(document.definitions).length > 0) {
    result.definitions = document.definitions;
  }
  // SAFETY: a draft-07 document is what `JSONSchema7` describes; effect types
  // it as an open record.
  return result as JSONSchema7;
};

/**
 * Derive the wire JSON schema (draft-07) for an Effect Schema, using the same
 * derivation `effect/ai` uses for its own tool definitions.
 */
export const toJsonSchema = (schema: Schema.Top): JSONSchema7 =>
  toDraft07(Tool.getJsonSchemaFromSchema(schema));

/**
 * Bridge an Effect Schema to an AI SDK schema usable anywhere the AI SDK
 * accepts a `FlexibleSchema`: `tool({ inputSchema })`, `generateObject`,
 * `streamObject`, ... Validation decodes through the Effect Schema, so values
 * are fully decoded (defaults, transformations) and typed as `A` on the way
 * out — wire types in both directions stay consistent with the JSON schema.
 *
 * The schema must be synchronously decodable and context-free (no decoding
 * services); async schemas fail validation with a descriptive error.
 */
export const toAiSdkSchema = <A>(schema: Schema.Decoder<A>): AiSdkSchema<A> => {
  const decode = Schema.decodeUnknownResult(schema);
  return jsonSchema<A>(toJsonSchema(schema), {
    validate: (value) => {
      const result = decode(value);
      if (Result.isSuccess(result)) {
        return { success: true, value: result.success };
      }
      return { success: false, error: new Error(result.failure.toString()) };
    },
  });
};
