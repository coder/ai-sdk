/**
 * Full end-to-end: run a real Claude Code turn inside a Coder workspace through
 * the provider. Exercises the whole stack — bridge bootstrap (pnpm install +
 * CLI), the authenticated WebSocket over `coder port-forward`, and a tool-use
 * round-trip.
 *
 *   E2E_WORKSPACE=aisdk-claude-e2e npx tsx scripts/e2e-claude.ts "<prompt>"
 *
 * Auth: if ANTHROPIC_API_KEY is set on the host it is passed to the adapter
 * (optionally with ANTHROPIC_BASE_URL); otherwise the bridge inherits whatever
 * Anthropic auth the workspace's own environment provides.
 */
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCoderWorkspace } from '../src/index.js';

const workspace = process.env.E2E_WORKSPACE ?? 'aisdk-claude-e2e';
const prompt =
  process.argv[2] ??
  'Run the shell command `uname -sr` and reply with exactly its output, nothing else.';

const auth = process.env.ANTHROPIC_API_KEY
  ? {
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
      },
    }
  : undefined;
const settings: Parameters<typeof createClaudeCode>[0] = {
  thinking: 'off',
  ...(auth ? { auth } : {}),
};
console.log(
  auth
    ? `auth: host ANTHROPIC_API_KEY${process.env.ANTHROPIC_BASE_URL ? ' + ANTHROPIC_BASE_URL' : ''}`
    : 'auth: inheriting the workspace environment',
);

const agent = new HarnessAgent({
  harness: createClaudeCode(settings),
  sandbox: createCoderWorkspace({ workspace }),
  instructions: 'You are concise.',
});

console.log(
  `workspace: ${workspace}\nprompt: ${prompt}\n--- starting session (first run installs the bridge) ---`,
);
const started = Date.now();
const session = await agent.createSession();
try {
  const result = await agent.generate({ session, prompt });
  console.log(`\n=== RESULT (${Math.round((Date.now() - started) / 1000)}s) ===`);
  console.log(result.text);
  console.log('\n=== E2E OK ===');
} finally {
  await session.destroy();
}
