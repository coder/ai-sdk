import { appendFileSync } from "node:fs";
import { GitHub, Manifest } from "release-please";
import type { CreatedRelease } from "release-please";
import { registerAiChangelogNotes } from "./changelog-notes.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Run release-please programmatically with the AI changelog-notes hook
 * registered. This replaces the stock `release-please-action`: it opens/updates
 * the release PRs and creates GitHub releases, with the notes produced by our
 * registered `changelog-type: "ai"` builder. Emits the same per-path outputs the
 * action does, so downstream publish jobs keep working unchanged.
 */
async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN");
  const repository = required("GITHUB_REPOSITORY"); // "owner/repo"
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be "owner/repo", got: ${repository}`);
  }
  const targetBranch = process.env.RELEASE_PLEASE_TARGET_BRANCH ?? "main";
  const configFile = process.env.RELEASE_PLEASE_CONFIG_FILE ?? "release-please-config.json";
  const manifestFile = process.env.RELEASE_PLEASE_MANIFEST_FILE ?? ".release-please-manifest.json";

  // Must register before constructing the Manifest so `changelog-type: "ai"` resolves.
  registerAiChangelogNotes();

  const github = await GitHub.create({ owner, repo, token, defaultBranch: targetBranch });
  const result = await runReleasePlease(() =>
    Manifest.fromManifest(github, targetBranch, configFile, manifestFile),
  );

  emitOutputs(result.pullRequestCount, result.releases);
}

interface ReleasePleaseManifest {
  createReleases(): ReturnType<Manifest["createReleases"]>;
  createPullRequests(): ReturnType<Manifest["createPullRequests"]>;
}

export async function runReleasePlease(
  loadManifest: () => Promise<ReleasePleaseManifest>,
): Promise<{ pullRequestCount: number; releases: CreatedRelease[] }> {
  const releaseManifest = await loadManifest();
  const releases = (await releaseManifest.createReleases()).filter(
    (release): release is CreatedRelease => Boolean(release),
  );

  // Reload after tagging merged releases. Otherwise createPullRequests sees the
  // just-merged release PR as untagged and aborts before refreshing sibling PRs.
  const pullRequestManifest = await loadManifest();
  const pullRequests = (await pullRequestManifest.createPullRequests()).filter(Boolean);

  return { pullRequestCount: pullRequests.length, releases };
}

/** Write GitHub Actions step outputs (mirrors googleapis/release-please-action). */
function emitOutputs(prCount: number, releases: CreatedRelease[]): void {
  const lines = [`releases_created=${releases.length > 0}`, `prs_created=${prCount > 0}`];
  for (const r of releases) {
    lines.push(
      `${r.path}--release_created=true`,
      `${r.path}--tag_name=${r.tagName}`,
      `${r.path}--version=${r.version}`,
    );
  }
  const text = `${lines.join("\n")}\n`;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, text);
  }
  process.stderr.write(
    `release-please: ${releases.length} release(s) created, ${prCount} PR(s) opened/updated\n${text}`,
  );
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
