import type { ChangelogSection } from "release-please";

/**
 * The generator's built-in default sections. Used only as a fallback for
 * {@link visibleCommits} when a caller doesn't supply sections; in a normal
 * release-please run, `BuildNotesOptions.changelogSections` is always provided
 * (from the repo's config), so that set wins and these defaults are not consulted.
 */
export const DEFAULT_SECTIONS: ChangelogSection[] = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance Improvements" },
  { type: "revert", section: "Reverts" },
  { type: "deps", section: "Dependencies" },
  { type: "docs", section: "Documentation" },
  { type: "refactor", section: "Code Refactoring" },
  { type: "build", section: "Build System", hidden: true },
  { type: "ci", section: "Continuous Integration", hidden: true },
  { type: "test", section: "Tests", hidden: true },
  { type: "style", section: "Styles", hidden: true },
  { type: "chore", section: "Miscellaneous Chores", hidden: true },
];

/**
 * Filter to commits whose type is NOT marked `hidden`. Generic so it works on
 * both release-please's `ConventionalCommit` and our `CommitView`.
 */
export function visibleCommits<T extends { type: string }>(
  commits: T[],
  sections?: ChangelogSection[],
): T[] {
  const defs = sections && sections.length > 0 ? sections : DEFAULT_SECTIONS;
  const hidden = new Set(defs.filter((s) => s.hidden).map((s) => s.type));
  return commits.filter((c) => !hidden.has(c.type));
}
