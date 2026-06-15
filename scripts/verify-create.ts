/**
 * End-to-end verification of *create mode* against a REAL Coder deployment.
 *
 *   npx tsx scripts/verify-create.ts [template] [presetTemplate]
 *     template        template to create a throwaway workspace from (default: docker)
 *     presetTemplate  a template that HAS presets, used to verify preflight
 *                     validation rejects an unknown preset (default: tasks-realworld)
 *
 * Requires the `coder` CLI on PATH and logged in. Creates a uniquely-named,
 * throwaway workspace, waits for its agent to become ready, runs a command in
 * it, then deletes it. It never touches any pre-existing workspace.
 */
import crypto from 'node:crypto';
import { CoderCliTransport } from '../src/cli-transport.js';
import { createCoderWorkspace } from '../src/index.js';

const TEMPLATE = process.argv[2] ?? 'docker';
const PRESET_TEMPLATE = process.argv[3] ?? 'tasks-realworld';
const WS = `aisdk-create-${crypto.randomBytes(4).toString('hex')}`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

async function main(): Promise<void> {
  const transport = new CoderCliTransport({});
  console.log(`\n# Verifying create mode (template "${TEMPLATE}", workspace "${WS}")\n`);

  // 1. Introspection: presets list (used for preflight validation).
  console.log('## introspection');
  try {
    const presets = await transport.listPresets({ template: TEMPLATE });
    check('listPresets returns an array', Array.isArray(presets), JSON.stringify(presets));
  } catch (e) {
    check('listPresets returns an array', false, String(e));
  }

  // 2. Preflight: an unknown preset is rejected BEFORE any workspace is created.
  console.log('## preflight preset validation');
  try {
    const bogus = createCoderWorkspace({
      workspace: `${WS}-never`,
      create: { template: PRESET_TEMPLATE, preset: 'definitely-not-a-real-preset-xyz' },
    });
    await bogus.createSession();
    check('unknown preset rejected', false, 'expected a rejection');
  } catch (e) {
    check('unknown preset rejected', /preset .* not found/i.test(String(e)), String(e));
    // ensure nothing leaked
    const leaked = await transport.status(`${WS}-never`).catch(() => null);
    check('no workspace created on preflight failure', leaked === null);
  }

  // 3. Create a fresh workspace and wait until its agent is ready.
  console.log('## create + readiness');
  const provider = createCoderWorkspace({
    workspace: WS,
    create: { template: TEMPLATE, useParameterDefaults: true },
    readyTimeoutMs: 600_000,
  });

  let createdOk = false;
  try {
    const started = Date.now();
    const session = await provider.createSession();
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    createdOk = true;
    check(`createSession created + readied the workspace (${secs}s)`, session.id === WS, session.id);

    const status = await transport.status(WS);
    check('status reports a running workspace', status?.buildStatus === 'running', JSON.stringify(status));
    check(
      'agent is connected and ready',
      !!status?.agents.some((a) => a.status === 'connected' && a.lifecycleState === 'ready'),
      JSON.stringify(status?.agents),
    );

    check(
      'defaultWorkingDirectory resolved from the workspace',
      session.defaultWorkingDirectory.startsWith('/'),
      session.defaultWorkingDirectory,
    );

    console.log('## exec inside the created workspace');
    const uname = await session.run({ command: 'uname -sr' });
    check('uname runs in the created workspace', uname.exitCode === 0 && /Linux/.test(uname.stdout), JSON.stringify(uname));

    console.log('## destroy (deletes the created workspace)');
    await session.destroy?.();
    // Deletion is a build; poll until the workspace is gone.
    let gone = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = await transport.status(WS).catch(() => null);
      if (s === null || s.buildStatus === 'deleted') {
        gone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    check('workspace deleted on destroy', gone);
  } catch (e) {
    check('create flow', false, String(e));
  } finally {
    // Safety net: if we created the workspace but something above threw before
    // deletion, make sure we don't leak it.
    if (createdOk) {
      const still = await transport.status(WS).catch(() => null);
      if (still !== null && still.buildStatus !== 'deleted') {
        console.log(`  … cleaning up leftover workspace "${WS}"`);
        await transport.destroy(WS).catch(() => {});
      }
    }
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
