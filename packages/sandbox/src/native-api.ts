import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import type {
  CreateWorkspaceOptions,
  LifecycleOptions,
  ListPresetsOptions,
  PresetInfo,
  WorkspaceAgentInfo,
  WorkspaceStatus,
} from "./transport.js";

export interface CoderApiClientOptions {
  url: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  buildPollIntervalMs?: number;
  buildTimeoutMs?: number;
}

export interface ParsedWorkspaceRef {
  owner: string;
  name: string;
  agent?: string;
}

export interface ApiWorkspaceAgent {
  id: string;
  name: string;
  status: string;
  lifecycle_state: string;
}

export interface ApiWorkspace {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  template_active_version_id?: string;
  template_require_active_version?: boolean;
  automatic_updates?: string;
  dormant_at?: string | null;
  latest_build: ApiWorkspaceBuild;
}

interface ApiWorkspaceBuild {
  id: string;
  template_version_id?: string;
  transition: string;
  status: string;
  job?: ApiProvisionerJob;
  resources?: { agents?: ApiWorkspaceAgent[] }[];
}

interface ApiProvisionerJob {
  status?: string;
  error?: string;
  error_code?: string;
}

interface ApiTemplate {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  active_version_id: string;
  use_classic_parameter_flow?: boolean;
}

interface ApiTemplateVersion {
  id: string;
  name: string;
}

interface ApiPreset {
  ID?: string;
  Name?: string;
  Default?: boolean;
  Description?: string;
  Parameters?: { Name?: string; Value?: string; name?: string; value?: string }[];
  id?: string;
  name?: string;
  default?: boolean;
  description?: string;
  parameters?: { Name?: string; Value?: string; name?: string; value?: string }[];
}

interface ApiTemplateVersionParameter {
  name: string;
  display_name?: string;
  default_value: string;
  default_valid?: boolean;
  required: boolean;
  ephemeral: boolean;
}

interface ApiDynamicTemplateVersionParameter {
  name: string;
  display_name?: string;
  default_value?: { value?: string; valid?: boolean };
  required?: boolean;
  ephemeral?: boolean;
}

interface ApiDynamicParametersResponse {
  parameters?: ApiDynamicTemplateVersionParameter[];
}

interface ApiUser {
  id: string;
}

interface ApiErrorBody {
  message?: string;
  detail?: string;
  validations?: { field?: string; detail?: string }[];
}

const DEFAULT_BUILD_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const MAX_API_REDIRECTS = 10;

/** Error returned for a non-success response from Coderd's v2 API. */
export class CoderNativeApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly detail?: string;

  constructor(options: {
    status: number;
    method: string;
    path: string;
    message: string;
    detail?: string;
  }) {
    super(
      `Coder API ${options.method} ${options.path} failed (${options.status}): ${options.message}` +
        (options.detail ? `: ${options.detail}` : ""),
    );
    this.name = "CoderNativeApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.detail = options.detail;
  }
}

/** Parse `[owner/]workspace[.agent]` without losing the optional agent selector. */
export function parseNativeWorkspaceRef(ref: string): ParsedWorkspaceRef {
  const parts = ref.split("/");
  if (parts.length > 2 || parts.some((part) => part === "")) {
    throw new Error(`invalid workspace reference "${ref}"; expected [owner/]name[.agent]`);
  }
  const [first = "", second] = parts;
  const owner = parts.length === 2 ? first : "me";
  const nameAndAgent = second ?? first;
  const dot = nameAndAgent.indexOf(".");
  const name = dot === -1 ? nameAndAgent : nameAndAgent.slice(0, dot);
  const agent = dot === -1 ? undefined : nameAndAgent.slice(dot + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || agent === "") {
    throw new Error(`invalid workspace reference "${ref}"; expected [owner/]name[.agent]`);
  }
  if (agent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agent)) {
    throw new Error(`invalid workspace reference "${ref}"; expected [owner/]name[.agent]`);
  }
  return { owner, name, ...(agent === undefined ? {} : { agent }) };
}

