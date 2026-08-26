import { CoderAgentError, CoderApiError } from "../errors.js";
import { type FileContent, resolveFileContent } from "../files.js";
import {
  type Chat,
  CHAT_ATTACHMENT_MEDIA_TYPES,
  type ChatMessagesResponse,
  type ChatModelConfig,
  type ChatStreamEvent,
  type ChatWatchEvent,
  type CreateChatMessageRequest,
  type CreateChatMessageResponse,
  type CreateChatRequest,
  MAX_CHAT_FILE_SIZE_BYTES,
  type SubmitToolResultsRequest,
  type UpdateChatRequest,
  type UploadChatFileResponse,
} from "./types.js";
import { streamChatEvents, watchChatEvents, type WebSocketFactory } from "./ws.js";
import {
  type CoderClientOperation,
  safeTransportEmitter,
  type TransportEventHandler,
} from "../transport-events.js";

/** A file to upload as a chat attachment. */
export interface ChatFileInput {
  content: FileContent;
  /**
   * Media type. Required unless `content` is a Blob/File with a non-empty `type`
   * — note `fs.openAsBlob()` returns a Blob with no type, so pass it explicitly there.
   */
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
  /**
   * Observability hook: receives typed transport events (HTTP request/response
   * timings, per-chat stream WebSocket lifecycle). Exceptions it throws are
   * swallowed; without it, no event objects are allocated. See
   * {@link CoderTransportEvent}.
   */
  onTransportEvent?: TransportEventHandler;
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
  /** The raw subscriber, forwarded to stream readers (which wrap it themselves). */
  readonly #onTransportEvent: TransportEventHandler | undefined;
  /** Exception-isolated emitter for this client's own HTTP events. */
  readonly #emitTransportEvent: TransportEventHandler | undefined;
  #httpSeq = 0;

  constructor(options: CoderChatClientOptions) {
    // Normalize: strip a single trailing slash.
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocketFactory = options.webSocketFactory;
    this.#onTransportEvent = options.onTransportEvent;
    this.#emitTransportEvent = safeTransportEmitter(options.onTransportEvent);
  }

  /**
   * Issue a request and return the raw `Response` on success (body unread). On a
   * non-2xx status the body is consumed to build a {@link CoderApiError}. Shared
   * by JSON requests and the raw upload/download endpoints. `op` names the
   * public client method on the exchange's `http:*` events (issue #112) — the
   * emit site is shared, so each call site threads its own literal.
   */
  async #send(
    op: CoderClientOperation,
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

    // Observability: request/response/error events, guarded so nothing is
    // allocated without a subscriber. NOTE: headers are deliberately excluded
    // from the events (the auth token travels in `Coder-Session-Token`).
    const emit = this.#emitTransportEvent;
    let requestId = 0;
    let startedAt = 0;
    if (emit) {
      requestId = ++this.#httpSeq;
      startedAt = performance.now();
      emit({ type: "http:request", id: requestId, op, method, path, timestamp: Date.now() });
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      emit?.({
        type: "http:error",
        id: requestId,
        op,
        method,
        path,
        message: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - startedAt,
        timestamp: Date.now(),
      });
      throw err;
    }
    emit?.({
      type: "http:response",
      id: requestId,
      op,
      method,
      path,
      status: res.status,
      ok: res.ok,
      durationMs: performance.now() - startedAt,
      timestamp: Date.now(),
    });
    if (!res.ok) {
      const errObj = (await this.#json<{ message?: string; detail?: string }>(res)) ?? {};
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

  /** Read a response body as JSON, tolerating an unreadable/empty/malformed body (→ undefined). */
  async #json<T>(res: Response): Promise<T | undefined> {
    const text = await res.text().catch(() => "");
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  async #request<T>(
    op: CoderClientOperation,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.#send(op, method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      signal,
    });
    return (await this.#json<T>(res)) as T;
  }

  // --- REST -----------------------------------------------------------------

