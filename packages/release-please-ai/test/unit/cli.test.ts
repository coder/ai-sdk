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
    expect(result).toEqual({ pullRequests: [{ number: 27 }], releases: [release] });
  });

  it("reports created releases before refreshing release pull requests", async () => {
    const calls: string[] = [];
    const release = { path: "packages/sandbox" } as CreatedRelease;
    const loadManifest = vi.fn(async () => ({
      createReleases: async () => [release, undefined],
      createPullRequests: async () => {
        calls.push("createPullRequests");
        return [];
      },
    }));
    const onReleasesCreated = vi.fn((releases: CreatedRelease[]) => {
      calls.push(`onReleasesCreated:${releases.length}`);
    });

    await runReleasePlease(loadManifest, onReleasesCreated);

    expect(calls).toEqual(["onReleasesCreated:1", "createPullRequests"]);
    expect(onReleasesCreated).toHaveBeenCalledWith([release]);
  });

  it("returns created releases when refreshing release pull requests fails", async () => {
    const release = { path: "packages/sandbox" } as CreatedRelease;
    const refreshError = new Error("Error updating ref");
    const loadManifest = vi
      .fn()
      .mockImplementationOnce(async () => ({
        createReleases: async () => [release],
        createPullRequests: async () => [],
      }))
      .mockImplementationOnce(async () => ({
        createReleases: async () => [],
        createPullRequests: async () => {
          throw refreshError;
        },
      }));
    const onReleasesCreated = vi.fn();

    const result = await runReleasePlease(loadManifest, onReleasesCreated);

    expect(onReleasesCreated).toHaveBeenCalledWith([release]);
    expect(result).toEqual({
      pullRequests: [],
      releases: [release],
      pullRequestError: refreshError,
    });
  });

  it("returns created releases when reloading the manifest for pull requests fails", async () => {
    const release = { path: "packages/agent" } as CreatedRelease;
    const reloadError = new Error("manifest reload failed");
    const loadManifest = vi
      .fn()
      .mockImplementationOnce(async () => ({
        createReleases: async () => [release],
        createPullRequests: async () => [],
      }))
      .mockImplementationOnce(async () => {
        throw reloadError;
      });

    const result = await runReleasePlease(loadManifest);

    expect(result).toEqual({
      pullRequests: [],
      releases: [release],
      pullRequestError: reloadError,
    });
  });
});
