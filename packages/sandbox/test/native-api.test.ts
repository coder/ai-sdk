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
    owner_id: "user-id",
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

  it("cancels stalled response bodies when custom fetch ignores its signal", async () => {
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    let resolveCanceled!: () => void;
    const canceled = new Promise<void>((resolve) => {
      resolveCanceled = resolve;
    });
    let cancelReason: unknown;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              resolveReadStarted();
            },
            cancel(reason) {
              cancelReason = reason;
              resolveCanceled();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });
    const controller = new AbortController();
    const status = client.status("ws", { abortSignal: controller.signal });
    await readStarted;

    const reason = new Error("cancel response body");
    controller.abort(reason);
    await expect(status).rejects.toBe(reason);
    await canceled;
    expect(cancelReason).toBe(reason);
  });

  it("returns null only for a 404 workspace lookup", async () => {
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async () => json({ message: "not found" }, { status: 404 }),
    });
    expect(await client.status("missing")).toBeNull();
  });

  it("rejects cross-origin API redirects before forwarding credentials", async () => {
    let targetCalled = false;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(init?.redirect).toBe("manual");
        if (url.origin === "https://coder.example.test") {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.example.test/capture" },
          });
        }
        targetCalled = true;
        return json(workspace());
      },
    });

    await expect(client.status("ws")).rejects.toThrow(/refused cross-origin redirect/);
    expect(targetCalled).toBe(false);
  });

  it("preserves credentials across same-origin API redirects", async () => {
    const requests: { pathname: string; token: string | null }[] = [];
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          pathname: url.pathname,
          token: new Headers(init?.headers).get("Coder-Session-Token"),
        });
        if (url.pathname.endsWith("/workspace/ws")) {
          return new Response(null, {
            status: 307,
            headers: { Location: "/redirected-workspace" },
          });
        }
        return json(workspace());
      },
    });

    await expect(client.status("ws")).resolves.toMatchObject({ id: "workspace-id" });
    expect(requests).toEqual([
      { pathname: "/api/v2/users/me/workspace/ws", token: "secret" },
      { pathname: "/redirected-workspace", token: "secret" },
    ]);
  });

  it("does not await unbounded redirect body cleanup", async () => {
    let resolveCancelCalled!: () => void;
    const cancelCalled = new Promise<void>((resolve) => {
      resolveCancelCalled = resolve;
    });
    let requests = 0;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      fetch: async () => {
        requests += 1;
        if (requests === 1) {
          return new Response(
            new ReadableStream({
              cancel() {
                resolveCancelCalled();
                return new Promise<void>(() => {});
              },
            }),
            { status: 307, headers: { Location: "/redirected-workspace" } },
          );
        }
        return json(workspace());
      },
    });

    await expect(client.status("ws")).resolves.toMatchObject({ id: "workspace-id" });
    await cancelCalled;
    expect(requests).toBe(2);
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
              use_classic_parameter_flow: true,
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
              use_classic_parameter_flow: true,
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/presets") {
          return json([{ ID: "preset-id", Name: "Standard", Default: true }]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/rich-parameters") {
          return json([
            { name: "cpus", default_value: "2", required: false, ephemeral: false },
            { name: "regions", default_value: "[]", required: false, ephemeral: false },
            { name: "one_time", default_value: "", required: false, ephemeral: true },
          ]);
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

  it("requires opt-in before resolving classic parameter defaults", async () => {
    let createBody: Record<string, unknown> | undefined;
    let createRequests = 0;
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
              use_classic_parameter_flow: true,
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/rich-parameters") {
          return json([
            {
              name: "token",
              display_name: "API token",
              default_value: "",
              required: true,
              ephemeral: false,
            },
            {
              name: "region",
              display_name: "Region",
              default_value: "us-central",
              required: false,
              ephemeral: false,
            },
            {
              name: "one_time",
              default_value: "temporary",
              required: false,
              ephemeral: true,
            },
          ]);
        }
        if (url.pathname === "/api/v2/users/me/workspaces") {
          createRequests++;
          createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json(workspace({ latest_build: { id: "new-build" } }), { status: 201 });
        }
        if (url.pathname === "/api/v2/workspacebuilds/new-build") {
          return json({ id: "new-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await expect(
      client.create({ workspace: "ws", template: "docker", preset: "none" }),
    ).rejects.toThrow(/required Coder workspace parameters.*API token/);
    await expect(
      client.create({
        workspace: "ws",
        template: "docker",
        preset: "none",
        parameters: { token: "secret-value" },
      }),
    ).rejects.toThrow(/explicit values.*Region.*useParameterDefaults/);
    await client.create({
      workspace: "ws",
      template: "docker",
      preset: "none",
      parameters: { token: "secret-value" },
      useParameterDefaults: true,
    });

    expect(createRequests).toBe(1);
    expect(createBody?.rich_parameter_values).toEqual([
      { name: "token", value: "secret-value" },
      { name: "region", value: "us-central" },
    ]);
  });

  it("evaluates dynamic parameters with owner and preset inputs", async () => {
    let evaluationBody: Record<string, unknown> | undefined;
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
              use_classic_parameter_flow: false,
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/presets") {
          return json([
            {
              ID: "preset-id",
              Name: "Large",
              Default: true,
              Parameters: [{ Name: "size", Value: "large" }],
            },
          ]);
        }
        if (url.pathname === "/api/v2/users/alice") return json({ id: "alice-id" });
        if (url.pathname === "/api/v2/templateversions/version-id/dynamic-parameters/evaluate") {
          evaluationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({
            parameters: [
              {
                name: "size",
                default_value: { value: "small", valid: true },
                required: false,
                ephemeral: false,
              },
              {
                name: "region",
                default_value: { value: "us-central", valid: true },
                required: false,
                ephemeral: false,
              },
              {
                name: "rebuild",
                default_value: { value: "false", valid: true },
                required: false,
                ephemeral: true,
              },
            ],
          });
        }
        if (url.pathname === "/api/v2/users/alice/workspaces") {
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
      workspace: "alice/ws",
      template: "docker",
      useParameterDefaults: true,
    });

    expect(evaluationBody).toEqual({ id: 0, inputs: { size: "large" }, owner_id: "alice-id" });
    expect(createBody).toMatchObject({
      name: "ws",
      template_version_id: "version-id",
      template_version_preset_id: "preset-id",
      rich_parameter_values: [
        { name: "size", value: "large" },
        { name: "region", value: "us-central" },
      ],
    });
  });

  it("requires an explicit value for an invalid dynamic parameter default", async () => {
    let createBody: Record<string, unknown> | undefined;
    let createRequests = 0;
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
              use_classic_parameter_flow: false,
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/dynamic-parameters/evaluate") {
          return json({
            parameters: [
              {
                name: "region",
                display_name: "Region",
                default_value: { value: "retired-region", valid: false },
                required: false,
                ephemeral: false,
              },
            ],
          });
        }
        if (url.pathname === "/api/v2/users/me/workspaces") {
          createRequests += 1;
          createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json(workspace({ latest_build: { id: "new-build" } }), { status: 201 });
        }
        if (url.pathname === "/api/v2/workspacebuilds/new-build") {
          return json({ id: "new-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await expect(
      client.create({
        workspace: "ws",
        template: "docker",
        preset: "none",
        useParameterDefaults: true,
      }),
    ).rejects.toThrow(
      'Coder workspace parameters require explicit values: "Region"; supply values with parameters, parameterFile, or a preset',
    );
    await client.create({
      workspace: "ws",
      template: "docker",
      preset: "none",
      parameters: { region: "active-region" },
      useParameterDefaults: true,
    });

    expect(createRequests).toBe(1);
    expect(createBody?.rich_parameter_values).toEqual([{ name: "region", value: "active-region" }]);
  });

  it("selects the default preset only when preset is omitted", async () => {
    const createBodies: Record<string, unknown>[] = [];
    let presetRequests = 0;
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
              use_classic_parameter_flow: true,
            },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/presets") {
          presetRequests++;
          return json([
            { ID: "other-preset-id", Name: "Other", Default: false },
            { ID: "default-preset-id", Name: "Default", Default: true },
          ]);
        }
        if (url.pathname === "/api/v2/templateversions/version-id/rich-parameters") {
          return json([]);
        }
        if (url.pathname === "/api/v2/users/me/workspaces") {
          createBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json(workspace({ latest_build: { id: "new-build" } }), { status: 201 });
        }
        if (url.pathname === "/api/v2/workspacebuilds/new-build") {
          return json({ id: "new-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await client.create({ workspace: "default-ws", template: "docker" });
    await client.create({ workspace: "no-preset-ws", template: "docker", preset: "none" });

    expect(presetRequests).toBe(1);
    expect(createBodies[0]).toMatchObject({
      name: "default-ws",
      template_version_preset_id: "default-preset-id",
    });
    expect(createBodies[1]).toEqual({
      name: "no-preset-ws",
      template_version_id: "version-id",
    });
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

  it("waits for an in-flight stop before creating a start build", async () => {
    const events: string[] = [];
    let workspaceRequests = 0;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          workspaceRequests += 1;
          const status = workspaceRequests <= 2 ? "stopping" : "stopped";
          events.push(`workspace:${status}`);
          return json(
            workspace({
              latest_build: {
                id: "stop-build",
                template_version_id: "version-current",
                transition: "stop",
                status,
                job: { status: workspaceRequests <= 2 ? "running" : "succeeded" },
                resources: [],
              },
            }),
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/stop-build") {
          events.push("poll:stop");
          return json({ id: "stop-build", transition: "stop", job: { status: "succeeded" } });
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          events.push("post:start");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({ transition: "start" });
          return json(
            { id: "start-build", transition: "start", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/start-build") {
          events.push("poll:start");
          return json({ id: "start-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await client.start("ws");
    expect(events).toEqual([
      "workspace:stopping",
      "workspace:stopping",
      "poll:stop",
      "workspace:stopped",
      "post:start",
      "poll:start",
    ]);
  });

  it("waits for an in-flight start before creating a stop build", async () => {
    const events: string[] = [];
    let workspaceRequests = 0;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          workspaceRequests += 1;
          const status = workspaceRequests <= 2 ? "starting" : "running";
          events.push(`workspace:${status}`);
          return json(
            workspace({
              latest_build: {
                id: "start-build",
                transition: "start",
                status,
                job: { status: workspaceRequests <= 2 ? "running" : "succeeded" },
                resources: [],
              },
            }),
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/start-build") {
          events.push("poll:start");
          return json({ id: "start-build", transition: "start", job: { status: "succeeded" } });
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          events.push("post:stop");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ transition: "stop" });
          return json(
            { id: "stop-build", transition: "stop", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/stop-build") {
          events.push("poll:stop");
          return json({ id: "stop-build", transition: "stop", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await client.stop("ws");
    expect(events).toEqual([
      "workspace:starting",
      "workspace:starting",
      "poll:start",
      "workspace:running",
      "post:stop",
      "poll:stop",
    ]);
  });

  it("waits for an in-flight stop before creating a delete build", async () => {
    const events: string[] = [];
    let workspaceRequests = 0;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          workspaceRequests += 1;
          const status = workspaceRequests <= 2 ? "stopping" : "stopped";
          events.push(`workspace:${status}`);
          return json(
            workspace({
              latest_build: {
                id: "stop-build",
                transition: "stop",
                status,
                job: { status: workspaceRequests <= 2 ? "running" : "succeeded" },
                resources: [],
              },
            }),
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/stop-build") {
          events.push("poll:stop");
          return json({ id: "stop-build", transition: "stop", job: { status: "succeeded" } });
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          events.push("post:delete");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ transition: "delete" });
          return json(
            { id: "delete-build", transition: "delete", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/delete-build") {
          events.push("poll:delete");
          return json({ id: "delete-build", transition: "delete", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await client.destroy("ws");
    expect(events).toEqual([
      "workspace:stopping",
      "workspace:stopping",
      "poll:stop",
      "workspace:stopped",
      "post:delete",
      "poll:delete",
    ]);
  });

  it("waits for a canceling build before creating the next transition", async () => {
    const events: string[] = [];
    let canceled = false;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") {
          const status = canceled ? "stopped" : "canceling";
          events.push(`workspace:${status}`);
          return json(
            workspace({
              latest_build: {
                id: "canceled-start",
                template_version_id: "version-current",
                transition: "start",
                status,
                job: { status: canceled ? "canceled" : "canceling" },
                resources: [],
              },
            }),
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/canceled-start") {
          events.push("poll:canceled-start");
          canceled = true;
          return json({ id: "canceled-start", transition: "start", job: { status: "canceled" } });
        }
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          events.push("post:start");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toMatchObject({ transition: "start" });
          return json(
            { id: "start-build", transition: "start", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/start-build") {
          events.push("poll:start");
          return json({ id: "start-build", transition: "start", job: { status: "succeeded" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    await client.start("ws");
    expect(events).toEqual([
      "workspace:canceling",
      "workspace:canceling",
      "poll:canceled-start",
      "workspace:stopped",
      "post:start",
      "poll:start",
    ]);
  });

  it("serializes concurrent lifecycle calls by workspace identity", async () => {
    const scenarios = [
      {
        transition: "start",
        initialStatus: "stopped",
        initialTransition: "stop",
        finalStatus: "running",
        invoke: (client: CoderApiClient, ref: string) => client.start(ref),
      },
      {
        transition: "stop",
        initialStatus: "running",
        initialTransition: "start",
        finalStatus: "stopped",
        invoke: (client: CoderApiClient, ref: string) => client.stop(ref),
      },
      {
        transition: "delete",
        initialStatus: "stopped",
        initialTransition: "stop",
        finalStatus: "deleted",
        invoke: (client: CoderApiClient, ref: string) => client.destroy(ref),
      },
    ];

    for (const scenario of scenarios) {
      let releaseInitialLookups!: () => void;
      const initialLookupsReady = new Promise<void>((resolve) => {
        releaseInitialLookups = resolve;
      });
      let workspaceRequests = 0;
      let status = scenario.initialStatus;
      let transition = scenario.initialTransition;
      let buildPosts = 0;
      const buildId = `${scenario.transition}-build`;
      const client = new CoderApiClient({
        url: "https://coder.example.test",
        token: "secret",
        buildPollIntervalMs: 1,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/api/v2/users/me/workspace/ws") {
            workspaceRequests += 1;
            if (workspaceRequests <= 2) {
              if (workspaceRequests === 2) releaseInitialLookups();
              await initialLookupsReady;
            }
            return json(
              workspace({
                latest_build: {
                  id: status === scenario.initialStatus ? "previous-build" : buildId,
                  template_version_id: "version-current",
                  transition,
                  status,
                  job: { status: "succeeded" },
                  resources: [],
                },
              }),
            );
          }
          if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
            buildPosts += 1;
            expect(init?.method).toBe("POST");
            expect(JSON.parse(String(init?.body))).toMatchObject({
              transition: scenario.transition,
            });
            return json(
              { id: buildId, transition: scenario.transition, job: { status: "pending" } },
              { status: 201 },
            );
          }
          if (url.pathname === `/api/v2/workspacebuilds/${buildId}`) {
            status = scenario.finalStatus;
            transition = scenario.transition;
            return json({
              id: buildId,
              transition: scenario.transition,
              job: { status: "succeeded" },
            });
          }
          return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
        },
      });

      await Promise.all([scenario.invoke(client, "ws"), scenario.invoke(client, "me/ws")]);
      expect({ transition: scenario.transition, buildPosts }).toEqual({
        transition: scenario.transition,
        buildPosts: 1,
      });
    }
  });

  it("enforces the build deadline while a status request is stalled", async () => {
    let pollSignal: AbortSignal | null | undefined;
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1,
      buildTimeoutMs: 50,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") return json(workspace());
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          return json(
            { id: "stalled-build", transition: "stop", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/stalled-build") {
          pollSignal = init?.signal;
          return await new Promise<Response>(() => {});
        }
        return json({}, { status: 500 });
      },
    });

    const startedAt = Date.now();
    await expect(client.stop("ws")).rejects.toThrow(
      "timed out after 50ms waiting for Coder build stalled-build",
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(pollSignal?.aborted).toBe(true);
  });

  it("preserves the caller abort reason between build polls", async () => {
    const signal = AbortSignal.timeout(25);
    const client = new CoderApiClient({
      url: "https://coder.example.test",
      token: "secret",
      buildPollIntervalMs: 1_000,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v2/users/me/workspace/ws") return json(workspace());
        if (url.pathname === "/api/v2/workspaces/workspace-id/builds") {
          return json(
            { id: "pending-build", transition: "stop", job: { status: "pending" } },
            { status: 201 },
          );
        }
        if (url.pathname === "/api/v2/workspacebuilds/pending-build") {
          return json({ id: "pending-build", transition: "stop", job: { status: "pending" } });
        }
        return json({ message: "unexpected route", detail: url.pathname }, { status: 500 });
      },
    });

    const error = await client
      .stop("ws", { abortSignal: signal })
      .catch((reason: unknown) => reason);
    expect(signal.aborted).toBe(true);
    expect(error).toBe(signal.reason);
    expect(error).toMatchObject({ name: "TimeoutError" });
  });
});
