import { createHash } from 'node:crypto';
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness';
import { CoderCliTransport } from './cli-transport.js';
import type {
  CoderTransport,
  CreateWorkspaceOptions,
  PresetInfo,
  WorkspaceStatus,
} from './transport.js';
import { CoderWorkspaceSession } from './coder-workspace-session.js';

/** Stable provider id reported on the {@link HarnessV1SandboxProvider}. */
export const CODER_WORKSPACE_PROVIDER_ID = 'coder-workspace';

const DEFAULT_BRIDGE_PORT = 4000;
const DEFAULT_WORKING_DIRECTORY = '/home/coder';
const DEFAULT_READY_TIMEOUT_MS = 300_000;
const READY_POLL_INTERVAL_MS = 2_000;
const DEFAULT_NAME_PREFIX = 'agent';

/**
 * Settings for creating a workspace on demand from a template. Set this as the
 * `create` field on {@link CoderWorkspaceSettings} to enable "create mode": the
 * provider will get-or-create a workspace (rather than only wrapping an existing
 * one) and wait for its agent to become ready before running the harness.
 */
export interface CoderCreateSettings {
  /** Template name to create from. Required to enable creation. */
  template: string;
  /** Specific template version name; defaults to the template's active version. */
  templateVersion?: string;
  /**
   * Named preset to apply (`coder create --preset`). Use `'none'` to force no
   * preset. Note: a preset's parameter values take precedence over any
   * overlapping {@link CoderCreateSettings.parameters} (Coder's behavior) — set
   * a given value via the preset *or* `parameters`, not both.
   */
  preset?: string;
  /**
   * Rich parameter values by parameter name. Numbers and booleans are
   * stringified. For `list(string)` parameters prefer {@link parameterFile}.
   */
  parameters?: Record<string, string | number | boolean>;
  /** Path to a YAML rich-parameter file (`--rich-parameter-file`). */
  parameterFile?: string;
  /** Accept template defaults for any parameter not otherwise provided. */
  useParameterDefaults?: boolean;
  /** Ephemeral (one-time build) parameter values by name. */
  ephemeralParameters?: Record<string, string | number | boolean>;
  /** Auto-stop the workspace after this duration, e.g. `'8h'` (`--stop-after`). */
  stopAfter?: string;
  /** `--automatic-updates` setting (default: Coder's, `never`). */
  automaticUpdates?: 'always' | 'never';
  /** Organization name or uuid for ambiguous template names (`--org`). */
  org?: string;
  /**
   * Owner for an auto-derived workspace name (`owner/name`). Only applied when
   * the name is derived from the sessionId; when you pass an explicit
   * `workspace` string, include the owner there. Defaults to the authenticated
   * user.
   */
  owner?: string;
  /**
   * What to do if a workspace with the target name already exists:
   * `'attach'` (default) reuses it; `'error'` fails.
   */
  ifExists?: 'attach' | 'error';
  /**
   * Prefix for the workspace name derived from the harness sessionId when no
   * explicit `workspace` is set (fresh-per-session). Default: `'agent'`.
   */
  namePrefix?: string;
  /**
   * Preflight-validate the requested {@link preset} name against the template's
   * presets before creating, failing fast with the available names. Best-effort
   * (skipped silently if introspection fails). Default: `true`.
   */
  validate?: boolean;
}

/**
 * A workspace reference: a fixed `[owner/]workspace[.agent]`, or a resolver from
 * the harness `sessionId`.
 */
export type CoderWorkspaceRef = string | ((sessionId: string | undefined) => string);

/** Settings common to every {@link createCoderWorkspace} configuration. */
export interface CoderWorkspaceBaseSettings {
  /** Max time (ms) to wait for the agent to become ready after create/start. Default 300000. */
  readyTimeoutMs?: number;

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
   * Whether this provider owns the workspace lifecycle (`stop()`/`destroy()`
   * actually stop/delete it). Default depends on mode:
   * - **wrap mode** (no `create`): `false` — `stop()`/`destroy()` only release
   *   host-side resources and never touch the workspace.
   * - **create mode**: `true` — but a workspace the provider only *attached* to
   *   (an explicitly-named, pre-existing one) is never deleted; only workspaces
   *   the provider actually created are. A per-session derived name is always
   *   treated as owned.
   */
  ownsLifecycle?: boolean;

