import { GitHub, Manifest, registerChangelogNotes, setLogger } from "release-please";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DefaultChangelogNotes } = require("release-please/build/src/changelog-notes/default.js");
registerChangelogNotes("ai", (options: any) => new DefaultChangelogNotes(options));
const logs: string[] = [];
const keep =
  (lvl: string) =>
  (...a: any[]) =>
    logs.push(`${lvl} ${a.map(String).join(" ")}`);
setLogger({
  error: keep("E"),
  warn: keep("W"),
  info: keep("I"),
  debug: () => {},
  trace: () => {},
} as any);
const [branch, batch] = [process.argv[2]!, Number(process.argv[3] ?? "0")];
const github = await GitHub.create({
  owner: "coder",
  repo: "ai-sdk",
  token: process.env.GITHUB_TOKEN!,
  defaultBranch: branch,
});
const opts: any = {};
if (batch) opts.commitBatchSize = batch;
if (process.env.BOOT) opts.bootstrapSha = process.env.BOOT;
const manifest = await Manifest.fromManifest(
  github,
  branch,
  "release-please-config.json",
  ".release-please-manifest.json",
  opts,
);
try {
  const prs = await manifest.buildPullRequests();
  for (const pr of prs) {
    console.log(pr.title.toString(), "| head:", pr.headRefName);
    if (pr.headRefName.includes("effect")) {
      const body = pr.body.toString();
      console.log("  notes heading:", body.match(/## \[?0\.1\.0[^\n]*/)?.[0]);
      console.log("  commit lines:", (body.match(/^\* /gm) ?? []).length);
      const u = pr.updates.map((x: any) => x.path);
      console.log("  updates:", u.join(", "));
    }
  }
} finally {
  console.log(
    logs
      .filter((l) => /bootstrap|Expected|Missing|No latest|commit search|found/i.test(l))
      .slice(0, 12)
      .join("\n"),
  );
}
