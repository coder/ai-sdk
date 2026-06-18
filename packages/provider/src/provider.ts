import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider";

/** Default mount path of AI Gateway on a Coder deployment. */
const DEFAULT_AI_GATEWAY_PATH = "/api/v2/aibridge";
/** Default provider path segments (the admin-configured provider names). */
const DEFAULT_OPENAI_PROVIDER = "openai";
const DEFAULT_ANTHROPIC_PROVIDER = "anthropic";
/** Header that carries the Coder token to AI Gateway in bring-your-own-key mode. */
const CODER_TOKEN_HEADER = "X-Coder-AI-Governance-Token";

export interface CoderProviderSettings {
  /**
   * Base URL of your Coder deployment, e.g. `https://coder.example.com`. Do NOT
   * include the AI Gateway path (`/api/v2/aibridge/...`) — it is appended for you.
   */
  baseURL: string;
  /**
   * The credential sent to AI Gateway.
   *
   * - **Centralized mode (default):** your **Coder API token**. AI Gateway holds
   *   the upstream provider keys and brokers the call, so this is all you need.
   * - **BYOK mode** (when {@link CoderProviderSettings.coderToken} is also set):
   *   your **upstream provider key**, which AI Gateway forwards to the upstream.
   */
  apiKey?: string;
  /**
   * Enables bring-your-own-key (BYOK) mode. This Coder API token is sent in the
   * `X-Coder-AI-Governance-Token` header to authenticate you to the gateway,
   * while {@link CoderProviderSettings.apiKey} carries your upstream provider key.
   * Leave unset for the default centralized mode.
   */
  coderToken?: string;
  /** Extra headers merged into every request to both surfaces. */
  headers?: Record<string, string>;
  /**
   * Mount path of AI Gateway on the deployment. Defaults to `/api/v2/aibridge`.
   * Exposed because the `aibridge` path segment may change in a future Coder
   * release (the feature was renamed "AI Gateway").
   */
  aiGatewayPath?: string;
  /**
   * Override the provider path segments — the *admin-configured provider names*
   * on the deployment (e.g. `anthropic-corp`). Default to `openai` / `anthropic`.
   */
  providers?: {
    openai?: string;
    anthropic?: string;
  };
  /** Custom fetch implementation (useful for testing or middleware). */
  fetch?: typeof globalThis.fetch;
}

export interface CoderProvider {
  /** Route a model id to a surface by heuristic (Claude ids → Anthropic surface). */
  (modelId: string): LanguageModelV3;
  /** Route a model id to a surface by heuristic (Claude ids → Anthropic surface). */
  languageModel(modelId: string): LanguageModelV3;
  /**
   * AI Gateway's OpenAI-compatible surface (`/aibridge/openai/v1`). Reaches the
   * OpenAI / Azure / Google / OpenRouter / Vercel / openai-compat and Copilot
   * upstreams. Routing is by URL, so any model id sent here hits this surface.
   */
  openai: OpenAICompatibleProvider;
  /**
   * AI Gateway's Anthropic-compatible surface (`/aibridge/anthropic`). Reaches
   * native Claude and Bedrock-hosted Claude.
   */
  anthropic: AnthropicProvider;
  /** Shorthand for an {@link CoderProvider.openai} chat model. */
  chat(modelId: string): LanguageModelV3;
  /** Shorthand for an {@link CoderProvider.anthropic} messages model. */
  messages(modelId: string): LanguageModelV3;
  /** Text-embedding model via the OpenAI-compatible surface. */
  textEmbeddingModel(modelId: string): EmbeddingModelV3;
}

/**
 * Heuristic for the bare {@link CoderProvider} call: which AI Gateway surface
 * should a model id route to? Claude / Anthropic ids go to the Anthropic
 * surface; everything else to the OpenAI-compatible surface. Use the explicit
 * `.openai(id)` / `.anthropic(id)` accessors to override (e.g. to reach Claude
 * through a Copilot-typed provider on the OpenAI surface).
 */
