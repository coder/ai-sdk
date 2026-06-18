/**
 * A minimal projection of a release-please `ConventionalCommit`, carrying only
 * what the model needs to write editorial notes. Keeping this decoupled from
 * release-please's type keeps the prompt/render code and its tests simple.
 */
export interface CommitView {
  type: string;
  scope: string | null;
  bareMessage: string;
  breaking: boolean;
  prNumber: number | null;
}

/** Inputs to the editorial generation step (one component's release). */
export interface EditorialInput {
  /** The release tag, e.g. "agent-v0.2.0". */
  currentTag: string;
  /** The version being released, e.g. "0.2.0". */
  version: string;
  /** Visible (non-hidden) commits scoped to this component. */
  commits: CommitView[];
}

/** Repo context used to render PR links in the editorial block. */
export interface EditorialContext {
  host?: string;
  owner: string;
  repository: string;
}
