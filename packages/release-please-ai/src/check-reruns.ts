import type { PullRequest } from "release-please";
import type { GitHubApi } from "release-please/build/src/github-api.js";

type CheckRerunClient = {
  pulls: Pick<GitHubApi["octokit"]["pulls"], "get">;
  actions: Pick<GitHubApi["octokit"]["actions"], "listWorkflowRunsForRepo" | "reRunWorkflow">;
};

interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 15;
const DEFAULT_DELAY_MS = 1_000;

export async function rerunActionRequiredChecks(
  client: CheckRerunClient,
  repository: { owner: string; repo: string },
  pullRequests: ReadonlyArray<Pick<PullRequest, "number" | "headBranchName">>,
  options: RetryOptions = {},
): Promise<number> {
  if (pullRequests.length === 0) {
    return 0;
  }
  if (!repository.owner || !repository.repo) {
    throw new Error("GitHub repository owner and name are required");
  }

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep =
    options.sleep ?? ((delay: number) => new Promise((resolve) => setTimeout(resolve, delay)));
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`attempts must be a positive integer, got: ${attempts}`);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`delayMs must be non-negative, got: ${delayMs}`);
  }

  const targets = await Promise.all(
    pullRequests.map(async (pullRequest) => {
      if (!pullRequest.headBranchName) {
        throw new Error(`Release pull request #${pullRequest.number} has no head branch`);
      }
      const response = await client.pulls.get({
        ...repository,
        pull_number: pullRequest.number,
      });
      const sha = response.data.head.sha;
      if (!sha) {
        throw new Error(`Release pull request #${pullRequest.number} has no head SHA`);
      }
      return { branch: pullRequest.headBranchName, sha };
    }),
  );

  const rerunIds = new Set<number>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const target of targets) {
      const response = await client.actions.listWorkflowRunsForRepo({
        ...repository,
        event: "pull_request",
        branch: target.branch,
        per_page: 20,
      });
      for (const run of response.data.workflow_runs) {
        if (
          run.head_sha !== target.sha ||
          run.conclusion !== "action_required" ||
          rerunIds.has(run.id)
        ) {
          continue;
        }
        await client.actions.reRunWorkflow({ ...repository, run_id: run.id });
        rerunIds.add(run.id);
      }
    }
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }

  return rerunIds.size;
}
