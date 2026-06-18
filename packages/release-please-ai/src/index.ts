/**
 * @coder/release-please-ai
 *
 * A release-please `ChangelogNotes` hook that adds an AI-written editorial intro
 * (summary + highlights) on top of release-please's standard, component-scoped
 * changelog. Register the hook, set `changelog-type: "ai"` in the config, and run
 * release-please — it produces the CHANGELOG, the release PR body, and the GitHub
 * Release with the AI notes baked in.
 *
 * @example
 * ```ts
 * import { registerAiChangelogNotes } from "@coder/release-please-ai";
 * import { GitHub, Manifest } from "release-please";
 *
 * registerAiChangelogNotes();
 * const github = await GitHub.create({ owner, repo, token });
 * const manifest = await Manifest.fromManifest(github, "main");
 * await manifest.createPullRequests();
 * await manifest.createReleases();
 * ```
 */
export {
  AI_CHANGELOG_TYPE,
  AiChangelogNotes,
  registerAiChangelogNotes,
} from "./changelog-notes.js";
