import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { CoderAgentError, CoderChatError } from "../errors.js";
import { CoderChatClient } from "../coder/client.js";
import type { ChatInputPart, CreateChatRequest } from "../coder/types.js";
import { dataContentToFileContent } from "../files.js";
import {
  classifyTurnAction,
  dynamicToolNames,
  extractSystemPrompt,
  type FilePartUploader,
  toolsToDynamicTools,
  type UserContent,
  userContentToInputParts,
} from "./prompt.js";
import { TurnTranslator } from "./translate.js";

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export interface CoderLanguageModelConfig {
  client: CoderChatClient;
  organizationId: string;
  /** Model hint (UUID, `provider:model`, model id, or display-name substring). */
  model?: string;
  /** Bind the chat to a Coder workspace (enables workspace tools). */
  workspaceId?: string;
  /** chatd-side MCP servers to enable. */
  mcpServerIds?: string[];
  planMode?: "" | "plan";
  /** Resume an existing chat instead of creating a new one. */
  chatId?: string;
}

/**
 * A {@link LanguageModelV3} that is backed by a remote Coder `chatd` agent
 * runtime instead of a raw LLM. One model instance owns one chatd chat
 * (a "session"): the chat is created lazily on the first turn and reused for
 * subsequent turns and for client-tool resume steps.
 *
 * The chatd server runs the agent loop (model calls, server-side tools,
 * compaction) itself. This model therefore represents *one chatd segment* per
 * `doStream` call — it advances the chat until it settles (`waiting`/
 * `completed`) or pauses for a client tool (`requires_action`). When the AI SDK
 * executes a client tool and calls `doStream` again with the tool result, this
 * model resumes the same chat. The two loops mesh at the client-tool boundary.
 *
 * NOTE: a single model instance is single-flight — do not run concurrent
 * generations against the same instance/session.
 */
