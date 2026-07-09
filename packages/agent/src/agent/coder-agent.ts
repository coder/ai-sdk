import {
  type Agent,
  type FilePart,
  type StopCondition,
  stepCountIs,
  type SystemModelMessage,
  type ToolChoice,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { assertSupportedAiVersion } from "../ai-version.js";
import {
  type ChatFileInput,
  CoderChatClient,
  type CoderChatClientOptions,
  type UploadedChatFile,
} from "../coder/client.js";
import type { ChatModelConfig } from "../coder/types.js";
import {
  type PreviewShareLevel,
  resolveWorkspacePreview,
  shareWorkspacePreview,
  type WorkspaceApiConnection,
} from "../coder/workspaces.js";
import { CoderAgentError, CoderApiError } from "../errors.js";
import type { FileContent } from "../files.js";
import { CoderLanguageModel } from "../model/language-model.js";
import { CODER_PROVIDER_OPTIONS } from "../model/prompt.js";
import type { WorkspaceFileStore, WorkspacePlacement } from "../workspace-files.js";

type InnerAgent<TOOLS extends ToolSet> = ToolLoopAgent<never, TOOLS, never>;

/** A handle to a file uploaded as a chat attachment (see {@link CoderAgent.attach}). */
export interface ChatAttachment extends UploadedChatFile {
  /**
   * A native AI SDK `file` part that references this upload by id. Drop it into
   * a user message's `content` to reuse the file across turns without
   * re-uploading — the agent recognizes the id and skips the upload.
   *
   * The reference travels in `providerOptions.coder.fileId`; if you persist the
   * part through a store that strips `providerOptions`, the reference is lost
   * (re-`attach()` instead of persisting the handle).
   */
  toFilePart(): FilePart;
}

function makeChatAttachment(file: UploadedChatFile): ChatAttachment {
  return {
    ...file,
    toFilePart: () => ({
      type: "file",
      // Bytes are unused: the reference travels in providerOptions.coder.fileId.
      data: "",
      mediaType: file.mediaType,
      ...(file.name ? { filename: file.name } : {}),
      providerOptions: { [CODER_PROVIDER_OPTIONS]: { fileId: file.id } },
    }),
  };
}

/** Default step ceiling. Each "step" is one client-tool round-trip; chatd caps
 * its own server-side loop at 1200 steps independently. */
const DEFAULT_STOP = stepCountIs(64);

/**
 * Bounded-cleanup defaults. An interrupted chat keeps winding down server-side
 * for a few seconds, during which archiving 409s — {@link CoderAgent.archive}
 * and `[Symbol.asyncDispose]` retry those 409s every ~`SETTLE_RETRY_DELAY_MS`
 * for up to ~`SETTLE_DEADLINE_MS` overall before giving up.
 */
const SETTLE_DEADLINE_MS = 15_000;
const SETTLE_RETRY_DELAY_MS = 1_000;

/** Abort-aware sleep: resolves after `ms`, or rejects with the signal's reason. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Archive a chat, retrying while it is still settling. Interrupting a run does
 * not stop it instantly — chatd winds it down for a few more seconds and 409s
 * archive attempts in that window. Only those 409s are retried (other failures
 * and caller aborts rethrow immediately); once `deadlineMs` has elapsed the
 * last 409 is rethrown.
 */
async function archiveWhenSettled(
  client: CoderChatClient,
  chatId: string,
  opts: { deadlineMs: number; retryDelayMs: number; signal?: AbortSignal },
): Promise<void> {
  // The deadline decides when to stop retrying; the timeout signal additionally
  // unsticks an archive request that hangs (both track the same clock).
  const timeout = AbortSignal.timeout(opts.deadlineMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const deadline = Date.now() + opts.deadlineMs;
  for (;;) {
    try {
      await client.archiveChat(chatId, signal);
      return;
    } catch (err) {
      if (!(err instanceof CoderApiError) || err.status !== 409) throw err;
      // Stop when there is no budget left for another pause + attempt, surfacing
      // the 409 (the actionable error) rather than an opaque timeout.
      if (Date.now() + opts.retryDelayMs > deadline) throw err;
      // Pause on the caller's signal only — the deadline is enforced above.
      await sleep(opts.retryDelayMs, opts.signal);
    }
  }
}

export interface CoderAgentSettings<TOOLS extends ToolSet = {}> {
  // --- connection (provide a client, or baseUrl + token) ---
  /**
   * A pre-built {@link CoderChatClient}, used instead of constructing one from
   * `baseUrl`/`token`. The preview helpers ({@link CoderAgent.getPreview},
   * {@link CoderAgent.sharePreview}) call non-chat endpoints and therefore
   * still need credentials — pass `baseUrl` + `token` alongside `client` to
   * enable them.
   */
  client?: CoderChatClient;
  /** Coder deployment base URL, e.g. `https://dev.coder.com`. */
  baseUrl?: string;
  /** Coder API/session token (sent as `Coder-Session-Token`). */
  token?: string;
  fetch?: CoderChatClientOptions["fetch"];
  webSocketFactory?: CoderChatClientOptions["webSocketFactory"];

  // --- Coder chat configuration ---
  /** Organization UUID that owns the chat (required). */
  organizationId: string;
  /** Model hint: UUID, `provider:model`, model id, or display-name substring. */
  model?: string;
  /** Bind the chat to a Coder workspace (enables workspace-scoped tools). */
  workspaceId?: string;
  /**
   * Adapter for writing files onto a workspace filesystem, enabling
   * {@link CoderAgent.uploadToWorkspace}. Supply one backed by a workspace
   * connection (e.g. a `@coder/ai-sdk-eve-sandbox` session).
   */
  workspaceFiles?: WorkspaceFileStore;
  /** chatd-side MCP servers to enable for this chat. */
  mcpServerIds?: string[];
  /** chatd plan mode. */
  planMode?: "" | "plan";
  /** Resume an existing chat (session) instead of creating a new one. */
  chatId?: string;

  // --- agent configuration ---
  /** Stable agent id (exposed as {@link CoderAgent.id}). */
  id?: string;
  /** System instructions → chatd `system_prompt`. */
  instructions?: string | SystemModelMessage | Array<SystemModelMessage>;
  /** Custom (client-executed) tools. Each should have an `execute` for scripting. */
  tools?: TOOLS;
  toolChoice?: ToolChoice<NoInfer<TOOLS>>;
  /** Stop condition(s) for the AI SDK loop. Default `stepCountIs(64)`. */
  stopWhen?: StopCondition<NoInfer<TOOLS>> | Array<StopCondition<NoInfer<TOOLS>>>;
  /**
   * SDK-level retries. Default `0`: this agent owns server-side chat state, so
   * SDK retries could duplicate a turn. Override with care.
   */
  maxRetries?: number;
  /**
   * Per-segment time budget in milliseconds, applied to each model round-trip
   * (chat creation / message / tool-result submission plus the server run until
   * it settles). If a segment runs longer (e.g. the server is wedged or a
   * workspace can't be scheduled), the run is interrupted server-side and the
   * call rejects with a retryable {@link CoderChatError} (`kind: "timeout"`)
   * instead of hanging. A multi-step `generate()` driving client tools makes
   * several segments, so this bounds each one — to cap total wall-clock for the
   * whole call, pass `abortSignal: AbortSignal.timeout(ms)`. Unset or
   * non-positive means no limit.
   */
  requestTimeoutMs?: number;
  /**
   * Overall deadline in milliseconds for bounded cleanup: how long
   * {@link CoderAgent.archive} keeps retrying while a freshly interrupted chat
   * settles server-side, and how long `[Symbol.asyncDispose]` may take in
   * total. Default 15 000. Primarily a test/tuning knob.
   */
  settleDeadlineMs?: number;
  /**
   * Pause in milliseconds between {@link CoderAgent.archive} retries while the
   * chat settles. Default 1000. Primarily a test/tuning knob.
   */
  settleRetryDelayMs?: number;
}

/** Options for {@link CoderAgent.getPreview}. */
export interface WorkspacePreviewOptions {
  /** Workspace port the app listens on (4–5 digit ports parse most reliably). */
  port: number;
  /**
   * Agent that serves the port. Optional when the workspace has exactly one
   * agent; required when it has several (the error lists the candidates).
   */
  agentName?: string;
  /**
   * Protocol the app speaks *inside the workspace* on that port — `https` adds
   * the `s` suffix (`3000s--…`) so the proxy connects over TLS. This is not
   * the browser scheme, which follows the deployment's access URL.
   * Default `"http"`.
   */
  protocol?: "http" | "https";
  signal?: AbortSignal;
}

/** A resolved workspace preview URL (see {@link CoderAgent.getPreview}). */
export interface WorkspacePreview {
  /** Browser-openable subdomain app URL, e.g. `https://3000--main--dev--alice.apps.example.com`. */
  url: string;
}

/** Options for {@link CoderAgent.sharePreview}. */
export interface SharePreviewOptions extends WorkspacePreviewOptions {
  /**
   * Who may open the preview: `authenticated` (any logged-in user; the
   * default), `organization` (members of the workspace's organization;
   * requires a newer Coder server), or `public` (no auth at all — mind what
   * the port serves).
   */
  shareLevel?: PreviewShareLevel;
}

/** A shared workspace preview (see {@link CoderAgent.sharePreview}). */
export interface SharedWorkspacePreview extends WorkspacePreview {
  /** The share level now in effect for the port. */
  shareLevel: PreviewShareLevel;
}

/**
 * An AI SDK-compliant agent backed by a remote Coder `chatd` agent runtime.
 *
 * `new CoderAgent({ ... })` returns an object that implements the AI SDK
 * `Agent` interface (`generate()`/`stream()`), so it composes with the rest of
 * the AI SDK ecosystem. Internally it wraps a {@link ToolLoopAgent} whose model
 * is a {@link CoderLanguageModel}; chatd runs the actual agent loop server-side.
 *
 * One `CoderAgent` instance corresponds to one chatd chat ("session"): the chat
 * is created on the first `generate()`/`stream()` and reused for subsequent
 * turns. Use {@link CoderAgent.resetSession} to start a fresh chat.
 */
export class CoderAgent<TOOLS extends ToolSet = {}> implements Agent<never, TOOLS, never> {
  readonly version = "agent-v1" as const;

  readonly #client: CoderChatClient;
  readonly #model: CoderLanguageModel;
  readonly #inner: InnerAgent<TOOLS>;
  readonly #organizationId: string;
  readonly #workspaceFiles: WorkspaceFileStore | undefined;
  readonly #workspaceId: string | undefined;
  readonly #workspaceApi: WorkspaceApiConnection | undefined;
  readonly #settleDeadlineMs: number;
  readonly #settleRetryDelayMs: number;

  constructor(settings: CoderAgentSettings<TOOLS>) {
    // Fail fast on an incompatible AI SDK major (see peer dependency `ai@^6`).
    assertSupportedAiVersion();

    if (settings.client) {
      this.#client = settings.client;
    } else if (settings.baseUrl && settings.token) {
      this.#client = new CoderChatClient({
        baseUrl: settings.baseUrl,
        token: settings.token,
        fetch: settings.fetch,
        webSocketFactory: settings.webSocketFactory,
      });
    } else {
      throw new CoderAgentError(
        "CoderAgent requires either `client` or both `baseUrl` and `token`.",
      );
    }

    this.#organizationId = settings.organizationId;
    this.#workspaceFiles = settings.workspaceFiles;
    this.#workspaceId = settings.workspaceId;
    // The preview helpers call stable v2 endpoints that CoderChatClient (chat
    // scoped) does not expose, so they need the raw credentials when given.
    this.#workspaceApi =
      settings.baseUrl && settings.token
        ? { baseUrl: settings.baseUrl, token: settings.token, fetch: settings.fetch }
        : undefined;
    this.#settleDeadlineMs = settings.settleDeadlineMs ?? SETTLE_DEADLINE_MS;
    this.#settleRetryDelayMs = settings.settleRetryDelayMs ?? SETTLE_RETRY_DELAY_MS;

    // A file written to one workspace isn't visible to a chat bound to another.
    if (
      settings.workspaceFiles &&
      settings.workspaceId &&
      settings.workspaceFiles.workspaceId !== settings.workspaceId
    ) {
      throw new CoderAgentError(
        `workspaceFiles.workspaceId (${settings.workspaceFiles.workspaceId}) does not match the ` +
          `agent's workspaceId (${settings.workspaceId}); the chat's tools would not see uploaded files.`,
      );
    }

    this.#model = new CoderLanguageModel({
      client: this.#client,
      organizationId: settings.organizationId,
      model: settings.model,
      workspaceId: settings.workspaceId,
      mcpServerIds: settings.mcpServerIds,
      planMode: settings.planMode,
      chatId: settings.chatId,
      requestTimeoutMs: settings.requestTimeoutMs,
    });

    this.#inner = new ToolLoopAgent<never, TOOLS, never>({
      model: this.#model,
      id: settings.id,
      instructions: settings.instructions,
      tools: settings.tools,
      toolChoice: settings.toolChoice,
      stopWhen: settings.stopWhen ?? DEFAULT_STOP,
      maxRetries: settings.maxRetries ?? 0,
    });
  }

  get id(): string | undefined {
    return this.#inner.id;
  }

  get tools(): TOOLS {
    return this.#inner.tools;
  }

  /** The underlying chatd client. */
  get client(): CoderChatClient {
    return this.#client;
  }

  /** The current chatd chat id, once a turn has started. */
  get chatId(): string | undefined {
    return this.#model.chatId;
  }

  generate(
    options: Parameters<InnerAgent<TOOLS>["generate"]>[0],
  ): ReturnType<InnerAgent<TOOLS>["generate"]> {
    return this.#inner.generate(options);
  }

  stream(
    options: Parameters<InnerAgent<TOOLS>["stream"]>[0],
  ): ReturnType<InnerAgent<TOOLS>["stream"]> {
    return this.#inner.stream(options);
  }

  // --- session helpers ------------------------------------------------------

  /**
   * List the model configs available on the deployment. Use this to discover
   * valid values for the `model` hint instead of guessing ids — match on
   * `id`, `provider`/`model`, or `display_name`.
   */
  listModels(signal?: AbortSignal): Promise<ChatModelConfig[]> {
    return this.#client.listModelConfigs(signal);
  }

  /** Start a fresh chatd chat on the next turn. */
  resetSession(): void {
    this.#model.resetSession();
  }

  /**
   * Interrupt the in-flight generation, if any. Resolves as soon as the server
   * acknowledges the interrupt — the run keeps winding down asynchronously for
   * a few seconds afterwards (see {@link CoderAgent.archive}).
   */
  async interrupt(opts?: { signal?: AbortSignal }): Promise<void> {
    const id = this.#model.chatId;
    if (id) await this.#client.interruptChat(id, opts?.signal);
  }

  /**
   * Archive the underlying chat (safe cleanup; hides it from listings).
   *
   * A freshly interrupted/settled chat can keep winding down server-side for a
   * few seconds, during which the server rejects archiving with a 409. Those
   * 409s are retried (~1s apart, ~15s overall — see `settleDeadlineMs` /
   * `settleRetryDelayMs`) and the last one is rethrown if the chat never
   * settles; any other failure, including a caller abort, rethrows immediately.
   */
  async archive(opts?: { signal?: AbortSignal }): Promise<void> {
    const id = this.#model.chatId;
    if (!id) return;
    await archiveWhenSettled(this.#client, id, {
      deadlineMs: this.#settleDeadlineMs,
      retryDelayMs: this.#settleRetryDelayMs,
      signal: opts?.signal,
    });
  }

  /**
   * Clean up the chat when the agent leaves an `await using` scope, so cleanup
   * rides scope exit instead of a separate call you have to remember in a
   * `finally`. Interrupts any in-flight server run, then archives the chat
   * (retrying while the interrupted run settles). Best-effort and bounded
   * (~15s overall): disposal errors are swallowed after the bounded attempts
   * so they can't mask the scope's own error — call {@link CoderAgent.archive}
   * directly when you need guaranteed cleanup.
   *
   * @example
   * ```ts
   * await using agent = new CoderAgent({ ... });
   * const { text } = await agent.generate({ prompt: "…" });
   * // agent.interrupt() + agent.archive() run automatically here.
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    // archive() only soft-hides the chat; it does not stop a generation. If the
    // scope exits mid-turn (e.g. generate() threw, or an early return), interrupt
    // first so chatd stops generating and releases the workspace, then archive.
    // One shared timeout bounds both calls so scope exit can never hang.
    const deadline = AbortSignal.timeout(this.#settleDeadlineMs);
    try {
      await this.interrupt({ signal: deadline });
    } catch {
      /* best-effort cleanup */
    }
    try {
      await this.archive({ signal: deadline });
    } catch {
      /* best-effort cleanup */
    }
  }

  // --- files ----------------------------------------------------------------

  /**
   * Upload a file as a chat attachment — content for the model to *read* (a PDF,
   * image, CSV, …). Returns a handle you can reference from a later turn via
   * {@link ChatAttachment.toFilePart} (no re-upload). Validated against the chat
   * allowlist and 10 MiB cap up front.
   *
   * You usually don't need this: a native AI SDK `file` part dropped into a
   * message's `content` is uploaded transparently. Reach for `attach()` to
   * pre-upload, to reuse one file across turns, or to validate before sending.
   *
   * For large or non-allowlisted files (zips, datasets, binaries) — material for
   * the agent to *operate on* — use {@link CoderAgent.uploadToWorkspace}.
   */
  async attach(file: ChatFileInput, signal?: AbortSignal): Promise<ChatAttachment> {
    const uploaded = await this.#client.uploadChatFile(this.#organizationId, file, signal);
    return makeChatAttachment(uploaded);
  }

  /**
   * Write a file onto the bound workspace's filesystem for the agent to operate
   * on (extract, build, read with its tools). Requires a {@link WorkspaceFileStore}
   * via the `workspaceFiles` setting. The file is written as-is — no unpacking;
   * instruct the agent to `unzip`/`tar -x`, or extract over your own connection.
   *
   * The chat should be bound to the same workspace (`workspaceId`) so the agent's
   * server-side tools can see the file.
   */
  async uploadToWorkspace(file: {
    content: FileContent;
    /** Destination path inside the workspace (the adapter may resolve relatives). */
    path: string;
    signal?: AbortSignal;
  }): Promise<WorkspacePlacement> {
    if (!this.#workspaceFiles) {
      throw new CoderAgentError(
        "uploadToWorkspace requires a `workspaceFiles` adapter. Construct the agent with " +
          "`workspaceFiles` (e.g. backed by a @coder/ai-sdk-eve-sandbox session) to enable it.",
      );
    }
    const { path } = await this.#workspaceFiles.write({
      content: file.content,
      path: file.path,
      signal: file.signal,
    });
    return { workspaceId: this.#workspaceFiles.workspaceId, path };
  }

  // --- previews ---------------------------------------------------------------

  /** The v2 connection + workspace id the preview helpers need, or a clear error. */
  #previewContext(method: string): { conn: WorkspaceApiConnection; workspaceId: string } {
    if (!this.#workspaceId) {
      throw new CoderAgentError(
        `${method}() requires the agent to be bound to a workspace — construct the CoderAgent ` +
          `with the \`workspaceId\` setting.`,
      );
    }
    if (!this.#workspaceApi) {
      throw new CoderAgentError(
        `${method}() needs the deployment's REST credentials — construct the CoderAgent with ` +
          `\`baseUrl\` and \`token\` (they can accompany \`client\`).`,
      );
    }
    return { conn: this.#workspaceApi, workspaceId: this.#workspaceId };
  }

  /**
   * Resolve the browser URL where a port on the bound workspace can be
   * previewed, e.g. `https://3000--main--dev--alice.apps.example.com`.
   * Composed from stable v2 endpoints (workspace lookup + wildcard app host),
   * so it works against old Coder servers. Requires the `workspaceId` setting,
   * `baseUrl`/`token` credentials, and a deployment with a wildcard access URL
   * configured.
   *
   * The URL honors the port's current share level — private to the workspace
   * owner unless shared (see {@link CoderAgent.sharePreview}).
   */
  async getPreview(opts: WorkspacePreviewOptions): Promise<WorkspacePreview> {
    const { conn, workspaceId } = this.#previewContext("getPreview");
    const { url } = await resolveWorkspacePreview(
      conn,
      { workspaceId, port: opts.port, agentName: opts.agentName, protocol: opts.protocol },
      opts.signal,
    );
    return { url };
  }

  /**
   * Share a port on the bound workspace and return its preview URL. Upserts
   * the port's share level — `authenticated` by default — so teammates (or,
   * with `public`, anyone) can open what the agent is serving; re-invoking
   * updates the level in place. On Coder servers that predate port sharing
   * (< v2.9) this fails with a 404 {@link CoderApiError} saying so.
   */
  async sharePreview(opts: SharePreviewOptions): Promise<SharedWorkspacePreview> {
    const { conn, workspaceId } = this.#previewContext("sharePreview");
    return shareWorkspacePreview(
      conn,
      {
        workspaceId,
        port: opts.port,
        agentName: opts.agentName,
        protocol: opts.protocol,
        shareLevel: opts.shareLevel,
      },
      opts.signal,
    );
  }
}
