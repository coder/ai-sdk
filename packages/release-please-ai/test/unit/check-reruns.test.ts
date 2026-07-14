import { describe, expect, it, vi } from "vitest";
import { rerunActionRequiredChecks } from "../../src/check-reruns.js";

describe("rerunActionRequiredChecks", () => {
  it("reruns action-required checks for the current release PR head", async () => {
    const get = vi.fn(async () => ({ data: { head: { sha: "current-sha" } } }));
    const listWorkflowRunsForRepo = vi.fn(async () => ({
      data: {
        workflow_runs: [
          { id: 1, head_sha: "current-sha", conclusion: "action_required" },
          { id: 2, head_sha: "current-sha", conclusion: "action_required" },
          { id: 3, head_sha: "current-sha", conclusion: "success" },
          { id: 4, head_sha: "stale-sha", conclusion: "action_required" },
        ],
      },
    }));
    const reRunWorkflow = vi.fn(async () => ({}));
    const sleep = vi.fn(async () => undefined);

    const count = await rerunActionRequiredChecks(
      {
        pulls: { get },
        actions: { listWorkflowRunsForRepo, reRunWorkflow },
      } as never,
      { owner: "coder", repo: "ai-sdk" },
      [{ number: 27, headBranchName: "release-please--sandbox" }],
      { attempts: 2, delayMs: 0, sleep },
    );

    expect(get).toHaveBeenCalledWith({ owner: "coder", repo: "ai-sdk", pull_number: 27 });
    expect(listWorkflowRunsForRepo).toHaveBeenCalledTimes(2);
    expect(reRunWorkflow.mock.calls).toEqual([
      [{ owner: "coder", repo: "ai-sdk", run_id: 1 }],
      [{ owner: "coder", repo: "ai-sdk", run_id: 2 }],
    ]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(count).toBe(2);
  });

  it("does not query GitHub when no release PR was updated", async () => {
    const get = vi.fn();
    const listWorkflowRunsForRepo = vi.fn();
    const reRunWorkflow = vi.fn();

    await expect(
      rerunActionRequiredChecks(
        {
          pulls: { get },
          actions: { listWorkflowRunsForRepo, reRunWorkflow },
        } as never,
        { owner: "coder", repo: "ai-sdk" },
        [],
      ),
    ).resolves.toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(reRunWorkflow).not.toHaveBeenCalled();
  });
});