export class CoderApiClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #buildPollIntervalMs: number;
  readonly #buildTimeoutMs: number;
  readonly #lifecycleTails = new Map<string, Promise<void>>();

  constructor(options: CoderApiClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Coder URL must use http or https, got ${parsed.protocol}`);
    }
    if (options.token === "") throw new Error("Coder session token must not be empty");
    this.baseUrl = options.url.replace(/\/$/, "");
    this.token = options.token;
    this.headers = { ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#buildPollIntervalMs = options.buildPollIntervalMs ?? DEFAULT_BUILD_POLL_INTERVAL_MS;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  }

  websocketUrl(path: string): string {
    const url = this.#url(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  websocketHeaders(): Record<string, string> {
    return { ...this.headers, "Coder-Session-Token": this.token };
  }

  async workspace(ref: string, signal?: AbortSignal): Promise<ApiWorkspace | null> {
    const { owner, name } = parseNativeWorkspaceRef(ref);
    try {
      return await this.request<ApiWorkspace>(
        "GET",
        `/api/v2/users/${encodeURIComponent(owner)}/workspace/${encodeURIComponent(name)}`,
        undefined,
        signal,
      );
    } catch (error) {
      if (error instanceof CoderNativeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async currentUserId(signal?: AbortSignal): Promise<string> {
    const user = await this.request<ApiUser>("GET", "/api/v2/users/me", undefined, signal);
    return user.id;
  }

  async requireWorkspace(ref: string, signal?: AbortSignal): Promise<ApiWorkspace> {
    const workspace = await this.workspace(ref, signal);
    if (workspace === null) throw new Error(`Coder workspace "${ref}" does not exist`);
    return workspace;
  }

  async resolveAgent(
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ workspace: ApiWorkspace; agent: ApiWorkspaceAgent }> {
    const parsed = parseNativeWorkspaceRef(ref);
    const workspace = await this.requireWorkspace(ref, signal);
    const agents =
      workspace.latest_build.resources?.flatMap((resource) => resource.agents ?? []) ?? [];
    const agent =
      parsed.agent === undefined
        ? agents.length === 1
          ? agents[0]
          : undefined
        : agents.find((candidate) => candidate.name === parsed.agent);
    if (agent !== undefined) return { workspace, agent };
    if (agents.length === 0) {
      throw new Error(`Coder workspace "${ref}" has no agents in its latest build`);
    }
    if (parsed.agent !== undefined) {
      throw new Error(
        `Coder workspace "${parsed.owner}/${parsed.name}" has no agent "${parsed.agent}"; ` +
          `available agents: ${agents.map((candidate) => candidate.name).join(", ")}`,
      );
    }
    throw new Error(
      `Coder workspace "${ref}" has multiple agents (${agents
        .map((candidate) => candidate.name)
        .join(", ")}); select one with workspace.agent`,
    );
  }

  async status(ref: string, options?: LifecycleOptions): Promise<WorkspaceStatus | null> {
    const workspace = await this.workspace(ref, options?.abortSignal);
    return workspace === null ? null : toWorkspaceStatus(workspace);
  }

  async start(ref: string, options?: LifecycleOptions): Promise<void> {
    const signal = options?.abortSignal;
    const initial = await this.requireWorkspace(ref, signal);
    await this.#withLifecycleLock(initial.id, signal, async () => {
      let workspace = await this.requireWorkspace(ref, signal);
      for (;;) {
        if (workspace.latest_build.status === "running") return;
        if (isWorkspaceBuildInFlight(workspace.latest_build)) {
          const transition = workspace.latest_build.transition;
          const completed = await this.#waitForBuild(workspace.latest_build.id, signal, true);
          if (transition === "start" && completed.job?.status === "succeeded") return;
          workspace = await this.requireWorkspace(ref, signal);
          continue;
        }
        if (
          workspace.latest_build.status === "failed" &&
          workspace.latest_build.transition === "start"
        ) {
          const cleanup = await this.#createBuild(workspace.id, { transition: "stop" }, signal);
          await this.#waitForBuild(cleanup.id, signal);
          workspace = await this.requireWorkspace(ref, signal);
          continue;
        }
        if (workspace.dormant_at) {
          await this.request(
            "PUT",
            `/api/v2/workspaces/${workspace.id}/dormant`,
            { dormant: false },
            signal,
          );
        }
        const templateVersionId =
          workspace.automatic_updates === "always" || workspace.template_require_active_version
            ? workspace.template_active_version_id
            : workspace.latest_build.template_version_id;
        const build = await this.#createBuild(
          workspace.id,
          {
            transition: "start",
            ...(templateVersionId ? { template_version_id: templateVersionId } : {}),
          },
          signal,
        );
        await this.#waitForBuild(build.id, signal);
        return;
      }
    });
  }

  async stop(ref: string, options?: LifecycleOptions): Promise<void> {
    const signal = options?.abortSignal;
    const initial = await this.requireWorkspace(ref, signal);
    await this.#withLifecycleLock(initial.id, signal, async () => {
      let workspace = await this.requireWorkspace(ref, signal);
      for (;;) {
        if (workspace.latest_build.status === "stopped") return;
        if (isWorkspaceBuildInFlight(workspace.latest_build)) {
          const transition = workspace.latest_build.transition;
          const completed = await this.#waitForBuild(workspace.latest_build.id, signal, true);
          if (transition === "stop" && completed.job?.status === "succeeded") return;
          workspace = await this.requireWorkspace(ref, signal);
          continue;
        }
        const build = await this.#createBuild(workspace.id, { transition: "stop" }, signal);
        await this.#waitForBuild(build.id, signal);
        return;
      }
    });
  }

  async destroy(ref: string, options?: LifecycleOptions): Promise<void> {
    const signal = options?.abortSignal;
    const initial = await this.workspace(ref, signal);
    if (initial === null) return;
    await this.#withLifecycleLock(initial.id, signal, async () => {
      let workspace = await this.workspace(ref, signal);
      for (;;) {
        if (workspace === null || workspace.latest_build.status === "deleted") return;
        if (isWorkspaceBuildInFlight(workspace.latest_build)) {
          const transition = workspace.latest_build.transition;
          const completed = await this.#waitForBuild(workspace.latest_build.id, signal, true);
          if (transition === "delete" && completed.job?.status === "succeeded") return;
          workspace = await this.workspace(ref, signal);
          continue;
        }
        const build = await this.#createBuild(workspace.id, { transition: "delete" }, signal);
        await this.#waitForBuild(build.id, signal);
        return;
      }
    });
  }

  async create(options: CreateWorkspaceOptions): Promise<void> {
    const ref = parseNativeWorkspaceRef(options.workspace);
    if (ref.agent !== undefined) {
      throw new Error("a workspace agent cannot be selected while creating a workspace");
    }
    const template = await this.#resolveTemplate(
      options.template,
      options.org,
      options.abortSignal,
    );
    const versionId = options.templateVersion
      ? (
          await this.request<ApiTemplateVersion>(
            "GET",
            `/api/v2/templates/${template.id}/versions/${encodeURIComponent(options.templateVersion)}`,
            undefined,
            options.abortSignal,
          )
        ).id
      : template.active_version_id;
    const noPreset = options.preset?.toLowerCase() === "none";
    const presets = noPreset ? [] : await this.#presets(versionId, options.abortSignal);
    const preset =
      options.preset === undefined
        ? presets.find(presetDefault)
        : presets.find((candidate) => presetName(candidate) === options.preset);
    if (options.preset !== undefined && !noPreset && preset === undefined) {
      throw new Error(
        `preset "${options.preset}" not found for template "${options.template}"; ` +
          `available presets: ${presets.map(presetName).join(", ") || "none"}`,
      );
    }
    const fileParameters = options.parameterFile
      ? await readParameterFile(options.parameterFile)
      : {};
    const parameterValues = {
      ...fileParameters,
      ...options.parameters,
      ...options.ephemeralParameters,
      ...(preset ? presetParameterValues(preset) : {}),
    };
    const templateParameters = await this.#templateParameters(
      template,
      versionId,
      ref.owner,
      parameterValues,
      options.abortSignal,
    );
    const resolvedParameterValues = resolveCreateParameterValues(
      templateParameters,
      parameterValues,
      options.useParameterDefaults === true,
    );
    const body = {
      template_version_id: versionId,
      name: ref.name,
      ...(options.stopAfter ? { ttl_ms: parseDurationMillis(options.stopAfter) } : {}),
      ...(Object.keys(resolvedParameterValues).length > 0
        ? {
            rich_parameter_values: Object.entries(resolvedParameterValues).map(([name, value]) => ({
              name,
              value,
            })),
          }
        : {}),
      ...(options.automaticUpdates ? { automatic_updates: options.automaticUpdates } : {}),
      ...(preset ? { template_version_preset_id: presetId(preset) } : {}),
    };
    const workspace = await this.request<ApiWorkspace>(
      "POST",
      `/api/v2/users/${encodeURIComponent(ref.owner)}/workspaces`,
      body,
      options.abortSignal,
    );
    await this.#waitForBuild(workspace.latest_build.id, options.abortSignal);
  }

  async listPresets(options: ListPresetsOptions): Promise<PresetInfo[]> {
    const template = await this.#resolveTemplate(
      options.template,
      options.org,
      options.abortSignal,
    );
    const versionId = options.templateVersion
      ? (
          await this.request<ApiTemplateVersion>(
            "GET",
            `/api/v2/templates/${template.id}/versions/${encodeURIComponent(options.templateVersion)}`,
            undefined,
            options.abortSignal,
          )
        ).id
      : template.active_version_id;
    const presets = await this.#presets(versionId, options.abortSignal);
    return presets.map((preset) => {
      const description = preset.Description ?? preset.description;
      return {
        name: presetName(preset),
        default: preset.Default ?? preset.default ?? false,
        ...(description ? { description } : {}),
      };
    });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const requestHeaders: Record<string, string> = {
      ...this.headers,
      "Coder-Session-Token": this.token,
      Accept: "application/json",
    };
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    const initialUrl = this.#url(path);
    let requestUrl = initialUrl;
    let requestMethod = method.toUpperCase();
    let requestBody = body === undefined ? undefined : JSON.stringify(body);
    let redirectCount = 0;
    let response: Response;
    for (;;) {
      response = await waitWithAbort(
        this.#fetch(requestUrl, {
          method: requestMethod,
          headers: requestHeaders,
          body: requestBody,
          signal,
          redirect: "manual",
        }),
        signal,
      );
      const location = response.headers.get("location");
      if (!isRedirectStatus(response.status) || location === null) break;
      redirectCount += 1;
      if (redirectCount > MAX_API_REDIRECTS) {
        await response.body?.cancel();
        throw new Error(
          `Coder API ${method} ${path} exceeded ${MAX_API_REDIRECTS} same-origin redirects`,
        );
      }
      const redirectedUrl = new URL(location, requestUrl);
      if (redirectedUrl.origin !== initialUrl.origin) {
        await response.body?.cancel();
        throw new Error(
          `Coder API ${method} ${path} refused cross-origin redirect from ${initialUrl.origin} to ${redirectedUrl.origin}`,
        );
      }
      await response.body?.cancel();
      if (
        (response.status === 303 && requestMethod !== "GET" && requestMethod !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && requestMethod === "POST")
      ) {
        requestMethod = "GET";
        requestBody = undefined;
        deleteRequestBodyHeaders(requestHeaders);
      }
      requestUrl = redirectedUrl;
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = asRecord(parsed) as ApiErrorBody;
      const validations = error.validations
        ?.map((validation) => [validation.field, validation.detail].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ");
      throw new CoderNativeApiError({
        status: response.status,
        method,
        path,
        message: error.message ?? (response.statusText || "request failed"),
        detail:
          [error.detail, validations, parsed === undefined ? text.slice(0, 500) : undefined]
            .filter(Boolean)
            .join("; ") || undefined,
      });
    }
    return parsed as T;
  }

  #url(path: string): URL {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(path.replace(/^\//, ""), base);
  }

  async #createBuild(
    workspaceId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ApiWorkspaceBuild> {
    return await this.request<ApiWorkspaceBuild>(
      "POST",
      `/api/v2/workspaces/${workspaceId}/builds`,
      body,
      signal,
    );
  }

  async #withLifecycleLock<T>(
    workspaceId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#lifecycleTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#lifecycleTails.set(workspaceId, tail);
    void tail.then(() => {
      if (this.#lifecycleTails.get(workspaceId) === tail) {
        this.#lifecycleTails.delete(workspaceId);
      }
    });
    try {
      await waitWithAbort(previous, signal);
      return await operation();
    } finally {
      release();
    }
  }

  async #waitForBuild(
    buildId: string,
    signal?: AbortSignal,
    allowCanceled = false,
  ): Promise<ApiWorkspaceBuild> {
    if (signal?.aborted) throw abortReason(signal);
    const deadline = Date.now() + this.#buildTimeoutMs;
    const timeoutError = () =>
      new Error(`timed out after ${this.#buildTimeoutMs}ms waiting for Coder build ${buildId}`);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      const controller = new AbortController();
      let rejectInterrupted!: (error: Error) => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        rejectInterrupted = reject;
      });
      const onAbort = () => {
        const error = abortReason(signal);
        rejectInterrupted(error);
        controller.abort(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        const error = timeoutError();
        rejectInterrupted(error);
        controller.abort(error);
      }, remaining);
      let build: ApiWorkspaceBuild;
      try {
        build = await Promise.race([
          this.request<ApiWorkspaceBuild>(
            "GET",
            `/api/v2/workspacebuilds/${buildId}`,
            undefined,
            controller.signal,
          ),
          interrupted,
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      const jobStatus = build.job?.status;
      if (jobStatus === "succeeded") return build;
      if (jobStatus === "canceled" && allowCanceled) return build;
      if (jobStatus === "failed" || jobStatus === "canceled") {
        throw new Error(
          `Coder workspace ${build.transition} build ${buildId} ${jobStatus}` +
            (build.job?.error ? `: ${build.job.error}` : "") +
            (build.job?.error_code ? ` (${build.job.error_code})` : ""),
        );
      }
      const wait = Math.min(this.#buildPollIntervalMs, Math.max(0, deadline - Date.now()));
      if (wait <= 0) throw timeoutError();
      try {
        await delay(wait, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        throw error;
      }
    }
  }

  async #resolveTemplate(
    name: string,
    org: string | undefined,
    signal?: AbortSignal,
  ): Promise<ApiTemplate> {
    const query = new URLSearchParams({ q: `exact_name:"${name}"` });
    const templates = await this.request<ApiTemplate[]>(
      "GET",
      `/api/v2/templates?${query.toString()}`,
      undefined,
      signal,
    );
    const matches = templates.filter(
      (template) =>
        template.name === name &&
        (org === undefined ||
          template.organization_id === org ||
          template.organization_name === org),
    );
    const [onlyMatch] = matches;
    if (matches.length === 1 && onlyMatch !== undefined) return onlyMatch;
    if (matches.length === 0) {
      throw new Error(
        `Coder template "${name}"${org ? ` in organization "${org}"` : ""} was not found`,
      );
    }
    throw new Error(
      `Coder template "${name}" is ambiguous across organizations (${matches
        .map((template) => template.organization_name)
        .join(", ")}); set org`,
    );
  }

  async #presets(versionId: string, signal?: AbortSignal): Promise<ApiPreset[]> {
    const presets = await this.request<ApiPreset[] | null>(
      "GET",
      `/api/v2/templateversions/${versionId}/presets`,
      undefined,
      signal,
    );
    return Array.isArray(presets) ? presets : [];
  }

  async #templateParameters(
    template: ApiTemplate,
    versionId: string,
    owner: string,
    initialValues: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ApiTemplateVersionParameter[]> {
    if (template.use_classic_parameter_flow !== false) {
      const parameters = await this.request<ApiTemplateVersionParameter[]>(
        "GET",
        `/api/v2/templateversions/${versionId}/rich-parameters`,
        undefined,
        signal,
      );
      return Array.isArray(parameters) ? parameters : [];
    }
    const ownerId =
      owner === "me"
        ? undefined
        : (
            await this.request<ApiUser>(
              "GET",
              `/api/v2/users/${encodeURIComponent(owner)}`,
              undefined,
              signal,
            )
          ).id;
    const evaluation = await this.request<ApiDynamicParametersResponse>(
      "POST",
      `/api/v2/templateversions/${versionId}/dynamic-parameters/evaluate`,
      {
        id: 0,
        inputs: initialValues,
        ...(ownerId ? { owner_id: ownerId } : {}),
      },
      signal,
    );
    return (evaluation.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      ...(parameter.display_name ? { display_name: parameter.display_name } : {}),
      default_value: parameter.default_value?.value ?? "",
      ...(parameter.default_value?.valid === undefined
        ? {}
        : { default_valid: parameter.default_value.valid }),
      required: parameter.required ?? false,
      ephemeral: parameter.ephemeral ?? false,
    }));
  }
}

