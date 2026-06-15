import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import { CoderCliTransport } from './cli-transport.js';
import type { CoderTransport } from './transport.js';
import { CoderNetworkSandboxSession } from './coder-network-sandbox-session.js';

/** Stable provider id reported on the {@link HarnessV1SandboxProvider}. */
export const CODER_SANDBOX_PROVIDER_ID = 'coder-sandbox';

const DEFAULT_BRIDGE_PORT = 4000;
const DEFAULT_WORKING_DIRECTORY = '/home/coder';

export interface CoderSandboxSettings {
  /**
   * The workspace to wrap, as `[owner/]workspace[.agent]`. Either a fixed name
   * or a resolver from the harness `sessionId`. If omitted, the `sessionId`
   * itself is used as the workspace name.
   */
  workspace?: string | ((sessionId: string | undefined) => string);

  /**
   * Ports the workspace exposes. The bridge-backed adapters resolve the bridge
   * port from `createClaudeCode({ port })` or, failing that, `ports[0]`, so the
   * default exposes a single port (4000) that the bridge will bind and that
   * `getPortUrl` will forward. Default: `[4000]`.
   */
  ports?: number[];

  /**
   * Absolute default working directory. If omitted, it is resolved from `$HOME`
   * in the workspace at session-create time, falling back to `/home/coder`.
   */
  defaultWorkingDirectory?: string;

  /**
   * Whether this provider owns the workspace lifecycle. When `false` (default)
   * the provider wraps an existing, externally-owned workspace: `stop()` and
   * `destroy()` only release host-side resources and never stop or delete it.
   * When `true`, `stop()`/`destroy()` run `coder stop`/`coder delete`.
   */
  ownsLifecycle?: boolean;

  /** Run `coder start` before attaching (useful for stopped workspaces). */
  ensureStarted?: boolean;

  /**
   * Inject a custom transport (e.g. for tests, or a non-CLI backend). When
   * omitted, a {@link CoderCliTransport} is created from the CLI options below.
   */
  transport?: CoderTransport;

  /** Path or name of the coder binary. Default: `coder`. */
  coderBinary?: string;
  /** Path or name of the OpenSSH client used for exec/spawn. Default: `ssh`. */
  sshBinary?: string;
  /** Coder deployment URL; sets `CODER_URL`. Falls back to ambient `coder login`. */
  url?: string;
  /** Coder session token; sets `CODER_SESSION_TOKEN`. Falls back to ambient login. */
  token?: string;
  /** Extra environment merged into every `coder`/`ssh` invocation. */
  env?: Record<string, string>;
  /** Use a bash login shell for remote commands (PATH resolution). Default `true`. */
  loginShell?: boolean;
  /** Coder startup-script wait behavior for proxied connections. Default `'no'`. */
  waitMode?: 'yes' | 'no' | 'auto';
}

/**
 * Create a {@link HarnessV1SandboxProvider} that runs harness sessions inside a
 * Coder workspace.
 *
 * @example
 * ```ts
 * import { HarnessAgent } from '@ai-sdk/harness/agent';
 * import { createClaudeCode } from '@ai-sdk/harness-claude-code';
 * import { createCoderSandbox } from '@coder/ai-sdk-sandbox';
 *
 * const agent = new HarnessAgent({
 *   harness: createClaudeCode({ port: 4000 }),
 *   sandbox: createCoderSandbox({ workspace: 'my-dev-workspace' }),
 * });
 * ```
 */
export function createCoderSandbox(
  settings: CoderSandboxSettings = {},
): HarnessV1SandboxProvider {
  const transport: CoderTransport =
    settings.transport ??
    new CoderCliTransport({
      coderBinary: settings.coderBinary,
      sshBinary: settings.sshBinary,
      url: settings.url,
      token: settings.token,
      env: settings.env,
      loginShell: settings.loginShell,
      waitMode: settings.waitMode,
    });

  const ports = settings.ports ?? [DEFAULT_BRIDGE_PORT];
  const ownsLifecycle = settings.ownsLifecycle ?? false;

  const resolveWorkspace = (sessionId: string | undefined): string => {
    if (typeof settings.workspace === 'function') return settings.workspace(sessionId);
    if (typeof settings.workspace === 'string') return settings.workspace;
    if (sessionId !== undefined && sessionId !== '') return sessionId;
    throw new Error(
      'createCoderSandbox: a `workspace` is required when no sessionId is provided to derive one from.',
    );
  };

  const buildSession = async (
    workspace: string,
    abortSignal?: AbortSignal,
  ): Promise<CoderNetworkSandboxSession> => {
    if (settings.ensureStarted) {
      await transport.start(workspace, { abortSignal });
    }
    const defaultWorkingDirectory =
      settings.defaultWorkingDirectory ??
      (await resolveHomeDirectory(transport, workspace, abortSignal));
    return new CoderNetworkSandboxSession({
      transport,
      workspace,
      id: workspace,
      defaultWorkingDirectory,
      ports: [...ports],
      ownsLifecycle,
    });
  };

  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: CODER_SANDBOX_PROVIDER_ID,
    // `bridgePorts` intentionally left undefined: this provider binds one
    // workspace per session rather than leasing ports from a shared sandbox.
    createSession: async (options) => {
      const workspace = resolveWorkspace(options?.sessionId);
      const session = await buildSession(workspace, options?.abortSignal);
      // `onFirstCreate` is the provider's snapshot-bootstrap hook. It is only
      // meaningful when the provider creates the resource; when wrapping a
      // caller-owned workspace the framework runs its own idempotent bootstrap.
      if (ownsLifecycle && options?.onFirstCreate) {
        await options.onFirstCreate(session.restricted(), {
          abortSignal: options.abortSignal,
        });
      }
      return session;
    },
    resumeSession: async (options) => {
      const workspace = resolveWorkspace(options.sessionId);
      return buildSession(workspace, options.abortSignal);
    },
  };
}

/** Best-effort lookup of the workspace's `$HOME`, defaulting to `/home/coder`. */
async function resolveHomeDirectory(
  transport: CoderTransport,
  workspace: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    const result = await transport.exec({
      workspace,
      command: 'printf %s "$HOME"',
      abortSignal,
    });
    const home = result.stdout.trim();
    if (result.exitCode === 0 && home.startsWith('/')) {
      return home;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_WORKING_DIRECTORY;
}
