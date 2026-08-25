import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import {
  type EmbeddingModelV4,
  InvalidArgumentError,
  type LanguageModelV4,
  NoSuchModelError,
} from "@ai-sdk/provider";

/** Default mount path of AI Gateway on a Coder deployment. */
const DEFAULT_AI_GATEWAY_PATH = "/api/v2/aibridge";
/** Default provider path segments (the admin-configured provider names). */
const DEFAULT_OPENAI_PROVIDER = "openai";
const DEFAULT_ANTHROPIC_PROVIDER = "anthropic";
/**
 * AI Gateway's provider-name grammar: lowercase alphanumeric segments
 * separated by single hyphens. Names outside this grammar can never be
 * registered on a deployment, so they are rejected client-side.
 */
const PROVIDER_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
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
  (modelId: string): LanguageModelV4;
  /** Route a model id to a surface by heuristic (Claude ids → Anthropic surface). */
  languageModel(modelId: string): LanguageModelV4;
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
  chat(modelId: string): LanguageModelV4;
  /** Shorthand for an {@link CoderProvider.anthropic} messages model. */
  messages(modelId: string): LanguageModelV4;
  /**
   * An OpenAI-compatible sub-provider bound to the *named* gateway provider
   * (`<aiGatewayPath>/<name>/v1`). Use it to reach admin-defined providers
   * beyond the default pair, e.g.
   * `coder.openaiProvider("azure-openai")("gpt-4o")`. Throws the AI SDK's
   * `InvalidArgumentError` when `name` does not match the gateway's
   * provider-name grammar (`^[a-z0-9]+(-[a-z0-9]+)*$`); a well-formed name
   * that is not configured on the deployment fails at request time with the
   * gateway's 404.
   */
  openaiProvider(name: string): OpenAICompatibleProvider;
  /**
   * An Anthropic-compatible sub-provider bound to the *named* gateway
   * provider, e.g. `coder.anthropicProvider("anthropic-bedrock")("claude-sonnet-4-6")`.
   * Same name validation as {@link CoderProvider.openaiProvider}.
   */
  anthropicProvider(name: string): AnthropicProvider;
  /**
   * Text embeddings are not supported: AI Gateway does not yet intercept
   * `/v1/embeddings`, so this always throws {@link NoSuchModelError} instead of
   * emitting a request that the gateway rejects with a 404. Tracked in
   * https://github.com/coder/ai-sdk/issues/69.
   */
  textEmbeddingModel(modelId: string): EmbeddingModelV4;
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
 * Fail fast at accessor time: AI Gateway intercepts only
 * `/v1/chat/completions`, `/v1/responses`, and `/v1/messages`, so an
 * embeddings request would always die with a 404 at request time.
 */
function unsupportedEmbeddingModel(modelId: string): EmbeddingModelV4 {
  throw new NoSuchModelError({
    modelId,
    modelType: "embeddingModel",
    message:
      `Coder AI Gateway does not yet intercept /v1/embeddings, so the ` +
      `embedding model "${modelId}" cannot be reached through it. ` +
      `See https://github.com/coder/ai-sdk/issues/69 for status.`,
  });
}

/**
 * Fail fast at accessor time: a name outside the gateway's provider-name
 * grammar can never be registered on a deployment, so a request to it would
 * always die with a confusing 404. Same philosophy as the embeddings guard
 * (https://github.com/coder/ai-sdk/issues/69).
 */
function assertValidProviderName(name: string): void {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new InvalidArgumentError({
      argument: "name",
      message:
        `Invalid AI Gateway provider name "${name}": provider names are ` +
        `lowercase alphanumeric segments separated by single hyphens ` +
        `(${PROVIDER_NAME_PATTERN}). Ask your Coder admins for the provider ` +
        `names configured on your deployment.`,
    });
  }
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

  // BYOK mode: the Coder token authenticates via a dedicated header and `apiKey`
  // carries the upstream key. Centralized mode (default): `apiKey` is the Coder
  // token itself, sent in the standard provider auth header.
  const byok = settings.coderToken !== undefined;
  const headers: Record<string, string> = {
    ...(byok ? { [CODER_TOKEN_HEADER]: settings.coderToken as string } : {}),
    ...settings.headers,
  };

  // Both sub-provider kinds append their route to a baseURL that INCLUDES `/v1`:
  // openai-compatible POSTs `${baseURL}/chat/completions`, and @ai-sdk/anthropic
  // POSTs `${baseURL}/messages`. AI Gateway's intercepted routes are
  // `/aibridge/<name>/v1/chat/completions` and `/aibridge/<name>/v1/messages`.
  const providerBaseURL = (name: string): string => `${deployment}${gatewayPath}/${name}/v1`;

  const openaiProvider = (name: string): OpenAICompatibleProvider => {
    assertValidProviderName(name);
    const provider = createOpenAICompatible({
      name: `coder.${name}`,
      baseURL: providerBaseURL(name),
      apiKey: settings.apiKey, // → `Authorization: Bearer <apiKey>`
      headers,
      fetch: settings.fetch,
      includeUsage: true,
    });
    // Sub-providers are public, so their embedding accessors must fail fast
    // too — otherwise they bypass the top-level guard and hit the gateway 404.
    provider.embeddingModel = unsupportedEmbeddingModel;
    provider.textEmbeddingModel = unsupportedEmbeddingModel;
    return provider;
  };

  const anthropicProvider = (name: string): AnthropicProvider => {
    assertValidProviderName(name);
    return createAnthropic({
      name: `coder.${name}`,
      baseURL: providerBaseURL(name),
      // Centralized: send the Coder token via `Authorization: Bearer` (the
      // documented path). BYOK: send the upstream key via `x-api-key`.
      ...(byok ? { apiKey: settings.apiKey } : { authToken: settings.apiKey }),
      headers,
      fetch: settings.fetch,
    });
  };

  // The default surfaces are ordinary named sub-providers — one code path.
  const openai = openaiProvider(settings.providers?.openai ?? DEFAULT_OPENAI_PROVIDER);
  const anthropic = anthropicProvider(settings.providers?.anthropic ?? DEFAULT_ANTHROPIC_PROVIDER);

  const languageModel = (modelId: string): LanguageModelV4 =>
    isAnthropicModelId(modelId) ? anthropic(modelId) : openai(modelId);

  return Object.assign(languageModel, {
    languageModel,
    openai,
    anthropic,
    chat: (modelId: string): LanguageModelV4 => openai(modelId),
    messages: (modelId: string): LanguageModelV4 => anthropic(modelId),
    openaiProvider,
    anthropicProvider,
    textEmbeddingModel: unsupportedEmbeddingModel,
  });
}

/** Convenience alias mirroring other AI SDK providers' `createX` naming. */
export const coder = createCoder;