function toWorkspaceStatus(workspace: ApiWorkspace): WorkspaceStatus {
  const agents: WorkspaceAgentInfo[] =
    workspace.latest_build.resources?.flatMap((resource) =>
      (resource.agents ?? []).map((agent) => ({
        name: agent.name,
        status: agent.status,
        lifecycleState: agent.lifecycle_state,
      })),
    ) ?? [];
  return {
    id: workspace.id,
    name: workspace.name,
    buildStatus: workspace.latest_build.status,
    transition: workspace.latest_build.transition,
    agents,
  };
}

function presetName(preset: ApiPreset): string {
  return preset.Name ?? preset.name ?? "";
}

function presetId(preset: ApiPreset): string {
  const id = preset.ID ?? preset.id;
  if (!id) throw new Error(`Coder preset "${presetName(preset)}" has no id`);
  return id;
}

function presetDefault(preset: ApiPreset): boolean {
  return preset.Default ?? preset.default ?? false;
}

function presetParameterValues(preset: ApiPreset): Record<string, string> {
  const result: Record<string, string> = {};
  for (const parameter of preset.Parameters ?? preset.parameters ?? []) {
    const name = parameter.Name ?? parameter.name;
    const value = parameter.Value ?? parameter.value;
    if (name !== undefined && value !== undefined) result[name] = value;
  }
  return result;
}

