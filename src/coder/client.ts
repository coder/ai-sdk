import { CoderApiError } from "../errors.js";
import {
  type Chat,
  type ChatMessagesResponse,
  type ChatModelConfig,
  type ChatStreamEvent,
  type CreateChatMessageRequest,
  type CreateChatMessageResponse,
  type CreateChatRequest,
  type SubmitToolResultsRequest,
  type UpdateChatRequest,
} from "./types.js";
import { streamChatEvents, type WebSocketFactory } from "./ws.js";

export interface CoderChatClientOptions {
  /** Base URL of the Coder deployment, e.g. `https://dev.coder.com`. */
  baseUrl: string;
  /** Coder API token or session token (sent as `Coder-Session-Token`). */
  token: string;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Custom WebSocket factory (defaults to the `ws` package on Node). */
  webSocketFactory?: WebSocketFactory;
}

const API_PREFIX = "/api/experimental/chats";

/**
 * A thin, typed client for Coder's experimental `chatd` API. This is a
 * TypeScript port of the chat surface of `codersdk.ExperimentalClient`.
 */
export class CoderChatClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #webSocketFactory: WebSocketFactory | undefined;

  constructor(options: CoderChatClientOptions) {
    // Normalize: strip a single trailing slash.
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocketFactory = options.webSocketFactory;
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { "Coder-Session-Token": this.#token };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.#fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

    const text = await res.text();
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

  // --- REST -----------------------------------------------------------------

  listModelConfigs(signal?: AbortSignal): Promise<ChatModelConfig[]> {
    return this.#request<ChatModelConfig[]>(
      "GET",
      `${API_PREFIX}/model-configs`,
      undefined,
      signal,
    );
  }

  createChat(req: CreateChatRequest, signal?: AbortSignal): Promise<Chat> {
    return this.#request<Chat>("POST", API_PREFIX, req, signal);
  }

  getChat(chatId: string, signal?: AbortSignal): Promise<Chat> {
    return this.#request<Chat>("GET", `${API_PREFIX}/${chatId}`, undefined, signal);
  }

  createChatMessage(
    chatId: string,
    req: CreateChatMessageRequest,
    signal?: AbortSignal,
  ): Promise<CreateChatMessageResponse> {
    return this.#request<CreateChatMessageResponse>(
      "POST",
      `${API_PREFIX}/${chatId}/messages`,
      req,
      signal,
    );
  }

  getMessages(
    chatId: string,
    opts?: { before_id?: number; after_id?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<ChatMessagesResponse> {
    const params = new URLSearchParams();
    if (opts?.before_id !== undefined) params.set("before_id", String(opts.before_id));
    if (opts?.after_id !== undefined) params.set("after_id", String(opts.after_id));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const q = params.toString();
    return this.#request<ChatMessagesResponse>(
      "GET",
      `${API_PREFIX}/${chatId}/messages${q ? `?${q}` : ""}`,
      undefined,
      signal,
    );
  }

  submitToolResults(
    chatId: string,
    req: SubmitToolResultsRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>("POST", `${API_PREFIX}/${chatId}/tool-results`, req, signal);
  }

  interruptChat(chatId: string, signal?: AbortSignal): Promise<Chat> {
    return this.#request<Chat>("POST", `${API_PREFIX}/${chatId}/interrupt`, undefined, signal);
  }

  updateChat(chatId: string, req: UpdateChatRequest, signal?: AbortSignal): Promise<void> {
    return this.#request<void>("PATCH", `${API_PREFIX}/${chatId}`, req, signal);
  }

  /** Convenience: archive a chat (soft-hide; safe for cleanup). */
  archiveChat(chatId: string, signal?: AbortSignal): Promise<void> {
    return this.updateChat(chatId, { archived: true }, signal);
  }

  // --- Streaming ------------------------------------------------------------

  streamEvents(
    chatId: string,
    opts?: { afterId?: number; signal?: AbortSignal },
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    return streamChatEvents({
      baseUrl: this.baseUrl,
      token: this.#token,
      chatId,
      afterId: opts?.afterId,
      signal: opts?.signal,
      webSocketFactory: this.#webSocketFactory,
    });
  }

  // --- Helpers --------------------------------------------------------------

  /**
   * Resolves a user-friendly model hint to a model-config UUID.
   *
   * Accepts: a config UUID (returned as-is), a `provider:model` id
   * (e.g. `anthropic:claude-haiku-4-5-20251001`), a bare model id, or a
   * display-name substring (case-insensitive). Returns `undefined` if no
   * match is found, in which case the caller should let chatd pick the default.
   */
  async resolveModelConfigId(hint: string, signal?: AbortSignal): Promise<string | undefined> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(hint)) return hint;

    const configs = await this.listModelConfigs(signal);
    const lower = hint.toLowerCase();
    // `provider:model` form.
    const colon = hint.indexOf(":");
    const provider = colon >= 0 ? hint.slice(0, colon).toLowerCase() : undefined;
    const model = colon >= 0 ? hint.slice(colon + 1).toLowerCase() : lower;

    const candidates = configs.filter((c) => c.enabled !== false);
    const pool = candidates.length > 0 ? candidates : configs;

    const exact = pool.find(
      (c) =>
        c.model.toLowerCase() === model &&
        (provider === undefined || c.provider.toLowerCase() === provider),
    );
    if (exact) return exact.id;

    const byModel = pool.find((c) => c.model.toLowerCase() === model);
    if (byModel) return byModel.id;

    const byDisplay = pool.find((c) => c.display_name.toLowerCase().includes(lower));
    if (byDisplay) return byDisplay.id;

    const byModelSubstring = pool.find((c) => c.model.toLowerCase().includes(model));
    return byModelSubstring?.id;
  }
}
