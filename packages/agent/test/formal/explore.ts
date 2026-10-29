/**
 * Depth-first enumeration of every run of a nondeterministic harness.
 *
 * The harness asks a {@link Chooser} at each point where the environment
 * (here: chatd and the network) could do more than one thing. The real code
 * under test cannot be snapshotted, so each run starts from scratch and
 * replays a prefix of earlier decisions (stateless model checking). After a
 * run, the explorer moves to the next unexplored option of the deepest
 * decision that has one, so the runs cover every decision sequence exactly
 * once.
 */

/** One decision in a run: the options the harness offered and the one it took. */
export interface Decision {
  options: readonly string[];
  taken: number;
}

export class Chooser {
  readonly decisions: Decision[] = [];
  readonly #prefix: readonly Decision[];

  constructor(prefix: readonly Decision[]) {
    this.#prefix = prefix;
  }

  /** Returns the option to take. Replays the prefix, then takes the first option. */
  choose(options: readonly string[]): string {
    if (options.length === 0) throw new Error("Chooser: a decision needs at least one option");
    const index = this.decisions.length;
    const replayed = this.#prefix[index];
    let taken = 0;
    if (replayed) {
      // The same decision sequence must reach the same options. If it does
      // not, the code under test is nondeterministic and the enumeration is
      // not exhaustive: stop instead of reporting a false pass.
      if (replayed.options.join("|") !== options.join("|")) {
        throw new Error(
          `Chooser: replay diverged at decision ${index}: expected [${replayed.options.join(", ")}], got [${options.join(", ")}]`,
        );
      }
      taken = replayed.taken;
    }
    this.decisions.push({ options, taken });
    const option = options[taken];
    if (option === undefined) throw new Error(`Chooser: option ${taken} out of range`);
    return option;
  }
}

/**
 * Calls `run` once for every decision sequence. Throws when the count passes
 * `maxRuns`, so a bound that grew by mistake fails fast instead of hanging.
 */
export async function exploreAll(
  run: (chooser: Chooser) => Promise<void>,
  maxRuns: number,
): Promise<number> {
  let prefix: Decision[] = [];
  let runs = 0;
  for (;;) {
    const chooser = new Chooser(prefix);
    await run(chooser);
    // A run that ends before it replays the whole prefix took a different
    // path on the same decisions: the branches below the prefix would be
    // skipped, so stop instead of reporting a false pass.
    if (chooser.decisions.length < prefix.length) {
      throw new Error(
        `exploreAll: replay ended after ${chooser.decisions.length} of ${prefix.length} recorded decisions`,
      );
    }
    runs += 1;
    if (runs > maxRuns) throw new Error(`exploreAll: more than ${maxRuns} runs; lower the bounds`);
    const decisions = chooser.decisions;
    let k = decisions.length - 1;
    while (k >= 0) {
      const d = decisions[k];
      if (d && d.taken + 1 < d.options.length) break;
      k -= 1;
    }
    if (k < 0) return runs;
    const last = decisions[k];
    if (!last) throw new Error("exploreAll: lost the backtrack point");
    prefix = [...decisions.slice(0, k), { options: last.options, taken: last.taken + 1 }];
  }
}
