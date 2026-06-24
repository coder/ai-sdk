import { CoderCliTransport, createCoderWorkspace } from "@coder/ai-sdk-sandbox";
import type {
  CoderCreateSettings,
  CoderTransport,
  CoderWorkspaceRef,
  CoderWorkspaceSettings,
} from "@coder/ai-sdk-sandbox";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
} from "eve/sandbox";
import { buildCoderSandboxSession } from "./coder-session.js";

/** Stable backend name. Participates in eve's cache-key and reconnect-state derivation. */
export const CODER_BACKEND_NAME = "coder";

/**
 * What `dispose()` does to the backing Coder workspace when an eve session ends.
 *
 * `"stop"`/`"delete"` apply **only** to a workspace this backend provisions per session
 * (create mode with no explicit `workspace`). A workspace referenced by an explicit
 * `workspace` is treated as borrowed and is never stopped or deleted, regardless of this
 * setting. Note also that eve decides when (and whether) `dispose()` runs.
 *
 * - `"keep"` (default): disconnect only (close port-forwards), leave the workspace
 *   running so eve reattaches instantly on the next turn — matching eve's persistent
 *   session model and a Coder workspace's long-lived nature.
 * - `"stop"`: `coder stop` the workspace to save idle resources; a later reattach
 *   restarts it (slower reattach).
 * - `"delete"`: `coder delete` the workspace. Destructive — a later reattach provisions a
 *   fresh one, losing any in-workspace state.
 */
export type CoderDisposePolicy = "keep" | "stop" | "delete";

/** Settings for {@link createCoderSandboxBackend}. At least one of `workspace` or `create` is required. */
export interface CoderSandboxBackendSettings {
  /**
   * Existing workspace to attach to: a fixed `[owner/]workspace[.agent]`, or a
   * resolver from the eve session key. With `create` it is get-or-created; without
   * `create` it must already exist. Omit to derive a fresh per-session workspace
   * from the session key (requires `create`).
   */
  workspace?: CoderWorkspaceRef;
  /**
   * Provision a workspace on demand from a Coder template. Without an explicit
   * `workspace`, eve gets one workspace per session (named from the session key).
   * Mirrors `@coder/ai-sdk-sandbox`'s create settings (template, preset, parameters, …).
   */
  create?: CoderCreateSettings;
  /**
   * Transport used to reach Coder. Defaults to a {@link CoderCliTransport} over an
   * ambient `coder login`. Pass `new CoderCliTransport({ url, token })` for explicit auth.
   */
  transport?: CoderTransport;
  /**
   * Absolute working directory that relative paths resolve against. Defaults to the
   * workspace `$HOME`. (eve's contract roots relative paths at `/workspace`; the Coder
   * backend roots them at the workspace working directory instead.)
   */
  defaultWorkingDirectory?: string;
  /** Max ms to wait for the workspace agent to become ready after create/start. Default 300000. */
  readyTimeoutMs?: number;
  /** What `dispose()` does to the workspace. Default `"keep"`. See {@link CoderDisposePolicy}. */
  dispose?: CoderDisposePolicy;
  /**
   * Treat a restrictive `setNetworkPolicy()` as a no-op instead of throwing. The Coder
   * backend cannot enforce egress (that is the Coder template/deployment's job), so by
   * default any policy other than `"allow-all"` throws rather than implying containment.
   */
  allowUnsafeNetworkPolicy?: boolean;
}

/**
 * Create a Coder-workspace-backed {@link SandboxBackend} for Vercel's eve framework.
 *
 * Pass the result to `defineSandbox({ backend })` in your agent's `sandbox.ts`. The
 * backend runs eve's sandbox I/O (bash, file read/write, glob, grep) inside a real
 * Coder workspace via `coder ssh`, reusing `@coder/ai-sdk-sandbox` for workspace
 * orchestration (get-or-create, wait-for-ready, `$HOME` resolution, preset validation).
 *
 * Notes specific to Coder:
 * - **prewarm** is a near no-op: Coder templates are provisioned server-side (Terraform),
 *   so there is no build-time template snapshot to capture, and `seedFiles` are not baked
 *   (bake setup into the Coder template, or write from an `onSession` hook).
 * - **dispose** leaves the workspace running by default; see {@link CoderDisposePolicy}.
 * - **setNetworkPolicy** is not enforceable; see {@link CoderSandboxBackendSettings.allowUnsafeNetworkPolicy}.
 *
 * @example Provision one workspace per session from a template
 * ```ts
 * import { defineSandbox } from "eve/sandbox";
 * import { createCoderSandboxBackend } from "@coder/ai-sdk-eve-sandbox";
 *
 * export default defineSandbox({
 *   backend: createCoderSandboxBackend({ create: { template: "docker", preset: "Large" } }),
 * });
 * ```
 *
 * @example Attach to a single shared workspace
 * ```ts
 * createCoderSandboxBackend({ workspace: "my-dev-workspace" })
 * ```
 */