function resolveCreateParameterValues(
  parameters: ApiTemplateVersionParameter[],
  supplied: Record<string, string>,
  useDefaults: boolean,
): Record<string, string> {
  const resolved = { ...supplied };
  const required: string[] = [];
  const awaitingDefaults: string[] = [];
  for (const parameter of parameters) {
    if (Object.hasOwn(resolved, parameter.name)) continue;
    if (parameter.ephemeral && !parameter.required) continue;
    const name = parameter.display_name || parameter.name;
    if (parameter.required) {
      required.push(name);
    } else if (useDefaults && parameter.default_valid !== false) {
      resolved[parameter.name] = parameter.default_value;
    } else {
      awaitingDefaults.push(name);
    }
  }
  if (required.length > 0) {
    const names = required.map((name) => `"${name}"`).join(", ");
    throw new Error(
      `required Coder workspace parameters have no defaults: ${names}; ` +
        "supply values with parameters, parameterFile, or a preset",
    );
  }
  if (awaitingDefaults.length > 0) {
    const names = awaitingDefaults.map((name) => `"${name}"`).join(", ");
    throw new Error(
      `Coder workspace parameters require explicit values: ${names}; ` +
        "supply values with parameters, parameterFile, or a preset" +
        (useDefaults ? "" : ", or set useParameterDefaults: true"),
    );
  }
  return resolved;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isWorkspaceBuildInFlight(build: ApiWorkspaceBuild): boolean {
  return (
    build.status === "pending" ||
    build.status === "starting" ||
    build.status === "stopping" ||
    build.status === "deleting" ||
    build.status === "canceling"
  );
}

function deleteRequestBodyHeaders(headers: Record<string, string>): void {
  const bodyHeaders = new Set([
    "content-encoding",
    "content-language",
    "content-location",
    "content-type",
  ]);
  for (const name of Object.keys(headers)) {
    if (bodyHeaders.has(name.toLowerCase())) delete headers[name];
  }
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw abortReason(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readParameterFile(path: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse Coder parameter file "${path}"`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Coder parameter file "${path}" must contain a YAML mapping`);
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      result[name] = String(value);
    } else if (Array.isArray(value)) {
      result[name] = JSON.stringify(value);
    } else {
      throw new Error(
        `invalid value for Coder parameter "${name}" in "${path}": expected string, number, boolean, or list`,
      );
    }
  }
  return result;
}

/** Parse a Go-style duration subset used by `coder create --stop-after`. */
export function parseDurationMillis(input: string): number {
  const unitMillis: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let offset = 0;
  for (;;) {
    pattern.lastIndex = offset;
    const match = pattern.exec(input);
    if (match === null) break;
    const amount = match[1];
    const multiplier = match[2] === undefined ? undefined : unitMillis[match[2]];
    if (amount === undefined || multiplier === undefined) break;
    total += Number(amount) * multiplier;
    offset = pattern.lastIndex;
  }
  if (offset !== input.length || offset === 0 || !Number.isFinite(total) || total < 0) {
    throw new Error(
      `invalid stopAfter duration "${input}"; expected a Go-style duration such as "8h" or "1h30m"`,
    );
  }
  return Math.round(total);
}
