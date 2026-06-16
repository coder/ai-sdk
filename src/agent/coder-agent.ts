import {
  type Agent,
  type StopCondition,
  stepCountIs,
  type SystemModelMessage,
  type ToolChoice,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { CoderChatClient, type CoderChatClientOptions } from "../coder/client.js";
import { CoderAgentError } from "../errors.js";
import { CoderLanguageModel } from "../model/language-model.js";

type InnerAgent<TOOLS extends ToolSet> = ToolLoopAgent<never, TOOLS, never>;

/** Default step ceiling. Each "step" is one client-tool round-trip; chatd caps
 * its own server-side loop at 1200 steps independently. */
const DEFAULT_STOP = stepCountIs(64);

export interface CoderAgentSettings<TOOLS extends ToolSet = {}> {
  // --- connection (provide a client, or baseUrl + token) ---
  /** A pre-built {@link CoderChatClient}. Mutually exclusive with baseUrl/token. */
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

  constructor(settings: CoderAgentSettings<TOOLS>) {
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

    this.#model = new CoderLanguageModel({
      client: this.#client,
      organizationId: settings.organizationId,
      model: settings.model,
      workspaceId: settings.workspaceId,
      mcpServerIds: settings.mcpServerIds,
      planMode: settings.planMode,
      chatId: settings.chatId,
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

  /** Start a fresh chatd chat on the next turn. */
  resetSession(): void {
    this.#model.resetSession();
  }

  /** Interrupt the in-flight generation, if any. */
  async interrupt(): Promise<void> {
    const id = this.#model.chatId;
    if (id) await this.#client.interruptChat(id);
  }

  /** Archive the underlying chat (safe cleanup; hides it from listings). */
  async archive(): Promise<void> {
    const id = this.#model.chatId;
    if (id) await this.#client.archiveChat(id);
  }
}