  /** Run `coder start` before attaching (useful for stopped workspaces in wrap mode). */
  ensureStarted?: boolean;

  /**
   * Transport used to reach Coder. Defaults to a {@link CoderCliTransport} that
   * shells out to an ambient `coder` login. To configure the CLI transport —
   * binary paths, `url`/`token`, extra env, login shell, startup-wait behavior —
   * construct one explicitly, e.g. `transport: new CoderCliTransport({ url, token })`.
   * You can also supply a non-CLI transport (REST, tests, …).
   */
  transport?: CoderTransport;
}

/**
 * Settings for {@link createCoderWorkspace}. **At least one of `workspace` or
 * `create` is required** — and you may set both:
 * - `workspace` only — wrap an existing workspace.
 * - `create` only — create a fresh per-session workspace from a template (its
 *   name is derived from the harness `sessionId`), deleted on `destroy()`.
 * - both — get-or-create the named `workspace` from the template.
 */
export type CoderWorkspaceSettings = CoderWorkspaceBaseSettings &
  (
    | {
      /**
       * The workspace to use, as `[owner/]workspace[.agent]` — a fixed name or
       * a resolver from the harness `sessionId`. With `create` it is
       * get-or-created; otherwise it must already exist.
       */
      workspace: CoderWorkspaceRef;
      /** Optionally create the workspace from a template if it doesn't exist. */
      create?: CoderCreateSettings;
    }
    | {
      /**
       * Optional explicit workspace name/resolver. Omit to derive a fresh
       * per-session name from the harness `sessionId`.
       */
      workspace?: CoderWorkspaceRef;
      /** Create the workspace on demand from a template. See {@link CoderCreateSettings}. */
      create: CoderCreateSettings;
    }
  );

/**
 * Create a {@link HarnessV1SandboxProvider} that runs harness sessions inside a
 * Coder workspace. Either wraps an existing workspace, or — when a `create`
 * block is supplied — creates one on demand from a template.
 *
 * @example Wrap an existing workspace
 * ```ts
 * createCoderWorkspace({ workspace: 'my-dev-workspace' })
 * ```
 *
 * @example Create a fresh per-session workspace from a template
 * ```ts
 * createCoderWorkspace({
 *   create: { template: 'docker', preset: 'Large' },
 * })
 * ```
 */
