/**
 * Interactive terminal UI (TUI) for Claude Code running in a Coder workspace.
 *
 * This is examples/claude-code.ts with the AI SDK terminal UI on top: instead of
 * a single scripted prompt, you get an interactive chat in your terminal (exit
 * with Esc or Ctrl+C).
 *
 * Prerequisites (same as examples/claude-code.ts):
 *   - The `coder` CLI on PATH, logged in (`coder login`).
 *   - A running workspace whose image has Node.js and pnpm (`corepack enable`),
 *     since the bridge installs the Claude Code CLI + its SDK via pnpm on first
 *     use, plus outbound access to the npm registry and api.anthropic.com.
 *   - `ANTHROPIC_API_KEY` available to the bridge (via the adapter's `auth`, or
 *     present in the workspace environment).
 *
 * Install the TUI package alongside the harness:
 *   npm add @ai-sdk/tui
 *
 * Usage:
 *   CODER_WORKSPACE=my-dev-ws npx tsx examples/claude-code-tui.ts
 */
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { type AgentTUIAgent, runAgentTUI } from "@ai-sdk/tui";
import { createCoderWorkspace } from "../src/index.js";

/**
 * Adapt a {@link HarnessAgent} — whose `generate`/`stream` need a session — into
 * the session-less {@link AgentTUIAgent} the terminal UI drives, by injecting the
 * session for the lifetime of the TUI.
 */
function toTUIAgent(agent: HarnessAgent, session: HarnessAgentSession): AgentTUIAgent {
  return {
    version: "agent-v1",
    id: agent.id,
    tools: agent.tools,
    generate: (request) => agent.generate({ ...request, session }),
    stream: (request) => agent.stream({ ...request, session }),
  };
}

async function main(): Promise<void> {
  const workspace = process.env.CODER_WORKSPACE;
  if (!workspace) {
    throw new Error("Set CODER_WORKSPACE to the workspace to use, e.g. CODER_WORKSPACE=my-dev-ws");
  }

  const agent = new HarnessAgent({
    harness: createClaudeCode({ thinking: { type: "adaptive" } }),
    sandbox: createCoderWorkspace({ workspace }),
    // To create a fresh workspace from a template instead of wrapping one:
    // sandbox: createCoderWorkspace({
    //   create: { template: 'claude-code-test', useParameterDefaults: true },
    // }),
    instructions: "You are a careful coding assistant. Prefer small, well-explained changes.",
  });

  const session = await agent.createSession();
  try {
    await runAgentTUI({
      title: "Claude Code @ Coder",
      agent: toTUIAgent(agent, session),
      tools: "auto-collapsed",
      reasoning: "collapsed",
    });
  } finally {
    await session.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
