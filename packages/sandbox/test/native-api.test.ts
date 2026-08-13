import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoderApiClient, parseDurationMillis, parseNativeWorkspaceRef } from "../src/native-api.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "workspace-id",
    owner_name: "me",
    name: "ws",
    template_active_version_id: "version-active",
    automatic_updates: "never",
    latest_build: {
      id: "build-id",
      template_version_id: "version-current",
      transition: "start",
      status: "running",
      job: { status: "succeeded" },
      resources: [
        {
          agents: [
            {
              id: "agent-id",
              name: "main",
              status: "connected",
              lifecycle_state: "ready",
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("native workspace parsing", () => {
  it("preserves owner and agent selectors", () => {
    expect(parseNativeWorkspaceRef("alice/workspace.main")).toEqual({
      owner: "alice",
      name: "workspace",
      agent: "main",
    });
    expect(parseNativeWorkspaceRef("workspace")).toEqual({ owner: "me", name: "workspace" });
  });

  it("rejects malformed references", () => {
    expect(() => parseNativeWorkspaceRef("a/b/c")).toThrow(/invalid workspace reference/);
    expect(() => parseNativeWorkspaceRef("ws.")).toThrow(/invalid workspace reference/);
  });

  it("parses compound stop-after durations", () => {
    expect(parseDurationMillis("1h30m5s")).toBe(5_405_000);
    expect(() => parseDurationMillis("2d")).toThrow(/invalid stopAfter/);
  });
});

describe("CoderApiClient", () => {
  it("maps workspace status and sends token auth", async () => {
    let header = "";
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async (_input, init) => {
        header = new Headers(init?.headers).get("Coder-Session-Token") ?? "";
        return json(workspace());
      },
    });
    expect(await client.status("ws")).toEqual({
      id: "workspace-id",
      name: "ws",
      buildStatus: "running",
      transition: "start",
      agents: [{ name: "main", status: "connected", lifecycleState: "ready" }],
    });
    expect(header).toBe("secret");
  });

  it("returns null only for a 404 workspace lookup", async () => {
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async () => json({ message: "not found" }, { status: 404 }),
    });
    expect(await client.status("missing")).toBeNull();
  });

  it("treats a null preset response as an empty list", async () => {
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/templates") {
          return json([
            {
              id: "template-id",
              name: "docker",
              organization_id: "org-id",
              organization_name: "default",
              active_version_id: "version-id",
            },
          ]);
        }
        return json(null);
      },
    });
    expect(await client.listPresets({ template: "docker" })).toEqual([]);
  });

  it("creates with template version, preset, YAML parameters, and TTL then waits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "coder-native-api-"));
    tempDirs.push(dir);
    const parameterFile = path.join(dir, "params.yaml");
    await writeFile(parameterFile, "cpus: 4\nregions:\n  - east\n  - west\n");
    let createBody: Record<string, unknown> | undefined;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/templates") {
          return json([
            {
              id: "template-id",
              name: "docker",
              organization_id: "org-id",
              organization_name: "default",
              active_version_id: "version-id",
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/presets") {
          return json([{ ID: "preset-id", Name: "Standard", Default: true }]);
        }
        if (url.pathname === "/api/v2/users/me/workspaces") {
          createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json(workspace({ latest_build: { id: "new-build" } }), { status: 201 });
        }
        if (url.pathname === "/api/v2/workspacebuilds/new-build") {
          return json({ id: "new-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });
    await client.create({
      workspace: "ws",
      template: "docker",
      preset: "Standard",
      parameterFile,
      parameters: { cpus: "8" },
      ephemeralParameters: { one_time: "yes" },
      stopAfter: "8h",
      automaticUpdates: "always",
    });
    expect(createBody).toMatchObject({
      template_version_id: "version-id",
      template_version_preset_id: "preset-id",
      name: "ws",
      ttl_ms: 28_800_000,
      automatic_updates: "always",
    });
    expect(createBody?.rich_parameter_values).toEqual([
      { name: "cpus", value: "8" },
      { name: "regions", value: '["east","west"]' },
      { name: "one_time", value: "yes" },
    ]);
  });

  it("starts with the prior version and waits for the provisioner job", async () => {
    const requests: { method: string; pathname: string; body?: unknown }[] = [];
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          pathname: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          return json(
            workspace({
              latest_build: {
                id: "old-build",
                template_version_id: "version-current",
                transition: "stop",
                status: "stopped",
                job: { status: "succeeded" },
                resources: [],
              },
            }),
          );
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          return json(
            { id: "start-build", transition: "start", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/start-build") {
          return json({ id: "start-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({}, { status: 500 });
      },
    });
    await client.start("ws");
    expect(requests).toContainEqual({
      method: "POST",
      pathname: "/api/v2/workspaces/workspace-id/builds",
      body: { transition: "start", template_version_id: "version-current" },
    });
  });
});