export function createCoderWorkspace(
  settings: CoderWorkspaceSettings,
): HarnessV1SandboxProvider {
  const transport: CoderTransport = settings.transport ?? new CoderCliTransport();

  const ports = settings.ports ?? [DEFAULT_BRIDGE_PORT];
  const createMode = settings.create !== undefined;
  // Whether the workspace name is derived per-session (vs. an explicit name the
  // caller supplied, which may point at a pre-existing, caller-owned workspace).
  const nameDerived = createMode && settings.workspace === undefined;
  const readyTimeoutMs = settings.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const resolveWorkspace = (sessionId: string | undefined): string => {
    if (typeof settings.workspace === 'function') return settings.workspace(sessionId);
    if (typeof settings.workspace === 'string') return settings.workspace;
    if (createMode) {
      const name = deriveWorkspaceName(settings.create!.namePrefix ?? DEFAULT_NAME_PREFIX, sessionId);
      const owner = settings.create!.owner;
      return owner !== undefined && owner !== '' ? `${owner}/${name}` : name;
    }
    // Unreachable for typed callers — the settings type requires `workspace` or
    // `create`. This guards untyped / `as`-cast usage.
    throw new Error('createCoderWorkspace: set `workspace`, `create`, or both.');
  };

  /** Resolve whether this session owns its workspace's lifecycle. */
  const resolveOwnership = (createdByProvider: boolean): boolean => {
    if (!createMode) return settings.ownsLifecycle ?? false;
    const owns = settings.ownsLifecycle ?? true;
    // A per-session derived name is always ours; an explicit name is only ours
    // to delete if we actually created it this run (never delete a borrowed one).
    return nameDerived ? owns : owns && createdByProvider;
  };

  const buildSession = async (
    workspace: string,
    abortSignal?: AbortSignal,
  ): Promise<{ session: CoderWorkspaceSession; createdByProvider: boolean }> => {
    const { createdByProvider } = await ensureWorkspace(
      transport,
      workspace,
      settings,
      createMode,
      readyTimeoutMs,
      abortSignal,
    );
    const defaultWorkingDirectory =
      settings.defaultWorkingDirectory ??
      (await resolveHomeDirectory(transport, workspace, abortSignal));
    const session = new CoderWorkspaceSession({
      transport,
      workspace,
      id: workspace,
      defaultWorkingDirectory,
      ports: [...ports],
      ownsLifecycle: resolveOwnership(createdByProvider),
    });
    return { session, createdByProvider };
  };

  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: CODER_WORKSPACE_PROVIDER_ID,
    // `bridgePorts` intentionally left undefined: this provider binds one
    // workspace per session rather than leasing ports from a shared sandbox.
    createSession: async (options) => {
      const workspace = resolveWorkspace(options?.sessionId);
      const { session, createdByProvider } = await buildSession(workspace, options?.abortSignal);
      // `onFirstCreate` is the provider's snapshot-bootstrap hook: it runs once,
      // when the resource is first created. In create mode that means a
      // workspace we actually created; in wrap mode it follows lifecycle
      // ownership (a caller-owned workspace).
      const shouldFirstCreate = createMode ? createdByProvider : (settings.ownsLifecycle ?? false);
      if (shouldFirstCreate && options?.onFirstCreate) {
        await options.onFirstCreate(session.restricted(), {
          abortSignal: options.abortSignal,
        });
      }
      return session;
    },
    resumeSession: async (options) => {
      const workspace = resolveWorkspace(options.sessionId);
      const { session } = await buildSession(workspace, options.abortSignal);
      return session;
    },
  };
}

/**
 * Get-or-create the workspace and (in create mode) wait for its agent to be
 * ready. In wrap mode this preserves the original behavior (optionally
 * `coder start`).
 */
