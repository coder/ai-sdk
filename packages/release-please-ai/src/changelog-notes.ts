import { registerChangelogNotes } from "release-please";
import type {
  BuildNotesOptions,
  ChangelogNotes,
  ChangelogNotesBuilder,
  ChangelogNotesFactoryOptions,
  ConventionalCommit,
} from "release-please";
// Deep import: release-please ships no `exports` map, so its build output is
// importable. DefaultChangelogNotes isn't re-exported from the package root, but
// the build layout is stable within the pinned `~17.9.0` range, and reusing it lets
// us delegate all changelog structure to release-please's own renderer.
import { DefaultChangelogNotes } from "release-please/build/src/changelog-notes/default.js";
import { generateEditorial, renderEditorial } from "./generate.js";
import { visibleCommits } from "./sections.js";
import type { CommitView } from "./types.js";

/** The `changelog-type` value to set in release-please-config.json. */
export const AI_CHANGELOG_TYPE = "ai";

/**
 * A release-please ChangelogNotes implementation that augments the standard
 * notes with an AI-written editorial intro.
 *
 * Structure (version header, sectioned commits, PR/commit links, BREAKING-CHANGE
 * footnotes) is delegated to release-please's own DefaultChangelogNotes, so the
 * output is always a valid release-please changelog section. The model only adds
 * a summary + highlights spliced in beneath the version header. If the model is
 * unavailable (no API key, network/error) or there's nothing notable, we return
 * the exact default notes — a release is never blocked on the LLM.
 */
export class AiChangelogNotes implements ChangelogNotes {
  private readonly base: ChangelogNotes;

  constructor(options: ChangelogNotesFactoryOptions) {
    this.base = new DefaultChangelogNotes(options);
  }

  async buildNotes(commits: ConventionalCommit[], options: BuildNotesOptions): Promise<string> {
    const base = await this.base.buildNotes(commits, options);
    const editorial = await this.tryEditorial(commits, options);
    return editorial ? injectAfterHeader(base, editorial) : base;
  }

  private async tryEditorial(
    commits: ConventionalCommit[],
    options: BuildNotesOptions,
  ): Promise<string> {
    const visible = visibleCommits(commits, options.changelogSections);
    if (visible.length === 0 || !process.env.ANTHROPIC_API_KEY) {
      return "";
    }
    try {
      const notes = await generateEditorial({
        currentTag: options.currentTag,
        version: options.version,
        commits: visible.map(toCommitView),
      });
      return renderEditorial(notes, {
        host: options.host,
        owner: options.owner,
        repository: options.repository,
      });
    } catch (error) {
      // Never break a release because of the model — fall back to default notes.
      process.stderr.write(
        `[ai-changelog-notes] editorial generation failed, using default notes: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return "";
    }
  }
}

/** Register the AI changelog-notes builder under `changelog-type: "ai"`. */
export function registerAiChangelogNotes(): void {
  const builder: ChangelogNotesBuilder = (options) => new AiChangelogNotes(options);
  registerChangelogNotes(AI_CHANGELOG_TYPE, builder);
}

function toCommitView(c: ConventionalCommit): CommitView {
  return {
    type: c.type,
    scope: c.scope,
    bareMessage: c.bareMessage,
    breaking: c.breaking,
    prNumber: c.pullRequest?.number ?? null,
  };
}

/**
 * Insert the editorial block immediately after release-please's version heading
 * (the leading `## [x.y.z] …` line). Anchors on the markdown heading rather than a
 * fixed line position, so it survives header/whitespace changes. If no heading is
 * found (release-please always emits one first), it appends the editorial after the
 * notes rather than risk displacing the version header the release pipeline parses.
 */
function injectAfterHeader(base: string, editorial: string): string {
  const heading = base.match(/^#{1,6} .*(?:\r?\n|$)/)?.[0];
  if (!heading) {
    return `${base}\n\n${editorial}`;
  }
  const body = base.slice(heading.length).replace(/^\s*\n/, "");
  return [heading.trimEnd(), editorial, body].filter(Boolean).join("\n\n");
}
