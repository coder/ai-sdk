import { APICallError } from "@ai-sdk/provider";
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

/**
 * The per-chat event stream dropped and could not be re-established within its
 * redial budget. Extends the AI SDK's {@link APICallError} with
 * `isRetryable: true` because the `ai` package's retry machinery (`maxRetries`)
 * only honors `APICallError`/`GatewayError`-branded errors — plain `Error`
 * subclasses are never retried no matter what they claim. Note the retry
 * wrapper only sees errors that reject the model call itself (`generate()`);
 * a failure mid-`stream()` surfaces on the stream, past that wrapper. The last
 * underlying transport failure is preserved as `cause`.
 *
 * NOTE: this is deliberately NOT a {@link CoderAgentError} (single
 * inheritance); match it with `APICallError.isInstance(err)` or `err.name`.
 */
export class CoderStreamError extends APICallError {
  override name = "CoderStreamError";
  constructor(args: { message: string; url: string; cause?: unknown; isRetryable?: boolean }) {
    super({
      message: args.message,
      url: args.url,
      requestBodyValues: undefined,
      // Retries re-invoke the model with the SAME prompt, so the model layer
      // downgrades this to false whenever the failed chat has prior state a
      // re-submission would corrupt, or server-side tooling (workspace/MCP)
      // whose effects a replay would duplicate (see #runTurn).
      isRetryable: args.isRetryable ?? true,
      cause: args.cause,
    });
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