async function ensureWorkspace(
  transport: CoderTransport,
  workspace: string,
  settings: CoderWorkspaceSettings,
  createMode: boolean,
  readyTimeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<{ createdByProvider: boolean }> {
  if (!createMode) {
    if (settings.ensureStarted) {
      await transport.start(workspace, { abortSignal });
    }
    return { createdByProvider: false };
  }

  const create = settings.create!;
  const existing = await transport.status(workspace, { abortSignal });
  let createdByProvider = false;

  if (existing === null) {
    if (create.validate ?? true) {
      await validatePreset(transport, create, abortSignal);
    }
    await transport.create(toCreateOptions(workspace, create, abortSignal));
    createdByProvider = true;
  } else {
    if (create.ifExists === 'error') {
      throw new Error(
        `createCoderWorkspace: workspace "${workspace}" already exists (create.ifExists: 'error').`,
      );
    }
    if (isStopped(existing)) {
      await transport.start(workspace, { abortSignal });
    }
  }

  await waitForReady(transport, workspace, readyTimeoutMs, abortSignal);
  return { createdByProvider };
}

function isStopped(status: WorkspaceStatus): boolean {
  return (
    status.buildStatus === 'stopped' ||
    status.buildStatus === 'stopping' ||
    status.transition === 'stop'
  );
}

function toCreateOptions(
  workspace: string,
  create: CoderCreateSettings,
  abortSignal?: AbortSignal,
): CreateWorkspaceOptions {
  return {
    workspace,
    template: create.template,
    templateVersion: create.templateVersion,
    preset: create.preset,
    parameters: stringifyParams(create.parameters),
    parameterFile: create.parameterFile,
    useParameterDefaults: create.useParameterDefaults,
    ephemeralParameters: stringifyParams(create.ephemeralParameters),
    stopAfter: create.stopAfter,
    automaticUpdates: create.automaticUpdates,
    org: create.org,
    abortSignal,
  };
}

function stringifyParams(
  params?: Record<string, string | number | boolean>,
): Record<string, string> | undefined {
  if (params === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

/** Best-effort check that a requested preset name exists for the template. */
async function validatePreset(
  transport: CoderTransport,
  create: CoderCreateSettings,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (create.preset === undefined || create.preset.toLowerCase() === 'none') return;
  let presets: PresetInfo[];
  try {
    presets = await transport.listPresets({
      template: create.template,
      templateVersion: create.templateVersion,
      org: create.org,
      abortSignal,
    });
  } catch {
    // Introspection is best-effort; don't block creation if it fails.
    return;
  }
  // An empty list can mean "no presets" or "this Coder doesn't expose them";
  // either way there's nothing reliable to validate against.
  if (presets.length === 0) return;
  if (!presets.some((preset) => preset.name === create.preset)) {
    const available = presets.map((preset) => `"${preset.name}"`).join(', ');
    throw new Error(
      `createCoderWorkspace: preset "${create.preset}" not found for template ` +
      `"${create.template}". Available presets: ${available || '(none)'}.`,
    );
  }
}

/**
 * Poll the workspace until its agent is connected and its startup script has
 * finished (`lifecycle_state: ready`), failing fast on build or startup errors.
 * A successful build is *not* sufficient — the agent connects afterwards.
 */
async function waitForReady(
  transport: CoderTransport,
  workspace: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  for (; ;) {
    if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('aborted');
    const status = await transport.status(workspace, { abortSignal });
    if (status !== null) {
      last =
        `build=${status.buildStatus} agents=[` +
        status.agents
          .map((a) => `${a.name || '?'}:${a.status}/${a.lifecycleState}`)
          .join(', ') +
        ']';
      if (status.buildStatus === 'failed') {
        throw new Error(`createCoderWorkspace: workspace "${workspace}" build failed (${last}).`);
      }
      if (status.buildStatus === 'canceled' || status.buildStatus === 'deleted') {
        throw new Error(`createCoderWorkspace: workspace "${workspace}" is ${status.buildStatus} (${last}).`);
      }
      const errored = status.agents.find(
        (a) => a.lifecycleState === 'start_error' || a.lifecycleState === 'start_timeout',
      );
      if (errored) {
        throw new Error(
          `createCoderWorkspace: workspace "${workspace}" agent "${errored.name || '?'}" ` +
          `failed to start (lifecycle: ${errored.lifecycleState}).`,
        );
      }
      if (
        status.buildStatus === 'running' &&
        status.agents.some((a) => a.status === 'connected' && a.lifecycleState === 'ready')
      ) {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `createCoderWorkspace: timed out after ${timeoutMs}ms waiting for workspace ` +
        `"${workspace}" to become ready (last status: ${last}).`,
      );
    }
    await delay(READY_POLL_INTERVAL_MS, abortSignal);
  }
}

/** A deterministic, valid workspace name derived from the harness sessionId. */
function deriveWorkspaceName(prefix: string, sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId === '') {
    throw new Error(
      'createCoderWorkspace: create mode needs either an explicit `workspace` or a ' +
      'sessionId to derive a fresh per-session workspace name from.',
    );
  }
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 12);
  const cleanPrefix = sanitizeNameSegment(prefix) || DEFAULT_NAME_PREFIX;
  return `${cleanPrefix}-${hash}`.slice(0, 32);
}

/** Lowercase and reduce to the `[a-z0-9-]` workspace-name alphabet. */
function sanitizeNameSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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
