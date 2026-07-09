import { CoderAgentError } from "./errors.js";

/** The `ai` peer-dependency major this package is built against (`ai@^6`). */
const SUPPORTED_AI_MAJOR = 6;

/**
 * Decides whether a resolved `ai` package version is supported. Returns the
 * error message to raise for a known-incompatible major, or `undefined` to
 * proceed. Unparseable strings also return `undefined`: the guard fails open
 * rather than inventing a failure on exotic version formats.
 */
export function unsupportedAiVersionMessage(version: string): string | undefined {
  const major = Number(/^v?(\d+)(?:[.+-]|$)/.exec(version.trim())?.[1]);
  if (!Number.isSafeInteger(major) || major === SUPPORTED_AI_MAJOR) return undefined;
  return (
    `@coder/ai-sdk-agent supports the \`ai\` package v${SUPPORTED_AI_MAJOR} only ` +
    `(peer dependency \`ai@^${SUPPORTED_AI_MAJOR}\`), but ai@${version} is installed. ` +
    `Other majors fail at runtime in confusing ways (brand-check TypeErrors, silently ` +
    `empty streams). Install a compatible version, e.g. \`pnpm add ai@^${SUPPORTED_AI_MAJOR}\`.`
  );
}

/**
 * Best-effort resolution of the installed `ai` package's version via
 * `createRequire(import.meta.url)("ai/package.json")` (both v6 and v7 export
 * `./package.json`). Returns `undefined` whenever resolution isn't possible —
 * non-Node runtime, bundle without module resolution, `ai` not installed, … —
 * because the guard must never introduce a failure of its own. `node:module`
 * is reached through `process.getBuiltinModule` (Node ≥ 20.16) instead of a
 * static import, which would crash non-Node runtimes at module-load time.
 */
function resolveInstalledAiVersion(): string | undefined {
  try {
    const nodeModule =
      typeof process !== "undefined" && typeof process.getBuiltinModule === "function"
        ? process.getBuiltinModule("node:module")
        : undefined;
    const requireFromHere = nodeModule?.createRequire(import.meta.url);
    const pkg = requireFromHere?.("ai/package.json") as { version?: unknown } | undefined;
    return typeof pkg?.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Memoized verdict: `undefined` = not yet computed, `null` = supported (or
 * unresolvable), a string = the message to throw on every construction.
 */
let cachedMessage: string | null | undefined;

/**
 * Asserts that the installed `ai` major matches this package's peer range
 * (`ai@^6`). Called from the `CoderAgent`/`CoderLanguageModel` constructors so
 * an incompatible AI SDK fails fast with an actionable error instead of the
 * cryptic failures it produces mid-generation. Fails open when the installed
 * version cannot be resolved. The verdict is memoized across calls.
 *
 * @param resolveVersion Test seam; production callers use the default.
 */
export function assertSupportedAiVersion(
  resolveVersion: () => string | undefined = resolveInstalledAiVersion,
): void {
  if (cachedMessage === undefined) {
    const version = resolveVersion();
    cachedMessage = version === undefined ? null : (unsupportedAiVersionMessage(version) ?? null);
  }
  if (cachedMessage !== null) throw new CoderAgentError(cachedMessage);
}

/** Clears the memoized verdict so resolution runs again (unit-test hook). */
export function resetAiVersionCheckForTests(): void {
  cachedMessage = undefined;
}
