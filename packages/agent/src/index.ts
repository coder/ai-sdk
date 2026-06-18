/**
 * `@coder/ai-sdk-agent` — a Vercel AI SDK-compliant agent for Coder `chatd`.
 *
 * @example
 * ```ts
 * import { CoderAgent } from "@coder/ai-sdk-agent";
 * import { tool } from "ai";
 * import { z } from "zod";
 *
 * const agent = new CoderAgent({
 *   baseUrl: "https://dev.coder.com",
 *   token: process.env.CODER_SESSION_TOKEN!,
 *   organizationId: "…",
 *   instructions: "You are a helpful assistant.",
 *   tools: {
 *     getWeather: tool({
 *       description: "Get the weather for a city",
 *       inputSchema: z.object({ city: z.string() }),
 *       execute: async ({ city }) => ({ city, tempC: 21 }),
 *     }),
 *   },
 * });
 *
 * const { text } = await agent.generate({ prompt: "What's the weather in Paris?" });
 * ```
 */

export { CoderAgent, type CoderAgentSettings } from "./agent/coder-agent.js";
export { CoderLanguageModel, type CoderLanguageModelConfig } from "./model/language-model.js";
export { CoderChatClient, type CoderChatClientOptions } from "./coder/client.js";
export { TurnTranslator } from "./model/translate.js";
export {
  classifyTurnAction,
  dynamicToolNames,
  extractSystemPrompt,
  toolsToDynamicTools,
  type TurnAction,
} from "./model/prompt.js";
export { streamChatEvents, type WebSocketFactory, type WebSocketLike } from "./coder/ws.js";
export { CoderAgentError, CoderApiError, CoderChatError } from "./errors.js";
export type * from "./coder/types.js";
