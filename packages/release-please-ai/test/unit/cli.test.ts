import type { CreatedRelease } from "release-please";
import { describe, expect, it, vi } from "vitest";
import { runReleasePlease } from "../../src/cli.js";

describe("runReleasePlease", () => {
  it("creates releases before reloading and refreshing release pull requests", async () => {
    const calls: string[] = [];
    const release = { path: "packages/agent" } as CreatedRelease;
    const createReleases = vi.fn(async () => {
      calls.push("createReleases");
      return [release, undefined];
    });
    const createPullRequests = vi.fn(async () => {
      calls.push("createPullRequests");
      return [{ number: 27 }, undefined];
    });
    const loadManifest = vi
      .fn()
      .mockImplementationOnce(async () => ({
        createReleases,
        createPullRequests: vi.fn(() => {
          throw new Error("first manifest must not create pull requests");
        }),
      }))
      .mockImplementationOnce(async () => ({
        createReleases: vi.fn(() => {
          throw new Error("second manifest must not create releases");
        }),
        createPullRequests,
      }));

    const result = await runReleasePlease(loadManifest);

    expect(calls).toEqual(["createReleases", "createPullRequests"]);
    expect(loadManifest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ pullRequestCount: 1, releases: [release] });
  });
});
