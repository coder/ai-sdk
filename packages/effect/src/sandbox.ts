/**
 * Scoped resource management for Coder workspace sandboxes.
 *
 * Wraps `@coder/ai-sdk-sandbox`'s imperative acquisition APIs in
 * `Effect.acquireRelease`, so workspace provisioning (get-or-create, start,
 * agent-readiness waits) and teardown compose with Effect scopes: the release
 * step runs when the scope closes, both on success and when the owning fiber
 * is interrupted after acquisition. Acquisition itself is uninterruptible, per
 * standard `acquireRelease` semantics.
 *
 * Transports stay out of scope here (spike): callers can pass any
 * `CoderTransport`; the default is the ambient-login CLI transport.
 */
import {
  CoderCliTransport,
  type CoderTransport,
  type CoderWorkspaceSession,
  type CoderWorkspaceSettings,
  createCoderWorkspace,
  ensureCoderWorkspace,
  type EnsureCoderWorkspaceSettings,
  type EnsuredCoderWorkspace,
} from "@coder/ai-sdk-sandbox";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/** Failure while acquiring or releasing a Coder workspace sandbox resource. */
export class CoderSandboxError extends Data.TaggedError("CoderSandboxError")<{
  readonly phase: "acquire" | "release";
  readonly description: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.phase}: ${this.description}`;
  }
}

// ---------------------------------------------------------------------------
// Workspace (ensureCoderWorkspace)
// ---------------------------------------------------------------------------

/** A ready Coder workspace acquired for the lifetime of the current scope. */
export class CoderWorkspace extends Context.Tag("@coder/ai-sdk-effect/CoderWorkspace")<
  CoderWorkspace,
  EnsuredCoderWorkspace
>() {}

/**
 * What to do with the workspace when the scope closes:
 *
 * - `delete-if-created` (default): delete the workspace, but only when this
 *   acquisition actually created it. A pre-existing workspace is never touched.
 * - `stop-if-created`: stop instead of delete, same ownership rule.
 * - `keep`: never touch the workspace on release.
 */
export type WorkspaceTeardown = "delete-if-created" | "stop-if-created" | "keep";

/** Options for {@link acquireWorkspace}: provisioning settings + teardown policy. */
export interface AcquireWorkspaceOptions extends Omit<EnsureCoderWorkspaceSettings, "abortSignal"> {
  readonly teardown?: WorkspaceTeardown;
}

/**
 * Acquire a ready Coder workspace (`ensureCoderWorkspace`) as a scoped
 * resource. Teardown follows {@link WorkspaceTeardown} and runs on scope
 * close — including when the fiber is interrupted after acquisition. A release
 * failure is a defect (the workspace may leak; we crash loudly rather than
 * swallow it).
 */
export const acquireWorkspace = (
  options: AcquireWorkspaceOptions,
): Effect.Effect<EnsuredCoderWorkspace, CoderSandboxError, Scope.Scope> => {
  const { teardown = "delete-if-created", ...settings } = options;
  return Effect.map(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          // The same transport instance must perform acquisition and teardown.
          const transport = settings.transport ?? new CoderCliTransport();
          const workspace = await ensureCoderWorkspace({ ...settings, transport });
          return { workspace, transport };
        },
        catch: (cause) =>
          new CoderSandboxError({
            phase: "acquire",
            description: `ensureCoderWorkspace failed for "${options.workspace}"`,
            cause,
          }),
      }),
      ({ transport, workspace }) =>
        releaseWorkspace(transport, workspace, options.workspace, teardown),
    ),
    ({ workspace }) => workspace,
  );
};

const releaseWorkspace = (
  transport: CoderTransport,
  workspace: EnsuredCoderWorkspace,
  name: string,
  teardown: WorkspaceTeardown,
): Effect.Effect<void> => {
  if (teardown === "keep" || !workspace.created) return Effect.void;
  return Effect.orDie(
    Effect.tryPromise({
      try: async () => {
        if (teardown === "delete-if-created") {
          await transport.destroy(name);
        } else {
          await transport.stop(name);
        }
      },
      catch: (cause) =>
        new CoderSandboxError({
          phase: "release",
          description: `failed to ${teardown === "delete-if-created" ? "delete" : "stop"} workspace "${name}"`,
          cause,
        }),
    }),
  );
};

/** {@link acquireWorkspace} as a scoped `Layer` providing {@link CoderWorkspace}. */
export const layerWorkspace = (
  options: AcquireWorkspaceOptions,
): Layer.Layer<CoderWorkspace, CoderSandboxError> =>
  Layer.scoped(CoderWorkspace, acquireWorkspace(options));

// ---------------------------------------------------------------------------
// Session (createCoderWorkspace + createSession)
// ---------------------------------------------------------------------------

/** A live Coder workspace session acquired for the lifetime of the current scope. */
export class CoderSession extends Context.Tag("@coder/ai-sdk-effect/CoderSession")<
  CoderSession,
  CoderWorkspaceSession
>() {}

/**
 * What to do with the session when the scope closes. Both variants always
 * release host-side resources (port forwards); whether the workspace itself is
 * stopped/deleted is governed by the sandbox package's `ownsLifecycle` rules.
 */
export type SessionTeardown = "stop" | "destroy";

/** Options for {@link acquireSession}. */
export interface AcquireSessionOptions {
  /** Settings passed through to `createCoderWorkspace`. */
  readonly settings: CoderWorkspaceSettings;
  /** Optional session id used to derive per-session workspace names. */
  readonly sessionId?: string;
  /** Teardown behavior on scope close. Default: `"stop"`. */
  readonly teardown?: SessionTeardown;
}

/**
 * Acquire a Coder workspace session as a scoped resource. Release calls
 * `session.stop()` (default) or `session.destroy()` on scope close, including
 * on interruption after acquisition.
 */
export const acquireSession = (
  options: AcquireSessionOptions,
): Effect.Effect<CoderWorkspaceSession, CoderSandboxError, Scope.Scope> => {
  const teardown = options.teardown ?? "stop";
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const provider = createCoderWorkspace(options.settings);
        const session = await provider.createSession({ sessionId: options.sessionId });
        // SAFETY: createCoderWorkspace always constructs CoderWorkspaceSession
        // instances; the harness provider interface just types them loosely.
        return session as CoderWorkspaceSession;
      },
      catch: (cause) =>
        new CoderSandboxError({
          phase: "acquire",
          description: "createSession failed",
          cause,
        }),
    }),
    (session) =>
      Effect.orDie(
        Effect.tryPromise({
          try: async () => {
            if (teardown === "destroy") {
              await session.destroy();
            } else {
              await session.stop();
            }
          },
          catch: (cause) =>
            new CoderSandboxError({
              phase: "release",
              description: `failed to ${teardown} session "${session.id}"`,
              cause,
            }),
        }),
      ),
  );
};

/** {@link acquireSession} as a scoped `Layer` providing {@link CoderSession}. */
export const layerSession = (
  options: AcquireSessionOptions,
): Layer.Layer<CoderSession, CoderSandboxError> =>
  Layer.scoped(CoderSession, acquireSession(options));
