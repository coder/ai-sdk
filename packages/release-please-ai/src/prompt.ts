import type { EditorialInput } from "./types.js";

export const SYSTEM_PROMPT = `You are a release-notes editor for an open-source TypeScript library.
You are given the list of changes for a SINGLE package being released from a monorepo
(the commits are already scoped to that package). Write a concise, accurate, developer-facing
editorial intro. The full, structured per-commit changelog is generated separately and will
appear directly beneath what you write — so do NOT reproduce a commit-by-commit list.

Rules:
- Write for engineers who depend on this package. Explain what changed and why it matters,
  not the literal commit text.
- Be factual. Do NOT invent changes, APIs, fixes, or behavior that the commits don't state.
  If the commits are thin, keep the notes thin.
- "summary" is 1-3 plain sentences. No heading, no markdown bullets, and no preamble like
  "This release" or "In this version".
- "highlights" are the few genuinely notable user-facing changes (new features, user-visible
  fixes, breaking changes). Skip pure chores, CI, tests, and formatting. Return an empty list
  if nothing stands out.
- Each highlight is one sentence, rewritten for a reader — not a raw commit message.
- For "prNumber", only use a PR number that appears in the changes above; if a change shows none, use null. Never guess or invent a number.`;

/** Render the scoped commits into the user prompt for the model. */
export function renderUserPrompt(input: EditorialInput): string {
  const lines = input.commits.map((c) => {
    const breaking = c.breaking ? "BREAKING " : "";
    const scope = c.scope ? `(${c.scope})` : "";
    const pr = c.prNumber === null ? "" : ` (#${c.prNumber})`;
    return `- ${breaking}${c.type}${scope}: ${c.bareMessage}${pr}`;
  });
  return [
    `Release: ${input.currentTag} (version ${input.version})`,
    "",
    "Changes (already scoped to this package):",
    lines.length > 0 ? lines.join("\n") : "(no user-facing changes)",
  ].join("\n");
}
