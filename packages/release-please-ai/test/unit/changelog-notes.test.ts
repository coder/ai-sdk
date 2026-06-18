import type { BuildNotesOptions } from "release-please";
import { getChangelogTypes } from "release-please";
import { parseConventionalCommits } from "release-please/build/src/commit.js";
import type { Scm } from "release-please/build/src/scm.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_CHANGELOG_TYPE,
  AiChangelogNotes,
  registerAiChangelogNotes,
} from "../../src/changelog-notes.js";
import { DEFAULT_SECTIONS } from "../../src/sections.js";

// Mock only the model call; keep the real renderEditorial so we exercise the
// actual splice into release-please's default output.
vi.mock("../../src/generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/generate.js")>();
  return {
    ...actual,
    generateEditorial: vi.fn(async () => ({
      summary: "Mocked editorial summary.",
      highlights: [{ text: "A big thing landed.", prNumber: 42 }],
    })),
  };
});

const factoryOptions = {
  type: AI_CHANGELOG_TYPE,
  github: {} as unknown as Scm,
  changelogSections: DEFAULT_SECTIONS,
};

const options: BuildNotesOptions = {
  owner: "coder",
  repository: "ai-sdk",
  version: "0.2.0",
  currentTag: "agent-v0.2.0",
  previousTag: "agent-v0.1.0",
  targetBranch: "main",
  changelogSections: DEFAULT_SECTIONS,
};

function sampleCommits() {
  return parseConventionalCommits([
    { sha: "a".repeat(40), message: "feat(agent): add streaming responses (#42)", files: [] },
    { sha: "b".repeat(40), message: "fix(agent): stop dropping the final token (#43)", files: [] },
    { sha: "c".repeat(40), message: "chore: bump deps (#44)", files: [] },
  ]);
}

afterEach(() => vi.unstubAllEnvs());

describe("registerAiChangelogNotes", () => {
  it("registers the 'ai' changelog type with release-please's factory", () => {
    registerAiChangelogNotes();
    expect(getChangelogTypes()).toContain("ai");
  });
});

describe("AiChangelogNotes.buildNotes", () => {
  it("falls back to release-please's standard notes when no API key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const notes = await new AiChangelogNotes(factoryOptions).buildNotes(sampleCommits(), options);

    expect(notes).toMatch(/^## \[0\.2\.0\]/); // linked version header from the default builder
    expect(notes).toContain("### Features");
    expect(notes).toContain("### Bug Fixes");
    expect(notes).not.toContain("### Highlights"); // no editorial without a key
    expect(notes).not.toContain("Mocked editorial summary.");
    expect(notes).not.toContain("Miscellaneous Chores"); // chore is hidden
  });

  it("splices the AI editorial beneath the version header when a key is present", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const notes = await new AiChangelogNotes(factoryOptions).buildNotes(sampleCommits(), options);

    expect(notes).toMatch(/^## \[0\.2\.0\]/);
    expect(notes).toContain("Mocked editorial summary.");
    expect(notes).toContain("### Highlights");
    expect(notes).toContain("### Features");
    // Editorial sits between the version header and release-please's sections.
    expect(notes.indexOf("Mocked editorial summary.")).toBeLessThan(notes.indexOf("### Features"));
  });
});
