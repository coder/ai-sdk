/**
 * `@coder/ai-sdk-provider` — a Vercel AI SDK provider that routes requests
 * through a Coder deployment's **AI Gateway** (formerly "AI Bridge"; the URL
 * path is still `aibridge`).
 *
 * AI Gateway exposes two provider-namespaced surfaces on a deployment — an
 * OpenAI-compatible one (`/api/v2/aibridge/openai/v1`) and an Anthropic-compatible
 * one (`/api/v2/aibridge/anthropic`). This provider fronts both and selects
 * between them per model id, authenticating with your Coder API token.
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
 * const { text } = await generateText({
 *   model: coder("claude-sonnet-4-6"),
 *   prompt: "What is Coder?",
 * });
 * ```
 */

export {
  coder,
  createCoder,
  type CoderProvider,
  type CoderProviderSettings,
  isAnthropicModelId,
} from "./provider.js";