export function isAnthropicModelId(modelId: string): boolean {
  return /^(?:claude|anthropic[./:])/i.test(modelId);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Create a {@link CoderProvider} that routes Vercel AI SDK calls through a Coder
 * deployment's AI Gateway (formerly "AI Bridge"). AI Gateway exposes two
 * provider-namespaced surfaces; this provider fronts both and selects between
 * them per model.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { createCoder } from "@coder/ai-sdk-provider";
 *
 * const coder = createCoder({
 *   baseURL: "https://coder.example.com",
 *   apiKey: process.env.CODER_API_TOKEN!,
 * });
 *
 * await generateText({ model: coder("gpt-4o"), prompt: "Hi" });                 // OpenAI surface
 * await generateText({ model: coder("claude-sonnet-4-6"), prompt: "Hi" }); // Anthropic surface
 * ```
 */
export function createCoder(settings: CoderProviderSettings): CoderProvider {
  if (!settings.baseURL) {
    throw new Error(
      "createCoder: `baseURL` is required (your Coder deployment URL, e.g. https://coder.example.com).",
    );
  }

  const deployment = trimTrailingSlash(settings.baseURL);
  const gatewayPath = settings.aiGatewayPath ?? DEFAULT_AI_GATEWAY_PATH;
  const openaiName = settings.providers?.openai ?? DEFAULT_OPENAI_PROVIDER;
  const anthropicName = settings.providers?.anthropic ?? DEFAULT_ANTHROPIC_PROVIDER;

  // Both sub-providers append their route to a baseURL that INCLUDES `/v1`:
  // openai-compatible POSTs `${baseURL}/chat/completions`, and @ai-sdk/anthropic
  // POSTs `${baseURL}/messages`. AI Gateway's intercepted routes are
  // `/aibridge/<name>/v1/chat/completions` and `/aibridge/<name>/v1/messages`.
  const openaiBaseURL = `${deployment}${gatewayPath}/${openaiName}/v1`;
  const anthropicBaseURL = `${deployment}${gatewayPath}/${anthropicName}/v1`;

  // BYOK mode: the Coder token authenticates via a dedicated header and `apiKey`
  // carries the upstream key. Centralized mode (default): `apiKey` is the Coder
  // token itself, sent in the standard provider auth header.
  const byok = settings.coderToken !== undefined;
  const headers: Record<string, string> = {
    ...(byok ? { [CODER_TOKEN_HEADER]: settings.coderToken as string } : {}),
    ...settings.headers,
  };

  const openai = createOpenAICompatible({
    name: "coder.openai",
    baseURL: openaiBaseURL,
    apiKey: settings.apiKey, // → `Authorization: Bearer <apiKey>`
    headers,
    fetch: settings.fetch,
    includeUsage: true,
  });

  const anthropic = createAnthropic({
    name: "coder.anthropic",
    baseURL: anthropicBaseURL,
    // Centralized: send the Coder token via `Authorization: Bearer` (the
    // documented path). BYOK: send the upstream key via `x-api-key`.
    ...(byok ? { apiKey: settings.apiKey } : { authToken: settings.apiKey }),
    headers,
    fetch: settings.fetch,
  });

  const languageModel = (modelId: string): LanguageModelV3 =>
    isAnthropicModelId(modelId) ? anthropic(modelId) : openai(modelId);

  return Object.assign(languageModel, {
    languageModel,
    openai,
    anthropic,
    chat: (modelId: string): LanguageModelV3 => openai(modelId),
    messages: (modelId: string): LanguageModelV3 => anthropic(modelId),
    textEmbeddingModel: (modelId: string): EmbeddingModelV3 => openai.textEmbeddingModel(modelId),
  });
}

/** Convenience alias mirroring other AI SDK providers' `createX` naming. */
export const coder = createCoder;
