import { describe, expect, it } from "vitest";
import {
  getAppsHost,
  getWorkspace,
  resolveWorkspacePreview,
  shareWorkspacePreview,
  upsertPortShare,
  type WorkspaceApiConnection,
  type WorkspaceSummary,
} from "../../src/coder/workspaces.js";
import { CoderAgentError, CoderApiError } from "../../src/errors.js";

type Init = RequestInit & { headers: Record<string, string> };

/** A fake `fetch` that records calls and routes scripted responses by path. */
function fakeFetch(routes: Record<string, (init: Init) => Response>) {
  const calls: { url: string; init: Init }[] = [];
  const fn = ((url: string, init: Init) => {
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (!route) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: `no fake route for ${url}` }), { status: 599 }),
      );
    }
    return Promise.resolve(route(init));
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

function conn(fetchFn: typeof globalThis.fetch, baseUrl = "https://coder.example.com") {
  return { baseUrl, token: "tok", fetch: fetchFn } satisfies WorkspaceApiConnection;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const WORKSPACE: WorkspaceSummary = {
  id: "ws-1",
  owner_name: "alice",
  name: "dev",
  latest_build: { resources: [{ agents: [{ name: "main" }] }] },
};

describe("workspace REST helpers", () => {
  it("getWorkspace GETs /api/v2/workspaces/{id} with the session token", async () => {
    const { fn, calls } = fakeFetch({ "/api/v2/workspaces/ws-1": () => json(WORKSPACE) });
    const ws = await getWorkspace(conn(fn), "ws-1");

    expect(ws.owner_name).toBe("alice");
    expect(ws.name).toBe("dev");
    expect(calls[0]?.url).toBe("https://coder.example.com/api/v2/workspaces/ws-1");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers["Coder-Session-Token"]).toBe("tok");
  });

  it("getAppsHost GETs /api/v2/applications/host and strips a trailing base-URL slash", async () => {
    const { fn, calls } = fakeFetch({
      "/api/v2/applications/host": () => json({ host: "*.apps.example.com" }),
    });
    const res = await getAppsHost(conn(fn, "https://coder.example.com/"));

    expect(res.host).toBe("*.apps.example.com");
    expect(calls[0]?.url).toBe("https://coder.example.com/api/v2/applications/host");
  });

  it("surfaces a non-2xx response as a CoderApiError with the server message", async () => {
    const { fn } = fakeFetch({
      "/api/v2/workspaces/ws-1": () => json({ message: "no workspace here" }, 404),
    });
    await expect(getWorkspace(conn(fn), "ws-1")).rejects.toMatchObject({
      name: "CoderApiError",
      status: 404,
      message: expect.stringContaining("no workspace here"),
    });
  });

  it("upsertPortShare POSTs the exact wire shape and returns the row", async () => {
    const { fn, calls } = fakeFetch({
      "/api/v2/workspaces/ws-1/port-share": () =>
        json({
          workspace_id: "ws-1",
          agent_name: "main",
          port: 3000,
          share_level: "public",
          protocol: "http",
        }),
    });
    const share = await upsertPortShare(conn(fn), "ws-1", {
      agent_name: "main",
      port: 3000,
      share_level: "public",
      protocol: "http",
    });

    expect(share.share_level).toBe("public");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      agent_name: "main",
      port: 3000,
      share_level: "public",
      protocol: "http",
    });
  });

  it("maps a port-share 404 to a hint that the server may predate port sharing", async () => {
    const { fn } = fakeFetch({
      "/api/v2/workspaces/ws-1/port-share": () => json({ message: "not found" }, 404),
    });
    const err = await upsertPortShare(conn(fn), "ws-1", {
      agent_name: "main",
      port: 3000,
      share_level: "authenticated",
      protocol: "http",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CoderApiError);
    expect((err as CoderApiError).status).toBe(404);
    expect((err as CoderApiError).message).toMatch(/predates port sharing/);
  });
});

