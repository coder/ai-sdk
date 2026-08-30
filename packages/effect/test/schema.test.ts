import * as Schema from "effect/Schema";
import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { toAiSdkSchema, toJsonSchema } from "../src/schema.js";

const Weather = Schema.Struct({
  city: Schema.String,
  temperature: Schema.Number,
});

describe("toJsonSchema", () => {
  it("derives a draft-07 JSON schema from an Effect Schema", () => {
    expect(toJsonSchema(Weather)).toEqual({
      type: "object",
      required: ["city", "temperature"],
      properties: {
        city: { type: "string" },
        temperature: { type: "number" },
      },
      additionalProperties: false,
    });
  });
});

describe("toAiSdkSchema", () => {
  it("is accepted by the AI SDK's schema surface with the derived JSON schema", () => {
    const schema = asSchema(toAiSdkSchema(Weather));
    expect(schema.jsonSchema).toEqual(toJsonSchema(Weather));
  });

  it("validates and decodes through the Effect Schema (round trip)", async () => {
    // A transforming schema proves values are *decoded*, not just checked.
    const Transforming = Schema.Struct({
      city: Schema.String,
      temperature: Schema.NumberFromString,
    });
    const schema = toAiSdkSchema(Transforming);
    const result = await schema.validate?.({ city: "Berlin", temperature: "21" });
    expect(result).toEqual({ success: true, value: { city: "Berlin", temperature: 21 } });
  });

  it("reports schema violations as validation failures", async () => {
    const schema = toAiSdkSchema(Weather);
    const result = await schema.validate?.({ city: "Berlin" });
    expect(result?.success).toBe(false);
    if (result?.success === false) {
      expect(result.error.message).toContain("temperature");
    }
  });

  it("exists because bare Effect standard schemas cannot produce JSON schema", () => {
    // Pin the gap that motivates this bridge: `Schema.standardSchemaV1` emits
    // no `~standard.jsonSchema` converter, so the AI SDK cannot derive the
    // wire schema from it. If this starts passing, the bridge can be retired.
    const standard = asSchema(Schema.standardSchemaV1(Weather));
    expect(() => standard.jsonSchema).toThrow(/does not support JSON Schema conversion/);
  });
});
