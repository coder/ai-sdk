import type { BuildNotesOptions } from "release-please";
import { parseConventionalCommits } from "release-please/build/src/commit.js";
import type { Scm } from "release-please/build/src/scm.js";
import { describe, expect, it } from "vitest";
import { AI_CHANGELOG_TYPE, AiChangelogNotes } from "../../src/changelog-notes.js";
import { generateEditorial } from "../../src/generate.js";
import { DEFAULT_SECTIONS } from "../../src/sections.js";

// Gated: only runs with a real API key (e.g. `pnpm test:e2e`); skipped otherwise.
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasKey)("AI release notes (live Anthropic call)", () => {
  it("generateEditorial returns a non-empty summary and a well-formed highlights array", async () => {
    const notes = await generateEditorial({
      currentTag: "agent-v0.2.0",
      version: "0.2.0",
      commits: [
        {
          type: "feat",
          scope: "agent",
          bareMessage: "add streaming responses",
          breaking: false,
          prNumber: 1,
        },
        {
          type: "fix",
          scope: "agent",
          bareMessage: "stop dropping the final token",
          breaking: false,
          prNumber: 2,
        },
      ],
    });
    expect(notes.summary.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(notes.highlights)).toBe(true);
    for (const h of notes.highlights) {
      expect(typeof h.text).toBe("string");
      expect(h.prNumber === null || typeof h.prNumber === "number").toBe(true);
    }
  });

  it("buildNotes returns a valid release-please section with the AI editorial spliced in", async () => {
    const commits = parseConventionalCommits([
      { sha: "a".repeat(40), message: "feat(agent): add streaming responses (#42)", files: [] },
      {
        sha: "b".repeat(40),
        message: "fix(agent): stop dropping the final token (#43)",
        files: [],
      },
    ]);
    const options: BuildNotesOptions = {
      owner: "coder",
      repository: "ai-sdk",
      version: "0.2.0",
      currentTag: "agent-v0.2.0",
      previousTag: "agent-v0.1.0",
      targetBranch: "main",
      changelogSections: DEFAULT_SECTIONS,
    };

    const notes = await new AiChangelogNotes({
      type: AI_CHANGELOG_TYPE,
      github: {} as unknown as Scm,
      changelogSections: DEFAULT_SECTIONS,
    }).buildNotes(commits, options);

    expect(notes).toMatch(/^## \[0\.2\.0\]/);
    expect(notes).toContain("### Features");
    expect(notes).toContain("### Bug Fixes");
    // The model wrote *something* between the header and the first section.
    expect(notes.indexOf("\n")).toBeLessThan(notes.indexOf("### "));
    expect(notes.slice(notes.indexOf("\n"), notes.indexOf("### ")).trim().length).toBeGreaterThan(
      0,
    );
  }, 60_000);
});