describe("resolveWorkspacePreview", () => {
  function previewFetch(workspace: unknown = WORKSPACE, host = "*.apps.example.com") {
    return fakeFetch({
      "/api/v2/workspaces/ws-1": () => json(workspace),
      "/api/v2/applications/host": () => json({ host }),
    });
  }

  it("builds {port}--{agent}--{workspace}--{owner} into the wildcard host", async () => {
    const { fn } = previewFetch();
    const { url, agentName } = await resolveWorkspacePreview(conn(fn), {
      workspaceId: "ws-1",
      port: 3000,
    });

    expect(url).toBe("https://3000--main--dev--alice.apps.example.com");
    expect(agentName).toBe("main");
  });

  it("rejects ports below 1000 that subdomain URLs cannot encode", async () => {
    const { fn } = previewFetch();
    // appurl.PortRegex is `^\d{4,5}s?$`: `80--agent--…` would be parsed as an
    // app named "80", so the helper must refuse instead of minting a dead URL.
    for (const port of [80, 443, 999]) {
      await expect(
        resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port }),
      ).rejects.toThrow(/cannot be previewed.*4-5 digit/);
    }
    // 1000 is the smallest encodable port and must still work.
    const { url } = await resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 1000 });
    expect(url).toBe("https://1000--main--dev--alice.apps.example.com");
  });

  it("adds the `s` suffix for an in-workspace https port", async () => {
    const { fn } = previewFetch();
    const { url } = await resolveWorkspacePreview(conn(fn), {
      workspaceId: "ws-1",
      port: 8080,
      protocol: "https",
    });
    expect(url).toBe("https://8080s--main--dev--alice.apps.example.com");
  });

  it("keeps the app host's explicit port and follows the deployment scheme", async () => {
    const { fn } = previewFetch(WORKSPACE, "*.apps.localhost:3000");
    const { url } = await resolveWorkspacePreview(conn(fn, "http://localhost:3000"), {
      workspaceId: "ws-1",
      port: 8080,
    });
    expect(url).toBe("http://8080--main--dev--alice.apps.localhost:3000");
  });

  it("substitutes into suffixed wildcard hosts (e.g. `*--apps.example.com`)", async () => {
    const { fn } = previewFetch(WORKSPACE, "*--apps.coder.example");
    const { url } = await resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 3000 });
    expect(url).toBe("https://3000--main--dev--alice--apps.coder.example");
  });

  it("errors clearly when no wildcard app host is configured", async () => {
    const { fn } = previewFetch(WORKSPACE, "");
    await expect(
      resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 3000 }),
    ).rejects.toThrow(/wildcard app host/);
  });

  it("errors listing the agent names when several agents exist and none is chosen", async () => {
    const multi: WorkspaceSummary = {
      ...WORKSPACE,
      latest_build: { resources: [{ agents: [{ name: "main" }, { name: "gpu" }] }] },
    };
    const { fn } = previewFetch(multi);
    await expect(
      resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 3000 }),
    ).rejects.toThrow(/main, gpu/);
  });

  it("uses an explicit agentName as-is, even with several agents", async () => {
    const multi: WorkspaceSummary = {
      ...WORKSPACE,
      latest_build: {
        resources: [{ agents: [{ name: "main" }] }, { agents: [{ name: "gpu" }] }],
      },
    };
    const { fn } = previewFetch(multi);
    const { url } = await resolveWorkspacePreview(conn(fn), {
      workspaceId: "ws-1",
      port: 3000,
      agentName: "gpu",
    });
    expect(url).toBe("https://3000--gpu--dev--alice.apps.example.com");
  });

  it("errors when the latest build has no agents (resources without an agents key)", async () => {
    const stopped: WorkspaceSummary = {
      ...WORKSPACE,
      latest_build: { resources: [{}] },
    };
    const { fn } = previewFetch(stopped);
    await expect(
      resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 3000 }),
    ).rejects.toThrow(/no agents/);
  });

  it("rejects invalid ports before issuing any request", async () => {
    const { fn, calls } = previewFetch();
    for (const port of [0, -1, 1.5, 70000, Number.NaN]) {
      await expect(
        resolveWorkspacePreview(conn(fn), { workspaceId: "ws-1", port }),
      ).rejects.toThrow(CoderAgentError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("shareWorkspacePreview", () => {
  it("resolves the URL, upserts the share, and returns the confirmed level", async () => {
    const { fn, calls } = fakeFetch({
      "/api/v2/workspaces/ws-1": () => json(WORKSPACE),
      "/api/v2/applications/host": () => json({ host: "*.apps.example.com" }),
      "/api/v2/workspaces/ws-1/port-share": () =>
        json({
          workspace_id: "ws-1",
          agent_name: "main",
          port: 3000,
          share_level: "public",
          protocol: "http",
        }),
    });
    const result = await shareWorkspacePreview(conn(fn), {
      workspaceId: "ws-1",
      port: 3000,
      shareLevel: "public",
    });

    expect(result).toEqual({
      url: "https://3000--main--dev--alice.apps.example.com",
      shareLevel: "public",
    });
    const post = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({
      agent_name: "main",
      port: 3000,
      share_level: "public",
      protocol: "http",
    });
  });

  it("defaults the share level to authenticated", async () => {
    const { fn, calls } = fakeFetch({
      "/api/v2/workspaces/ws-1": () => json(WORKSPACE),
      "/api/v2/applications/host": () => json({ host: "*.apps.example.com" }),
      "/api/v2/workspaces/ws-1/port-share": () =>
        json({
          workspace_id: "ws-1",
          agent_name: "main",
          port: 3000,
          share_level: "authenticated",
          protocol: "http",
        }),
    });
    const result = await shareWorkspacePreview(conn(fn), { workspaceId: "ws-1", port: 3000 });

    expect(result.shareLevel).toBe("authenticated");
    const post = calls.find((c) => c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body)).share_level).toBe("authenticated");
  });

  it("falls back to the requested level when the server responds with an empty body", async () => {
    const { fn } = fakeFetch({
      "/api/v2/workspaces/ws-1": () => json(WORKSPACE),
      "/api/v2/applications/host": () => json({ host: "*.apps.example.com" }),
      "/api/v2/workspaces/ws-1/port-share": () => new Response("", { status: 200 }),
    });
    const result = await shareWorkspacePreview(conn(fn), {
      workspaceId: "ws-1",
      port: 3000,
      shareLevel: "organization",
    });
    expect(result.shareLevel).toBe("organization");
  });
});
