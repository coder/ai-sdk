/**
 * Wire types for Coder's experimental `chatd` chat API
 * (`/api/experimental/chats`). These mirror the Go types in
 * `coder/coder`'s `codersdk/chats.go` (JSON shapes), restricted to the subset
 * this client uses. Field names use snake_case to match the wire format.
 *
 * NOTE: The chatd API is experimental and may change between Coder releases.
 */

// ---------------------------------------------------------------------------
// Input (client -> server)
// ---------------------------------------------------------------------------

export type ChatInputPartType = "text" | "file" | "file-reference";

export interface ChatInputPart {
  type: ChatInputPartType;
  text?: string;
  file_id?: string;
  file_name?: string;
  start_line?: number;
  end_line?: number;
  content?: string;
}

export type ChatClientType = "ui" | "api";
export type ChatPlanMode = "" | "plan";
export type ChatBusyBehavior = "queue" | "interrupt";

/**
 * A client-executed ("dynamic") tool definition. chatd never executes these;
 * when the model calls one, the chat enters `requires_action` and the client
 * must execute it and submit results via {@link SubmitToolResultsRequest}.
 *
 * NOTE: the JSON key is `input_schema` (snake_case), per chatd.
 */
export interface DynamicTool {
  name: string;
  description?: string;
  /** A JSON Schema object describing the tool input. */
  input_schema: unknown;
}

export interface CreateChatRequest {
  organization_id: string;
  content: ChatInputPart[];
  system_prompt?: string;
  workspace_id?: string;
  model_config_id?: string;
  mcp_server_ids?: string[];
  labels?: Record<string, string>;
  unsafe_dynamic_tools?: DynamicTool[];
  plan_mode?: ChatPlanMode;
  client_type?: ChatClientType;
}

export interface CreateChatMessageRequest {
  content: ChatInputPart[];
  model_config_id?: string;
  mcp_server_ids?: string[];
  busy_behavior?: ChatBusyBehavior;
  plan_mode?: ChatPlanMode;
}

/** Result of a single client-executed tool call. */
export interface ToolResult {
  tool_call_id: string;
  /** JSON-serializable tool output. */
  output: unknown;
  is_error?: boolean;
}

export interface SubmitToolResultsRequest {
  results: ToolResult[];
}

export interface UpdateChatRequest {
  title?: string;
  archived?: boolean;
}

// ---------------------------------------------------------------------------
// Output (server -> client)
// ---------------------------------------------------------------------------

export type ChatStatus =
  | "waiting"
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "requires_action"
  | "interrupting";

export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

export type ChatMessagePartType =
  | "text"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "source"
  | "file"
  | "file-reference"
  | "context-file"
  | "skill";

/**
 * A part of a chat message. chatd models this as a single flat struct with a
 * `type` discriminator and many optional fields (see `codersdk.ChatMessagePart`),
 * so we mirror that shape rather than a strict discriminated union.
 */
export interface ChatMessagePart {
  type: ChatMessagePartType;

  // text / reasoning
  text?: string;
  signature?: string;

  // tool-call / tool-result
  tool_call_id?: string;
  tool_name?: string;
  mcp_server_config_id?: string | null;
  /** tool-call: complete arguments (JSON value). */
  args?: unknown;
  /** tool-call: incremental argument text chunk during streaming. */
  args_delta?: string;
  parsed_commands?: string[][];
  /** tool-result: complete result (JSON value). */
  result?: unknown;
  /** tool-result: incremental result text chunk during streaming. */
  result_delta?: string;
  result_reset?: boolean;
  is_error?: boolean;
  is_media?: boolean;
  provider_executed?: boolean;
  created_at?: string;
  completed_at?: string;

  // source
  source_id?: string;
  url?: string;
  title?: string;

  // file
  media_type?: string;
  name?: string;
  file_id?: string | null;

  // file-reference
  file_name?: string;
  start_line?: number;
  end_line?: number;
  content?: string;

  // skill
  skill_name?: string;
  skill_description?: string;
}

export interface ChatMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  context_limit?: number;
}

export interface ChatMessage {
  id: number;
  chat_id: string;
  created_by?: string;
  model_config_id?: string;
  created_at: string;
  role: ChatMessageRole;
  content?: ChatMessagePart[];
  usage?: ChatMessageUsage;
}

export interface ChatErrorPayload {
  message: string;
  detail?: string;
  kind?: string;
  provider?: string;
  retryable?: boolean;
  status_code?: number;
}

export interface Chat {
  id: string;
  organization_id: string;
  owner_id: string;
  owner_username?: string;
  workspace_id?: string | null;
  agent_id?: string | null;
  parent_chat_id?: string | null;
  root_chat_id?: string | null;
  last_model_config_id?: string;
  title: string;
  status: ChatStatus;
  plan_mode?: ChatPlanMode;
  last_error?: ChatErrorPayload | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  mcp_server_ids?: string[];
  client_type?: ChatClientType;
}

export interface ChatQueuedMessage {
  id: number;
  chat_id: string;
  content: ChatMessagePart[];
  created_at: string;
}

export interface CreateChatMessageResponse {
  message?: ChatMessage;
  queued_message?: ChatQueuedMessage;
  queued: boolean;
  warnings?: string[];
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
  queued_messages: ChatQueuedMessage[];
  has_more: boolean;
}

export interface ChatModelConfig {
  id: string;
  provider: string;
  ai_provider_id?: string;
  model: string;
  display_name: string;
  enabled?: boolean;
  is_default?: boolean;
  context_limit?: number;
  compression_threshold?: number;
}

// ---------------------------------------------------------------------------
// Stream events (WebSocket `/stream`)
// ---------------------------------------------------------------------------

export type ChatStreamEventType =
  | "message_part"
  | "message"
  | "status"
  | "error"
  | "queue_update"
  | "retry"
  | "action_required"
  | "preview_reset"
  | "history_reset";

export interface ChatStreamMessagePart {
  role?: ChatMessageRole;
  part: ChatMessagePart;
  history_version?: number;
  generation_attempt?: number;
  seq?: number;
}

export interface ChatStreamStatus {
  status: ChatStatus;
}

export interface ChatStreamToolCall {
  tool_call_id: string;
  tool_name: string;
  /** JSON string of the tool-call arguments. */
  args: string;
}

export interface ChatStreamActionRequired {
  tool_calls: ChatStreamToolCall[];
}

export interface ChatStreamRetry {
  attempt: number;
  delay_ms: number;
  error: string;
  kind?: string;
  provider?: string;
  status_code?: number;
  retrying_at: string;
}

export interface ChatStreamEvent {
  type: ChatStreamEventType;
  chat_id: string;
  message?: ChatMessage;
  message_part?: ChatStreamMessagePart;
  status?: ChatStreamStatus;
  error?: ChatErrorPayload;
  retry?: ChatStreamRetry;
  queued_messages?: ChatQueuedMessage[];
  action_required?: ChatStreamActionRequired;
}

/** Terminal statuses: the chat has stopped generating for this turn. */
export const TERMINAL_STATUSES: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "waiting",
  "completed",
  "error",
  "requires_action",
]);
