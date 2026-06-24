import { posix } from "node:path";
import type { CoderTransport } from "@coder/ai-sdk-sandbox";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

/**
 * Options accepted by {@link SandboxSession.removePath}. eve does not re-export this
 * type by name from `eve/sandbox`, so we derive it from the session surface.
 */
type SandboxRemovePathOptions = Parameters<SandboxSession["removePath"]>[0];

/**
 * The slice of a Coder workspace session this adapter builds upon: the eight
 * AI SDK I/O methods plus identity and working directory. `CoderWorkspaceSession`
 * from `@coder/ai-sdk-sandbox` satisfies this structurally — both it and eve's
 * {@link SandboxSession} derive these methods from the same AI SDK
 * `Experimental_SandboxSession` shape, so no harness types leak into this surface.
 */
export type CoderIoSession = Pick<
  SandboxSession,
  | "run"
  | "spawn"
  | "readFile"
  | "readBinaryFile"
  | "readTextFile"
  | "writeFile"
  | "writeBinaryFile"
  | "writeTextFile"
> & {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
};

export interface CoderSandboxSessionOptions {
  /** Transport used for the eve-specific operations (`removePath`) not on the I/O session. */
  readonly transport: CoderTransport;
  /** Workspace reference the transport targets, e.g. `[owner/]workspace[.agent]`. */
  readonly workspace: string;
  /**
   * Treat a restrictive {@link SandboxSession.setNetworkPolicy} call as a no-op
   * instead of throwing. The Coder backend has no firewall to enforce egress, so
   * by default anything other than `"allow-all"` throws rather than giving a
   * false sense of containment. See {@link buildCoderSandboxSession}.
   */
  readonly allowUnsafeNetworkPolicy?: boolean;
}

/**
 * Adapt a Coder workspace I/O session into eve's public {@link SandboxSession}.
 *
 * The eight I/O methods delegate straight through (they already resolve relative
 * paths against the workspace working directory). Note this routes the text/encoding,
 * line-range, and `run` (collect-from-`spawn`) semantics through `@coder/ai-sdk-sandbox`'s
 * implementation rather than eve's internal `buildSandboxSession` (which isn't exported);
 * the two are intended to match, as both mirror the AI SDK `Experimental_SandboxSession`.
 * The eve-specific additions are layered on here:
 * - `resolvePath` anchors relative paths to the workspace working directory
 *   (eve's contract roots them at `/workspace`; a Coder workspace roots them at
 *   its `$HOME`/working directory instead).
 * - `removePath` runs `rm` over the transport.
 * - `setNetworkPolicy` cannot be enforced (egress is governed by the Coder
 *   template/deployment), so it accepts `"allow-all"` and otherwise throws unless
 *   {@link CoderSandboxSessionOptions.allowUnsafeNetworkPolicy} is set.
 */
export function buildCoderSandboxSession(
  io: CoderIoSession,
  options: CoderSandboxSessionOptions,
): SandboxSession {
  const cwd = io.defaultWorkingDirectory;
  const resolvePath = (path: string): string =>
    path.startsWith("/") ? path : posix.join(cwd, path);

  return {
    id: io.id,
    resolvePath,
    run: io.run,
    spawn: io.spawn,
    readFile: io.readFile,
    readBinaryFile: io.readBinaryFile,
    readTextFile: io.readTextFile,
    writeFile: io.writeFile,
    writeBinaryFile: io.writeBinaryFile,
    writeTextFile: io.writeTextFile,
    removePath: async (removeOptions: SandboxRemovePathOptions): Promise<void> => {
      if (removeOptions.path.trim() === "") {
        throw new Error("removePath: `path` must not be empty");
      }
      const absolute = resolvePath(removeOptions.path);
      // Guard against a degenerate target resolving to the working directory or root,
      // which would turn an `rm -rf` into deleting the whole workspace home / filesystem.
      if (absolute === "/" || absolute === cwd) {
        throw new Error(
          `removePath: refusing to remove ${absolute === "/" ? "the filesystem root" : "the working directory"} (${absolute})`,
        );
      }
      const flags = `${removeOptions.recursive === true ? "r" : ""}${removeOptions.force === true ? "f" : ""}`;
      const command = `rm ${flags.length > 0 ? `-${flags} ` : ""}-- ${shellQuote(absolute)}`;
      const result = await options.transport.exec({
        workspace: options.workspace,
        command,
        abortSignal: removeOptions.abortSignal,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `failed to remove ${absolute} (exit ${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
    },
    setNetworkPolicy: async (policy: SandboxNetworkPolicy): Promise<void> => {
      if (policy === "allow-all") return;
      if (options.allowUnsafeNetworkPolicy === true) return;
      throw new Error(
        "the Coder eve sandbox backend cannot enforce network policies: egress is governed by " +
          "your Coder template/deployment, not this backend. Configure egress in the Coder template, " +
          "or pass `allowUnsafeNetworkPolicy: true` to treat setNetworkPolicy as a no-op.",
      );
    },
  };
}

/**
 * POSIX single-quote a string for safe embedding in a `/bin/sh` command line,
 * escaping embedded single quotes with the classic `'\''` idiom.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
