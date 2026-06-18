/**
 * Run Claude Code inside a Coder workspace via the AI SDK HarnessAgent.
 *
 * Prerequisites:
 *   - The `coder` CLI on PATH, logged in (`coder login`) — or pass `url`/`token`
 *     to `new CoderCliTransport({ url, token })`.
 *   - A running workspace whose image has Node.js and pnpm (`corepack enable`),
 *     since the bridge installs the Claude Code CLI + its SDK via pnpm on first
 *     use, plus outbound access to the npm registry and api.anthropic.com.
 *   - `ANTHROPIC_API_KEY` available to the bridge (configure via the adapter's
 *     `auth`, or ensure it is present in the workspace environment).
 *
 * Usage:
 *   CODER_WORKSPACE=my-dev-ws npx tsx examples/claude-code.ts "Summarize this repo"
 */
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCoderWorkspace } from '../src/index.js';

async function main(): Promise<void> {
  const workspace = process.env.CODER_WORKSPACE;
  if (!workspace) {
    throw new Error('Set CODER_WORKSPACE to the workspace to use, e.g. CODER_WORKSPACE=my-dev-ws');
  }

  const agent = new HarnessAgent({
    harness: createClaudeCode({
      // model: 'claude-opus-4-8',
      thinking: 'adaptive',
      // `port` defaults to the first port the sandbox exposes (4000 below).
    }),
    sandbox: createCoderWorkspace({
      workspace,
      // ports: [4000],          // the bridge binds ports[0]; getPortUrl forwards it
      // ownsLifecycle: false,   // wrap an existing workspace (default); stop/destroy are no-ops
      // ensureStarted: true,    // run `coder start` first if it may be stopped
      // url/token are not options here — they live on the transport. Import
      // CoderCliTransport from '@coder/ai-sdk-sandbox' and pass:
      // transport: new CoderCliTransport({ url: process.env.CODER_URL, token: process.env.CODER_SESSION_TOKEN }),
    }),
    instructions: 'You are a careful coding assistant. Prefer small, well-explained changes.',
  });

  const session = await agent.createSession();
  try {
    const result = await agent.generate({
      session,
      prompt:
        process.argv[2] ??
        'Create a short TODO.md in the repository root with three improvement ideas.',
    });
    console.log(result.text);
  } finally {
    await session.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
