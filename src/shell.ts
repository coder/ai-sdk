/**
 * POSIX single-quote a string so it can be embedded safely in a /bin/sh or bash
 * command line. Wraps the value in single quotes and escapes any embedded
 * single quote using the classic `'\''` idiom.
 *
 * @example
 *   shellQuote(`it's`) // => `'it'\''s'`
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RemoteCommandOptions {
  /** The command to run, as a shell string (executed by `bash`). */
  command: string;
  /** Absolute working directory to `cd` into before running the command. */
  workingDirectory?: string;
  /** Environment variables to set for the command only. */
  env?: Record<string, string>;
}

/**
 * Build the shell script that runs inside the workspace for a single command.
 *
 * The result is delivered verbatim as one argv element to `coder ssh ... -- bash
 * -lc <script>` (no intermediate local shell), so it only has to be valid bash
 * for the *remote* login shell.
 *
 * Shapes produced:
 * - no cwd, no env:   `<command>`
 * - cwd, no env:      `cd '<dir>' && <command>`
 * - cwd + env:        `cd '<dir>' && env A='1' B='2' bash -c '<command>'`
 *
 * When env vars are present the command is wrapped in an inner `bash -c` so the
 * `env` prefix applies to the whole (possibly compound) command string rather
 * than just its first word.
 */
export function buildRemoteScript(options: RemoteCommandOptions): string {
  const segments: string[] = [];

  if (options.workingDirectory !== undefined && options.workingDirectory !== '') {
    segments.push(`cd ${shellQuote(options.workingDirectory)} &&`);
  }

  const envEntries = Object.entries(options.env ?? {});
  if (envEntries.length > 0) {
    const assignments = envEntries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
    segments.push(`env ${assignments} bash -c ${shellQuote(options.command)}`);
  } else {
    segments.push(options.command);
  }

  return segments.join(' ');
}
