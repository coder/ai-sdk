/**
 * Run Claude Code in a Coder workspace that the provider CREATES on demand from
 * a template, then deletes when the session ends (fresh-per-session).
 *
 * Prerequisites:
 *   - The `coder` CLI on PATH, logged in (`coder login`) — or pass `url`/`token`
 *     to `new CoderCliTransport({ url, token })`.
 *   - A template whose image has Node.js and pnpm (`corepack enable`), since the
 *     bridge installs the Claude Code CLI + its SDK via pnpm on first use, plus
 *     outbound access to the npm registry and api.anthropic.com.
 *   - `ANTHROPIC_API_KEY` available to the bridge (configure via the adapter's
 *     `auth`, or ensure it is present in the workspace environment).
 *
 * Usage:
 *   CODER_TEMPLATE=claude-code-test npx tsx examples/create-workspace.ts "Summarize this repo"
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCoderWorkspace } from "../src/index.js";

async function main(): Promise<void> {
  const template = process.env.CODER_TEMPLATE;
  if (!template) {
    throw new Error(
      "Set CODER_TEMPLATE to the template to create from, e.g. CODER_TEMPLATE=claude-code-test",
    );
  }

  const agent = new HarnessAgent({
    harness: createClaudeCode({ thinking: { type: "adaptive" } }),
    sandbox: createCoderWorkspace({
      // No `workspace`: the name is derived per-session from the harness
      // sessionId, the workspace is created from the template, and it is deleted
      // on session.destroy().
      create: {
        template,
        // preset: 'Large',                 // a template version preset
        // parameters: { cpus: 8 },         // rich parameter values
        useParameterDefaults: true, // accept template defaults for the rest
        // stopAfter: '4h',                 // auto-stop TTL as a safety net
      },
      // readyTimeoutMs: 600_000,           // bump for slow-building templates
    }),
    instructions: "You are a careful coding assistant. Prefer small, well-explained changes.",
  });

  const session = await agent.createSession();
  try {
    const result = await agent.generate({
      session,
      prompt: process.argv[2] ?? "Print the OS and kernel version, then list the home directory.",
    });
    console.log(result.text);
  } finally {
    // Deletes the workspace this session created.
    await session.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
