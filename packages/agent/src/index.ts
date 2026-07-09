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

export { type ChatAttachment, CoderAgent, type CoderAgentSettings } from "./agent/coder-agent.js";
export { CoderLanguageModel, type CoderLanguageModelConfig } from "./model/language-model.js";
export {
  type ChatFileInput,
  CoderChatClient,
  type CoderChatClientOptions,
  type UploadedChatFile,
} from "./coder/client.js";
export {
  type FileContent,
  dataContentToFileContent,
  type ResolvedFile,
  resolveFileContent,
} from "./files.js";
export type { WorkspaceFileStore, WorkspacePlacement } from "./workspace-files.js";
export { TurnTranslator } from "./model/translate.js";
export {
  classifyTurnAction,
  CODER_PROVIDER_OPTIONS,
  type CoderFileProviderOptions,
  dynamicToolNames,
  extractSystemPrompt,
  type FilePartUploader,
  toolsToDynamicTools,
  type TurnAction,
  type UserContent,
  userContentToInputParts,
} from "./model/prompt.js";
export { streamChatEvents, type WebSocketFactory, type WebSocketLike } from "./coder/ws.js";
export { CoderAgentError, CoderApiError, CoderChatError } from "./errors.js";
// Runtime constants (the `export type *` below only re-exports types).
export { CHAT_ATTACHMENT_MEDIA_TYPES, MAX_CHAT_FILE_SIZE_BYTES } from "./coder/types.js";
export type * from "./coder/types.js";
export type {
  SharedWorkspacePreview,
  SharePreviewOptions,
  WorkspacePreview,
  WorkspacePreviewOptions,
} from "./agent/coder-agent.js";
export type { PreviewShareLevel } from "./coder/workspaces.js";
