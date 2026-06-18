import type { ChatErrorPayload } from "./coder/types.js";

/** Base error for all `@coder/ai-sdk-agent` failures. */
export class CoderAgentError extends Error {
  override name = "CoderAgentError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** An HTTP request to the Coder API failed. */
export class CoderApiError extends CoderAgentError {
  override name = "CoderApiError";
  readonly status: number;
  readonly detail: string | undefined;
  readonly method: string;
  readonly path: string;
  constructor(args: {
    status: number;
    method: string;
    path: string;
    message: string;
    detail?: string;
  }) {
    super(
      `Coder API ${args.method} ${args.path} failed (${args.status}): ${args.message}` +
        (args.detail ? ` — ${args.detail}` : ""),
    );
    this.status = args.status;
    this.detail = args.detail;
    this.method = args.method;
    this.path = args.path;
  }
}

/** A chat generation ended in an error status. */
export class CoderChatError extends CoderAgentError {
  override name = "CoderChatError";
  readonly kind: string | undefined;
  readonly provider: string | undefined;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;
  constructor(payload: ChatErrorPayload) {
    super(payload.detail ? `${payload.message}: ${payload.detail}` : payload.message);
    this.kind = payload.kind;
    this.provider = payload.provider;
    this.retryable = payload.retryable ?? false;
    this.statusCode = payload.status_code;
  }
}
