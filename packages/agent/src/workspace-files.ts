import type { FileContent } from "./files.js";

/**
 * Adapter that writes bytes onto a Coder workspace's filesystem, injected into
 * a {@link CoderAgent} to enable {@link CoderAgent.uploadToWorkspace}.
 *
 * This is the "operate on this material" path — for archives, datasets,
 * binaries, oversized files, or anything outside the narrow chat-attachment
 * allowlist. It is intentionally NOT bundled into the agent package: the agent
 * core stays dependency-free, and whoever already holds a workspace connection
 * (e.g. a `@coder/ai-sdk-eve-sandbox` session) supplies a few-line adapter.
 *
 * The store does one thing — write bytes to a path. It deliberately does not
 * unpack archives or mutate the working tree: instruct the agent to `unzip`/
 * `tar -x`, or do it over your own connection.
 *
 * @example
 * ```ts
 * const store: WorkspaceFileStore = {
 *   workspaceId: session.workspaceId,
 *   write: async ({ content, path, signal }) => {
 *     await session.writeFile({ path, content: toStream(content), abortSignal: signal });
 *     return { path };
 *   },
 * };
 * ```
 */
export interface WorkspaceFileStore {
  /** The workspace these writes land in. Should match the agent's bound `workspaceId`. */
  readonly workspaceId: string;
  /**
   * Write `content` to `path` inside the workspace and return the absolute path
   * it landed at (the adapter may resolve a relative path against a working dir).
   */
  write(file: {
    content: FileContent;
    path: string;
    signal?: AbortSignal;
  }): Promise<{ path: string }>;
}

/** Where an uploaded file ended up after {@link CoderAgent.uploadToWorkspace}. */
export interface WorkspacePlacement {
  workspaceId: string;
  /** Absolute path of the file inside the workspace. */
  path: string;
}