export class CoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "coder.chatd";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly #config: CoderLanguageModelConfig;
  #chatId: string | undefined;
  #lastSeenMessageId = 0;
  #resolvedModelConfigId: string | undefined;
  #modelResolved = false;
  readonly #submittedToolCallIds = new Set<string>();
  #inFlight = false;

  constructor(config: CoderLanguageModelConfig) {
    this.#config = config;
    this.modelId = config.model ?? "chatd";
    this.#chatId = config.chatId;
  }

  get chatId(): string | undefined {
    return this.#chatId;
  }

  /** Drops the current session so the next turn creates a fresh chat. */
  resetSession(): void {
    this.#chatId = undefined;
    this.#lastSeenMessageId = 0;
    this.#submittedToolCallIds.clear();
  }

  async #resolveModelConfigId(signal?: AbortSignal): Promise<string | undefined> {
    if (this.#modelResolved) return this.#resolvedModelConfigId;
    if (this.#config.model) {
      this.#resolvedModelConfigId = await this.#config.client.resolveModelConfigId(
        this.#config.model,
        signal,
      );
    }
    this.#modelResolved = true;
    return this.#resolvedModelConfigId;
  }

  /**
   * Resolve a user message's content to chatd input parts, uploading any file
   * parts to chat-file storage (the upload endpoint needs only the organization
   * id, so this runs before the chat exists). Pre-uploaded files carried via
   * `providerOptions.coder.fileId` are referenced without re-uploading.
   */
  #buildContent(content: UserContent, signal?: AbortSignal): Promise<ChatInputPart[]> {
    const uploadFile: FilePartUploader = async (f) => {
      const uploaded = await this.#config.client.uploadChatFile(
        this.#config.organizationId,
        { content: dataContentToFileContent(f.data), mediaType: f.mediaType, name: f.filename },
        signal,
      );
      return uploaded.id;
    };
    return userContentToInputParts(content, uploadFile);
  }

  async *#runTurn(
    options: LanguageModelV3CallOptions,
  ): AsyncGenerator<LanguageModelV3StreamPart, void, void> {
    // A single model instance owns one chatd session's mutable state, so it is
    // single-flight: reject overlapping turns rather than silently corrupting
    // chatId / lastSeenMessageId / submitted tool-call tracking.
    if (this.#inFlight) {
      throw new CoderAgentError(
        "A generation is already in flight on this CoderAgent (single-flight). Use a separate CoderAgent instance for concurrent sessions.",
      );
    }
    this.#inFlight = true;
    try {
      const { prompt, abortSignal: signal } = options;
      yield { type: "stream-start", warnings: [] };

      const action = classifyTurnAction(prompt);
      if (action.kind === "noop") {
        throw new CoderAgentError(
          "CoderAgent received a prompt with no user message or tool results to act on.",
        );
      }

      const translator = new TurnTranslator({ dynamicToolNames: dynamicToolNames(options.tools) });
      let afterId: number | undefined;

      if (action.kind === "new-turn") {
        // Resolve the model config and upload any file parts concurrently — they
        // are independent round-trips. (Uploads run before the chat exists and
        // resolve file parts to `file` input parts referencing their uploaded ids.)
        const [modelConfigId, content] = await Promise.all([
          this.#resolveModelConfigId(signal),
          this.#buildContent(action.content, signal),
        ]);
        if (!this.#chatId) {
          const req: CreateChatRequest = {
            organization_id: this.#config.organizationId,
            content,
            client_type: "api",
          };
          const system = extractSystemPrompt(prompt);
          if (system) req.system_prompt = system;
          const tools = toolsToDynamicTools(options.tools);
          if (tools.length > 0) req.unsafe_dynamic_tools = tools;
          if (modelConfigId) req.model_config_id = modelConfigId;
          if (this.#config.workspaceId) req.workspace_id = this.#config.workspaceId;
          if (this.#config.mcpServerIds?.length) req.mcp_server_ids = this.#config.mcpServerIds;
          if (this.#config.planMode) req.plan_mode = this.#config.planMode;
          const chat = await this.#config.client.createChat(req, signal);
          this.#chatId = chat.id;
          afterId = this.#lastSeenMessageId > 0 ? this.#lastSeenMessageId : undefined;
        } else {
          const resp = await this.#config.client.createChatMessage(
            this.#chatId,
            {
              content,
              ...(modelConfigId ? { model_config_id: modelConfigId } : {}),
            },
            signal,
          );
          afterId = resp.message?.id ?? this.#lastSeenMessageId;
        }
      } else {
        // resume
        if (!this.#chatId)
          throw new CoderChatError({ message: "cannot submit tool results before a chat exists" });
        const fresh = action.toolResults.filter(
          (r) => !this.#submittedToolCallIds.has(r.tool_call_id),
        );
        if (fresh.length > 0) {
          await this.#config.client.submitToolResults(this.#chatId, { results: fresh }, signal);
          for (const r of fresh) this.#submittedToolCallIds.add(r.tool_call_id);
        }
        afterId = this.#lastSeenMessageId;
      }

      const chatId = this.#chatId as string;
      // chatd emits the `requires_action` status BEFORE the `action_required`
      // event that carries the pending tool calls, so for that status we keep
      // reading until the client tool calls have actually been emitted (bounded
      // by a safety counter, since the stream is a live subscription).
      let sinceRequiresAction = 0;
      for await (const ev of this.#config.client.streamEvents(chatId, { afterId, signal })) {
        for (const part of translator.ingest(ev)) yield part;
        const status = translator.terminalStatus;
        if (status) {
          if (status !== "requires_action") break;
          if (translator.clientToolCallSeen) break;
          if (++sinceRequiresAction > 200) break;
        }
      }

      if (signal?.aborted && !translator.terminalStatus) {
        throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }

      for (const part of translator.finish()) yield part;
      if (translator.maxMessageId > this.#lastSeenMessageId)
        this.#lastSeenMessageId = translator.maxMessageId;
    } finally {
      this.#inFlight = false;
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const gen = this.#runTurn(options);
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        try {
          const { value, done } = await gen.next();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        await gen.return();
      },
    });
    return { stream };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const content: LanguageModelV3Content[] = [];
    const textBuf = new Map<string, string>();
    const reasoningBuf = new Map<string, string>();
    let usage: LanguageModelV3Usage = EMPTY_USAGE;
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
      unified: "stop",
      raw: undefined,
    };
    const warnings: LanguageModelV3GenerateResult["warnings"] = [];

    for await (const part of this.#runTurn(options)) {
      switch (part.type) {
        case "stream-start":
          warnings.push(...part.warnings);
          break;
        case "text-start":
          textBuf.set(part.id, "");
          break;
        case "text-delta":
          textBuf.set(part.id, (textBuf.get(part.id) ?? "") + part.delta);
          break;
        case "text-end": {
          const t = textBuf.get(part.id) ?? "";
          if (t.length > 0) content.push({ type: "text", text: t });
          textBuf.delete(part.id);
          break;
        }
        case "reasoning-start":
          reasoningBuf.set(part.id, "");
          break;
        case "reasoning-delta":
          reasoningBuf.set(part.id, (reasoningBuf.get(part.id) ?? "") + part.delta);
          break;
        case "reasoning-end": {
          const t = reasoningBuf.get(part.id) ?? "";
          if (t.length > 0) content.push({ type: "reasoning", text: t });
          reasoningBuf.delete(part.id);
          break;
        }
        case "tool-call":
        case "tool-result":
        case "source":
        case "file":
          content.push(part);
          break;
        case "finish":
          usage = part.usage;
          finishReason = part.finishReason;
          break;
        case "error":
          throw part.error instanceof Error
            ? part.error
            : new CoderChatError({ message: String(part.error) });
        default:
          break;
      }
    }

    return { content, finishReason, usage, warnings };
  }
}