  listModelConfigs(signal?: AbortSignal): Promise<ChatModelConfig[]> {
    return this.#request<ChatModelConfig[]>(
      "listModelConfigs",
      "GET",
      `${API_PREFIX}/model-configs`,
      undefined,
      signal,
    );
  }

  createChat(req: CreateChatRequest, signal?: AbortSignal): Promise<Chat> {
    return this.#request<Chat>("createChat", "POST", API_PREFIX, req, signal);
  }

  getChat(chatId: string, signal?: AbortSignal): Promise<Chat> {
    return this.#request<Chat>("getChat", "GET", `${API_PREFIX}/${chatId}`, undefined, signal);
  }

  createChatMessage(
    chatId: string,
    req: CreateChatMessageRequest,
    signal?: AbortSignal,
  ): Promise<CreateChatMessageResponse> {
    return this.#request<CreateChatMessageResponse>(
      "createChatMessage",
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
      "getMessages",
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
    return this.#request<void>(
      "submitToolResults",
      "POST",
      `${API_PREFIX}/${chatId}/tool-results`,
      req,
      signal,
    );
  }

  /**
   * Interrupt the chat's in-flight run (`POST /interrupt`). The server flips
   * an active run to `interrupting` and responds immediately with the updated
   * chat — it does not wait for the run to actually stop.
   *
   * Pass `{ wait: true }` to send `?wait=true`, asking the server to hold the
   * response until the run has stopped. Coder servers without that param
   * ignore the unknown query harmlessly and still return immediately, so
   * callers should be prepared to confirm completion via the event stream.
   *
   * The second parameter also accepts a bare `AbortSignal` (the historical
   * signature).
   */
  interruptChat(
    chatId: string,
    optsOrSignal?: AbortSignal | { wait?: boolean; signal?: AbortSignal },
  ): Promise<Chat> {
    const opts = optsOrSignal instanceof AbortSignal ? { signal: optsOrSignal } : optsOrSignal;
    const query = opts?.wait ? "?wait=true" : "";
    return this.#request<Chat>(
      "interruptChat",
      "POST",
      `${API_PREFIX}/${chatId}/interrupt${query}`,
      undefined,
      opts?.signal,
    );
  }

  /**
   * Withdraw a QUEUED (not yet materialized) message from the chat's
   * submission queue (`DELETE /queue/{id}`). `queuedMessageId` is the
   * queue-entry id from `CreateChatMessageResponse.queued_message` — a
   * different id space from committed chat message ids. Rejects with a
   * {@link CoderApiError}: 404 when the entry no longer exists (already
   * promoted into history, or deleted), 409 when the chat has no queue.
   */
  deleteQueuedMessage(
    chatId: string,
    queuedMessageId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#request<void>(
      "deleteQueuedMessage",
      "DELETE",
      `${API_PREFIX}/${chatId}/queue/${queuedMessageId}`,
      undefined,
      signal,
    );
  }

  updateChat(chatId: string, req: UpdateChatRequest, signal?: AbortSignal): Promise<void> {
    return this.#request<void>("updateChat", "PATCH", `${API_PREFIX}/${chatId}`, req, signal);
  }

  /** Convenience: archive a chat (soft-hide; safe for cleanup). */
  archiveChat(chatId: string, signal?: AbortSignal): Promise<void> {
    // Issues updateChat's PATCH directly so its `http:*` events carry its own
    // `op` — the point of the stamp is the caller's intent, not the wire shape.
    return this.#request<void>(
      "archiveChat",
      "PATCH",
      `${API_PREFIX}/${chatId}`,
      { archived: true } satisfies UpdateChatRequest,
      signal,
    );
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
    // Match the allowlist on the media type alone, ignoring parameters such as
    // `; charset=utf-8` that a Blob/File commonly carries.
    const mediaType = (resolved.mediaType.split(";")[0] ?? resolved.mediaType).trim().toLowerCase();
    if (!CHAT_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      throw new CoderAgentError(
        `Media type "${mediaType}" is not allowed for chat attachments ` +
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

    const headers: Record<string, string> = { "Content-Type": mediaType };
    if (resolved.name) {
      // RFC 6266: a sanitized ASCII `filename` plus an RFC 5987 `filename*` that
      // preserves the exact name. Both are pure ASCII, so a non-Latin-1 name
      // (CJK, emoji, accents) can't trip fetch's ByteString header check, and
      // CR/LF/quote/backslash are encoded away rather than breaking the header.
      const ascii = resolved.name.replace(/[^\x20-\x7e]/g, "_").replace(/(["\\])/g, "\\$1");
      const utf8 = encodeURIComponent(resolved.name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      headers["Content-Disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
    }
    const res = await this.#send(
      "uploadChatFile",
      "POST",
      `${API_PREFIX}/files?organization=${encodeURIComponent(organizationId)}`,
      { body: resolved.body, headers, signal },
    );
    const parsed = await this.#json<UploadChatFileResponse>(res);
    if (!parsed?.id) {
      throw new CoderApiError({
        status: res.status,
        method: "POST",
        path: `${API_PREFIX}/files`,
        message: "upload succeeded but the response contained no file id",
      });
    }
    return { id: parsed.id, mediaType, name: resolved.name };
  }

  /** Download a chat file's bytes and media type by id. */
  async getChatFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const res = await this.#send("getChatFile", "GET", `${API_PREFIX}/files/${fileId}`, {
      signal,
    });
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mediaType: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  // --- Streaming ------------------------------------------------------------

  streamEvents(
    chatId: string,
    opts?: {
      afterId?: number;
      signal?: AbortSignal;
      /** Pre-allocated reader id for `ws:*` events — see {@link streamChatEvents}. */
      reader?: number;
    },
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    return streamChatEvents({
      baseUrl: this.baseUrl,
      token: this.#token,
      chatId,
      afterId: opts?.afterId,
      signal: opts?.signal,
      reader: opts?.reader,
      webSocketFactory: this.#webSocketFactory,
      onTransportEvent: this.#onTransportEvent,
    });
  }

  /**
   * Watch lifecycle events (status/title changes, creation, deletion, …) for
   * every chat visible to the authenticated user via the `/chats/watch`
   * WebSocket. Dropped connections are redialed with exponential backoff; the
   * iteration ends only when `opts.signal` aborts, or with a terminal
   * {@link CoderApiError} when the server rejects the upgrade with a 4xx
   * (bad/expired token, or an older Coder server without the endpoint → 404).
   */
  watchChats(opts?: { signal?: AbortSignal }): AsyncGenerator<ChatWatchEvent, void, void> {
    return watchChatEvents({
      baseUrl: this.baseUrl,
      token: this.#token,
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
   *
   * Tolerates partial payloads from older/newer servers: a malformed listing
   * (empty body, non-array JSON, null entries) resolves as no match, and
   * entries missing `provider`, `model`, or `display_name` are matched on the
   * fields they do carry — an entry without `provider` still matches by its
   * model id, one without `model` only by display name.
   */
  async resolveModelConfigId(hint: string, signal?: AbortSignal): Promise<string | undefined> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(hint)) return hint;

    // Issues listModelConfigs' GET directly so the exchange's `http:*` events
    // carry this method's own `op` — the stamp names the caller's intent
    // (model resolution), not the wire shape it borrows.
    const raw: unknown = await this.#request<ChatModelConfig[]>(
      "resolveModelConfigId",
      "GET",
      `${API_PREFIX}/model-configs`,
      undefined,
      signal,
    );
    const configs = (Array.isArray(raw) ? raw : []).filter(
      (c): c is ChatModelConfig => typeof c === "object" && c !== null,
    );
    const lower = hint.toLowerCase();
    // `provider:model` form.
    const colon = hint.indexOf(":");
    const provider = colon >= 0 ? hint.slice(0, colon).toLowerCase() : undefined;
    const model = colon >= 0 ? hint.slice(colon + 1).toLowerCase() : lower;

    const candidates = configs.filter((c) => c.enabled !== false);
    const pool = candidates.length > 0 ? candidates : configs;

    // Guarded accessors: treat a missing/non-string field as absent.
    const modelOf = (c: ChatModelConfig) =>
      typeof c.model === "string" ? c.model.toLowerCase() : undefined;
    const providerOf = (c: ChatModelConfig) =>
      typeof c.provider === "string" ? c.provider.toLowerCase() : undefined;
    const displayNameOf = (c: ChatModelConfig) =>
      typeof c.display_name === "string" ? c.display_name.toLowerCase() : undefined;

    const exact = pool.find(
      (c) => modelOf(c) === model && (provider === undefined || providerOf(c) === provider),
    );
    if (exact) return exact.id;

    const byModel = pool.find((c) => modelOf(c) === model);
    if (byModel) return byModel.id;

    const byDisplay = pool.find((c) => displayNameOf(c)?.includes(lower));
    if (byDisplay) return byDisplay.id;

    const byModelSubstring = pool.find((c) => modelOf(c)?.includes(model));
    return byModelSubstring?.id;
  }
}
