import { CoderAgentError, CoderApiError } from "../errors.js";
import { type FileContent, resolveFileContent } from "../files.js";
import {
  type Chat,
  CHAT_ATTACHMENT_MEDIA_TYPES,
  type ChatMessagesResponse,
  type ChatModelConfig,
  type ChatStreamEvent,
  type CreateChatMessageRequest,
  type CreateChatMessageResponse,
  type CreateChatRequest,
  MAX_CHAT_FILE_SIZE_BYTES,
  type SubmitToolResultsRequest,
  type UpdateChatRequest,
  type UploadChatFileResponse,
} from "./types.js";
import { streamChatEvents, type WebSocketFactory } from "./ws.js";

/** A file to upload as a chat attachment. */
export interface ChatFileInput {
  content: FileContent;
  /** Media type. Required unless `content` is a Blob/File that carries its own `type`. */
  mediaType?: string;
  /** Original filename, surfaced to the model and UI. Defaults to a File's `name`. */
  name?: string;
}

/** A file that has been uploaded to chat-file storage. */
export interface UploadedChatFile {
  /** Server-assigned file id, referenced from message content via a `file` part. */
  id: string;
  mediaType: string;
  name?: string;
}

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

  /**
   * Issue a request and return the raw `Response` on success (body unread). On a
   * non-2xx status the body is consumed to build a {@link CoderApiError}. Shared
   * by JSON requests and the raw upload/download endpoints.
   */
  async #send(
    method: string,
    path: string,
    opts?: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Coder-Session-Token": this.#token,
      ...opts?.headers,
    };
    const init: RequestInit = { method, headers, body: opts?.body, signal: opts?.signal };
    // A streaming request body requires half-duplex mode on Node's fetch (undici).
    if (typeof ReadableStream !== "undefined" && opts?.body instanceof ReadableStream) {
      (init as RequestInit & { duplex?: "half" }).duplex = "half";
    }

    const res = await this.#fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      const errObj = (parsed ?? {}) as { message?: string; detail?: string };
      throw new CoderApiError({
        status: res.status,
        method,
        path,
        message: errObj.message ?? res.statusText ?? "request failed",
        detail: errObj.detail,
      });
    }
    return res;
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.#send(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal,
    });
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined as T;
    }
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

  // --- Files ----------------------------------------------------------------

  /**
   * Upload a file as a durable chat attachment, returning its id (referenced
   * from message content via a `file` input part). The server enforces a narrow
   * media-type allowlist and a 10 MiB cap; both are checked client-side first so
   * unsupported files fail fast with a clear error instead of an opaque 4xx.
   *
   * The body is sent raw (not multipart): `Content-Type` carries the media type
   * and `Content-Disposition` the filename, mirroring `codersdk`.
   */
  async uploadChatFile(
    organizationId: string,
    file: ChatFileInput,
    signal?: AbortSignal,
  ): Promise<UploadedChatFile> {
    const resolved = resolveFileContent(file.content, {
      mediaType: file.mediaType,
      name: file.name,
    });
    if (!CHAT_ATTACHMENT_MEDIA_TYPES.has(resolved.mediaType)) {
      throw new CoderAgentError(
        `Media type "${resolved.mediaType}" is not allowed for chat attachments ` +
          `(allowed: ${[...CHAT_ATTACHMENT_MEDIA_TYPES].join(", ")}). ` +
          `Write other file types to a workspace instead.`,
      );
    }
    if (resolved.size !== undefined && resolved.size > MAX_CHAT_FILE_SIZE_BYTES) {
      throw new CoderAgentError(
        `File is ${resolved.size} bytes, over the ${MAX_CHAT_FILE_SIZE_BYTES}-byte ` +
          `(10 MiB) chat attachment limit. Write large files to a workspace instead.`,
      );
    }

    const headers: Record<string, string> = { "Content-Type": resolved.mediaType };
    if (resolved.name) {
      headers["Content-Disposition"] =
        `attachment; filename="${resolved.name.replace(/"/g, '\\"')}"`;
    }
    const res = await this.#send(
      "POST",
      `${API_PREFIX}/files?organization=${encodeURIComponent(organizationId)}`,
      { body: resolved.body, headers, signal },
    );
    const text = await res.text();
    const parsed = (text.length > 0 ? JSON.parse(text) : {}) as UploadChatFileResponse;
    return { id: parsed.id, mediaType: resolved.mediaType, name: resolved.name };
  }

  /** Download a chat file's bytes and media type by id. */
  async getChatFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const res = await this.#send("GET", `${API_PREFIX}/files/${fileId}`, { signal });
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mediaType: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
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
