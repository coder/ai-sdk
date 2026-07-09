/**
 * Minimal helpers for the stable Coder v2 REST endpoints that the workspace
 * preview feature composes: workspace lookup, the wildcard app host, and port
 * sharing. Deliberately tiny — only the fields this package reads are modeled
 * — and mirroring `CoderChatClient`'s conventions (`Coder-Session-Token`
 * auth, `CoderApiError` on non-2xx). These are internal building blocks for
 * `CoderAgent.getPreview`/`sharePreview`; only their option/result types are
 * part of the public API.
 */

import { CoderAgentError, CoderApiError } from "../errors.js";

/** Connection details for the stable v2 API (same credentials as the chat client). */
export interface WorkspaceApiConnection {
  /** Base URL of the Coder deployment, e.g. `https://dev.coder.com`. */
  baseUrl: string;
  /** Coder API/session token (sent as `Coder-Session-Token`). */
  token: string;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Subset of `codersdk.Workspace` (GET `/api/v2/workspaces/{workspace}`) that
 * the preview helpers read. Resources without agents omit the `agents` key
 * entirely, so the whole chain is treated as optional.
 */
export interface WorkspaceSummary {
  id: string;
  /** Username of the workspace owner (a subdomain URL segment). */
  owner_name: string;
  name: string;
  latest_build?: {
    resources?: { agents?: { name: string }[] }[];
  };
}

/** Response of GET `/api/v2/applications/host`; `host` is `""` when subdomain apps are disabled. */
export interface AppHostResponse {
  /** Wildcard app host with a literal `*`, e.g. `*.apps.example.com`, possibly with a port. */
  host: string;
}

/** Share levels a port can be in; `owner` is the implicit default when no share exists. */
export type PortShareLevel = "owner" | "authenticated" | "organization" | "public";

/**
 * Share levels the upsert endpoint accepts. `owner` is rejected server-side —
 * reverting to owner-only is done by deleting the share, not setting it.
 */
export type PreviewShareLevel = Exclude<PortShareLevel, "owner">;

/** Protocol the workspace app speaks on the port (drives the `s` suffix in the URL). */
export type PortShareProtocol = "http" | "https";

/** Body of POST `/api/v2/workspaces/{workspace}/port-share` (a true upsert on agent+port). */
export interface UpsertPortShareRequest {
  agent_name: string;
  port: number;
  share_level: PreviewShareLevel;
  protocol: PortShareProtocol;
}

/** A port-share row, mirroring `codersdk.WorkspaceAgentPortShare`. */
export interface WorkspaceAgentPortShare {
  workspace_id: string;
  agent_name: string;
  port: number;
  share_level: PortShareLevel;
  protocol: PortShareProtocol;
}

/**
 * Issue a JSON request against the v2 API. Mirrors `CoderChatClient`: the
 * session-token header, and a {@link CoderApiError} carrying the server's
 * `message`/`detail` on any non-2xx (body tolerated missing or malformed).
 */
async function request<T>(
  conn: WorkspaceApiConnection,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const fetchFn = conn.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { "Coder-Session-Token": conn.token };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetchFn(`${conn.baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const errObj = (parsed ?? {}) as { message?: string; detail?: string };
    throw new CoderApiError({
      status: res.status,
      method,
      path,
      message: errObj.message ?? res.statusText ?? "request failed",
      detail: errObj.detail,
    });
  }
  return parsed as T;
}

/** Fetch a workspace (owner, name, agents) by UUID: GET `/api/v2/workspaces/{workspace}`. */
export function getWorkspace(
  conn: WorkspaceApiConnection,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceSummary> {
  return request<WorkspaceSummary>(
    conn,
    "GET",
    `/api/v2/workspaces/${workspaceId}`,
    undefined,
    signal,
  );
}

/**
 * Fetch the deployment's wildcard app host: GET `/api/v2/applications/host`.
 * The endpoint predates port sharing and exists on all supported servers;
 * an empty `host` means no wildcard access URL is configured.
 */
export function getAppsHost(
  conn: WorkspaceApiConnection,
  signal?: AbortSignal,
): Promise<AppHostResponse> {
  return request<AppHostResponse>(conn, "GET", "/api/v2/applications/host", undefined, signal);
}

/**
 * Create or update a port share: POST `/api/v2/workspaces/{workspace}/port-share`
 * (an upsert keyed on agent+port; re-posting updates level/protocol in place).
 * A 404 is rethrown with a hint that the server may predate port sharing —
 * the whole route is absent on Coder servers older than ~v2.9.
 */
export async function upsertPortShare(
  conn: WorkspaceApiConnection,
  workspaceId: string,
  req: UpsertPortShareRequest,
  signal?: AbortSignal,
): Promise<WorkspaceAgentPortShare> {
  const path = `/api/v2/workspaces/${workspaceId}/port-share`;
  try {
    return await request<WorkspaceAgentPortShare>(conn, "POST", path, req, signal);
  } catch (err) {
    if (err instanceof CoderApiError && err.status === 404) {
      throw new CoderApiError({
        status: 404,
        method: "POST",
        path,
        message: "port sharing is unavailable",
        detail:
          "the workspace was not found, or this Coder server predates port sharing (added in Coder v2.9)",
      });
    }
    throw err;
  }
}

/** Inputs for building a preview URL (see `CoderAgent.getPreview`). */
export interface ResolvePreviewOptions {
  workspaceId: string;
  /** Workspace port the app listens on. */
  port: number;
  /** Agent that serves the port; defaults to the workspace's only agent. */
  agentName?: string;
  /** Protocol the app speaks inside the workspace (not the browser scheme). Default `"http"`. */
  protocol?: PortShareProtocol;
}

/** The workspace's only agent's name, or a clear error naming the candidates. */
function defaultAgentName(workspace: WorkspaceSummary): string {
  const agents = (workspace.latest_build?.resources ?? []).flatMap((r) => r.agents ?? []);
  const first = agents[0];
  if (agents.length === 1 && first) return first.name;
  if (agents.length === 0) {
    throw new CoderAgentError(
      `Workspace "${workspace.name}" has no agents in its latest build (is it running?); ` +
        `pass agentName explicitly.`,
    );
  }
  throw new CoderAgentError(
    `Workspace "${workspace.name}" has ${agents.length} agents ` +
      `(${agents.map((a) => a.name).join(", ")}); pass agentName to pick one.`,
  );
}

/** Ports must be integral and in TCP range (the share endpoint additionally floors at 9). */
function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CoderAgentError(`Invalid port ${port}: expected an integer between 1 and 65535.`);
  }
}

/**
 * Compose the subdomain preview URL for a workspace port the same way the
 * dashboard does: the label `{port}{s?}--{agent}--{workspace}--{owner}`
 * replaces the `*` in the deployment's wildcard app host, and the browser
 * scheme follows the deployment's own access URL. The trailing `s` (from
 * `protocol: "https"`) tells the proxy to speak TLS *to the workspace port*;
 * it does not affect the browser scheme.
 */
export async function resolveWorkspacePreview(
  conn: WorkspaceApiConnection,
  opts: ResolvePreviewOptions,
  signal?: AbortSignal,
): Promise<{ url: string; agentName: string }> {
  assertValidPort(opts.port);
  const [workspace, appHost] = await Promise.all([
    getWorkspace(conn, opts.workspaceId, signal),
    getAppsHost(conn, signal),
  ]);
  if (!appHost.host) {
    throw new CoderAgentError(
      "This Coder deployment has no wildcard app host configured (--wildcard-access-url), " +
        "so subdomain preview URLs are unavailable.",
    );
  }
  const agentName = opts.agentName ?? defaultAgentName(workspace);
  const suffix = opts.protocol === "https" ? "s" : "";
  const label = `${opts.port}${suffix}--${agentName}--${workspace.name}--${workspace.owner_name}`;
  // The host keeps a literal `*` (possibly inside the first label, e.g.
  // `*--apps.example.com`) and may carry an explicit port on dev deployments —
  // substitute the label into the whole host string, dashboard-style.
  const scheme = new URL(conn.baseUrl).protocol;
  return { url: `${scheme}//${appHost.host.replace(/\*/g, label)}`, agentName };
}

/** Inputs for sharing and previewing a workspace port (see `CoderAgent.sharePreview`). */
export interface SharePreviewRequest extends ResolvePreviewOptions {
  /** Who may open the port. Default `"authenticated"`. */
  shareLevel?: PreviewShareLevel;
}

/**
 * Resolve a port's preview URL, then upsert its share level so the URL is
 * reachable beyond the workspace owner. Returns the server-confirmed level
 * (falling back to the requested one when the server omits it).
 */
export async function shareWorkspacePreview(
  conn: WorkspaceApiConnection,
  opts: SharePreviewRequest,
  signal?: AbortSignal,
): Promise<{ url: string; shareLevel: PreviewShareLevel }> {
  const requested = opts.shareLevel ?? "authenticated";
  const { url, agentName } = await resolveWorkspacePreview(conn, opts, signal);
  const share = await upsertPortShare(
    conn,
    opts.workspaceId,
    {
      agent_name: agentName,
      port: opts.port,
      share_level: requested,
      protocol: opts.protocol ?? "http",
    },
    signal,
  );
  // Old servers may answer with an empty/partial body; trust it when present.
  const level = share?.share_level && share.share_level !== "owner" ? share.share_level : requested;
  return { url, shareLevel: level };
}
