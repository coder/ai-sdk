import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import type { EditorialContext, EditorialInput } from "./types.js";

/** Model id; override with $RELEASE_NOTES_MODEL. Defaults to Claude Opus 4.8. */
export const MODEL_ID = process.env.RELEASE_NOTES_MODEL ?? "claude-opus-4-8";

/** The editorial fields the model produces (structure/links are rendered by release-please). */
export const ReleaseNotesSchema = z.object({
  summary: z
    .string()
    .describe(
      "1-3 plain sentences summarizing this release for developers. No heading or bullets.",
    ),
  highlights: z
    .array(
      z.object({
        text: z.string().describe("One reader-facing sentence describing a notable change."),
        prNumber: z
          .number()
          .nullable()
          .describe("The PR number for this change if known, otherwise null."),
      }),
    )
    .describe("The few most notable user-facing changes (0-5). Empty if nothing stands out."),
});

export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

/** Call the model to produce the editorial intro (summary + highlights). */
export async function generateEditorial(input: EditorialInput): Promise<ReleaseNotes> {
  const { object } = await generateObject({
    model: anthropic(MODEL_ID),
    schema: ReleaseNotesSchema,
    system: SYSTEM_PROMPT,
    prompt: renderUserPrompt(input),
  });
  return object;
}

/**
 * Render the editorial block (a summary paragraph + an optional "### Highlights"
 * list) that gets spliced in beneath release-please's version header. Returns an
 * empty string when there's nothing worth saying, signalling "no injection".
 *
 * Model-written text is flattened to a single line so it can't introduce a heading
 * line that release-please's changelog parser would mistake for a version boundary.
 */
export function renderEditorial(notes: ReleaseNotes, ctx: EditorialContext): string {
  const out: string[] = [];

  const summary = flatten(notes.summary);
  if (summary) {
    out.push(summary);
  }

  const highlights = notes.highlights
    .map((h) => ({ text: flatten(h.text), prNumber: h.prNumber }))
    .filter((h) => h.text);
  if (highlights.length > 0) {
    const host = (ctx.host || "https://github.com").replace(/\/+$/, "");
    out.push("", "### Highlights", "");
    for (const h of highlights) {
      const link =
        h.prNumber === null
          ? ""
          : ` ([#${h.prNumber}](${host}/${ctx.owner}/${ctx.repository}/pull/${h.prNumber}))`;
      out.push(`- ${h.text}${link}`);
    }
  }

  return out.join("\n").trim();
}

/** Collapse whitespace (incl. newlines) to single spaces so model prose stays one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