export function createCoderSandboxBackend(
  settings: CoderSandboxBackendSettings = {},
): SandboxBackend {
  const transport: CoderTransport = settings.transport ?? new CoderCliTransport();
  const disposePolicy: CoderDisposePolicy = settings.dispose ?? "keep";
  // Only a workspace we provision per session (create mode, no explicit `workspace` ⇒ a
  // fresh derived-name workspace) is ours to stop/delete. A workspace referenced by an
  // explicit `workspace` may be shared/pre-existing, so it is treated as borrowed and is
  // never torn down — mirroring @coder/ai-sdk-sandbox's borrowed-workspace protection.
  const ownsWorkspace = settings.workspace === undefined;

  // Reuse the workspace orchestration from @coder/ai-sdk-sandbox. We force
  // `ports: []` (eve does not forward ports) and `ownsLifecycle: false` (the session
  // must never tear the workspace down on its own — `dispose()` owns teardown per
  // `disposePolicy`). Optional fields pass through as-is; createCoderWorkspace fills in
  // its own defaults for any left undefined.
  const base = {
    transport,
    ports: [] as number[],
    ownsLifecycle: false,
    // Treat an empty string as unset so the provider's $HOME fallback applies (`??` would
    // otherwise keep "" and root relative paths at the ssh login cwd).
    defaultWorkingDirectory: settings.defaultWorkingDirectory || undefined,
    readyTimeoutMs: settings.readyTimeoutMs,
  };

  let workspaceSettings: CoderWorkspaceSettings;
  if (settings.create !== undefined) {
    workspaceSettings = { ...base, workspace: settings.workspace, create: settings.create };
  } else if (settings.workspace !== undefined) {
    workspaceSettings = { ...base, workspace: settings.workspace };
  } else {
    throw new Error(
      "createCoderSandboxBackend: set `workspace` (attach to an existing workspace), " +
        "`create` (provision one per session from a Coder template), or both.",
    );
  }

  // createCoderWorkspace returns a Vercel AI SDK *harness* provider
  // (HarnessV1SandboxProvider), so @ai-sdk/harness + @ai-sdk/provider-utils are
  // transitive, type-only build requirements of this package (declared as devDeps). We
  // use only its createSession/resumeSession orchestration and adapt the result to eve.
  const provider = createCoderWorkspace(workspaceSettings);

  return {
    name: CODER_BACKEND_NAME,
    async prewarm(input: SandboxBackendPrewarmInput) {
      if (input.seedFiles.length > 0) {
        input.log?.(
          `coder backend: ignoring ${input.seedFiles.length} seed file(s). Build-time template ` +
            "capture is not supported for Coder; bake setup into the Coder template, or write files " +
            "from a sandbox onSession hook.",
        );
      }
      // Coder templates are provisioned server-side, out of band from eve's build: there
      // is no reusable template state to capture, so prewarm is a no-op. We always report
      // `reused: false` — there is no captured state for a later deploy to reuse.
      return { reused: false };
    },
    async create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle> {
      // `existingMetadata` present ⇒ eve is reattaching a prior session. The provider
      // derives the workspace name deterministically from the session key either way, so
      // create and resume converge on the same workspace. (We intentionally don't read
      // `existingMetadata.workspace`; reattach therefore assumes the workspace settings —
      // resolver, create.owner/namePrefix — are stable across deploys.)
      const io =
        input.existingMetadata !== undefined && provider.resumeSession !== undefined
          ? await provider.resumeSession({ sessionId: input.sessionKey })
          : await provider.createSession({ sessionId: input.sessionKey });

      const workspace = io.id;
      const session = buildCoderSandboxSession(io, {
        transport,
        workspace,
        allowUnsafeNetworkPolicy: settings.allowUnsafeNetworkPolicy,
      });

      return {
        session,
        useSessionFn: async () => session,
        async captureState() {
          return {
            backendName: CODER_BACKEND_NAME,
            metadata: { workspace },
            sessionKey: input.sessionKey,
          };
        },
        async dispose() {
          // Two layers, by design: io.stop() only releases host-side resources
          // (port-forwards) — the provider session is constructed with ownsLifecycle:false,
          // so it never stops or deletes the workspace. Workspace lifecycle is owned here.
          await io.stop();
          // Never stop/delete a borrowed (explicitly named) workspace, whatever the policy.
          if (!ownsWorkspace) return;
          if (disposePolicy === "stop") {
            await transport.stop(workspace);
          } else if (disposePolicy === "delete") {
            await transport.destroy(workspace);
          }
          // "keep": leave the workspace running for instant reattach.
        },
      };
    },
  };
}
