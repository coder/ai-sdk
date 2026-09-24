/**
 * Error mapping between the AI SDK's provider errors and `@effect/ai`'s
 * `AiError` hierarchy.
 *
 * `@effect/ai`'s `AiError.AiError` is a *closed* union (`HttpRequestError |
 * HttpResponseError | MalformedInput | MalformedOutput | UnknownError`), and
 * `LanguageModel.make` implementations must fail with exactly those types.
 * This module therefore maps AI SDK errors *into* that union without losing
 * information (status code, headers, response body are preserved), and exposes
 * {@link classifyError} / {@link classifyStatus} to recover the Coder-oriented
 * failure taxonomy (auth, rate limit / quota, provider unavailable, malformed
 * response, ...) from either side — useful with `Effect.retry` policies.
 *
 * Coder Agents (`@coder/ai-sdk-agent`) errors map into the same union:
 * `CoderApiError` becomes an `HttpResponseError` carrying its status, while
 * `CoderStreamError` and `CoderChatError` keep the original error as `cause`
 * so that {@link isTransient} can honor their explicit retryable verdicts.
 */
import {
  AISDKError,
  APICallError,
  EmptyResponseBodyError,
  InvalidArgumentError,
  JSONParseError,
  NoSuchModelError,
  TypeValidationError,
} from "@ai-sdk/provider";
import {
  CoderAgentError,
  CoderApiError,
  CoderChatError,
  CoderStreamError,
} from "@coder/ai-sdk-agent";
import * as AiError from "@effect/ai/AiError";
import * as Option from "effect/Option";

/**
 * Coder-oriented classification of a gateway/model call failure.
 *
 * - `auth`: the credential was rejected (401/403) — Coder token or BYOK key.
 * - `rate-limit`: the gateway or upstream throttled or exhausted quota (402/429).
 * - `provider-unavailable`: the upstream or gateway failed server-side (5xx).
 * - `malformed-response`: the response could not be parsed or validated.
 * - `transport`: the request never produced an HTTP response (network error),
 *   or a Coder Agents chat stream dropped and could not be resumed.
 * - `timeout`: a Coder Agents turn exceeded its `requestTimeoutMs` budget
 *   (the agent interrupted the run server-side).
 * - `unknown`: anything else.
 */
export type ErrorReason =
  | "auth"
  | "rate-limit"
  | "provider-unavailable"
  | "malformed-response"
  | "transport"
  | "timeout"
  | "unknown";

/** Classify an HTTP status code into an {@link ErrorReason}. */
export const classifyStatus = (status: number): ErrorReason => {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "rate-limit";
  if (status >= 500) return "provider-unavailable";
  return "unknown";
};

/** Classify a chat-level failure reported by Coder Agents (chatd). */
const classifyChatError = (error: CoderChatError): ErrorReason => {
  if (error.kind === "timeout") return "timeout";
  // Raised by the agent when the chat stream closed before the turn settled.
  if (error.kind === "stream_closed") return "transport";
  if (error.statusCode !== undefined) return classifyStatus(error.statusCode);
  return "unknown";
};

/** A Coder Agents error that {@link toAiError} preserved as an `AiError`'s cause. */
const agentCause = (error: AiError.AiError): CoderChatError | CoderStreamError | undefined => {
  if (error._tag === "HttpResponseError") return undefined;
  const cause = error.cause;
  if (cause instanceof CoderChatError || cause instanceof CoderStreamError) return cause;
  return undefined;
};

const classifyAiError = (error: AiError.AiError): ErrorReason => {
  const cause = agentCause(error);
  if (cause instanceof CoderChatError) return classifyChatError(cause);
  switch (error._tag) {
    case "HttpResponseError":
      return error.reason === "StatusCode"
        ? classifyStatus(error.response.status)
        : "malformed-response";
    case "HttpRequestError":
      return "transport";
    case "MalformedOutput":
      return "malformed-response";
    case "MalformedInput":
    case "UnknownError":
      return "unknown";
  }
};

/** Errors accepted by {@link classifyError} and {@link isTransient}. */
export type ClassifiableError = AiError.AiError | AISDKError | CoderAgentError;

/**
 * Classify an error into an {@link ErrorReason}: either an `@effect/ai`
 * `AiError` produced by this bridge, or a raw AI SDK / Coder Agents error
 * (which is first mapped with {@link toAiError}).
 */
export const classifyError = (error: ClassifiableError): ErrorReason => {
  if (AiError.isAiError(error)) return classifyAiError(error);
  return classifyAiError(toAiError({ module: "CoderAiError", method: "classifyError", error }));
};

/**
 * The explicit retry verdict of a Coder Agents error, if the failure carries
 * one. `CoderStreamError.isRetryable` is downgraded to `false` by the agent
 * when replaying the prompt would duplicate server-side effects;
 * `CoderChatError.retryable` is chatd's (or the agent's) own verdict.
 */
const retryVerdict = (error: ClassifiableError): boolean | undefined => {
  const source = AiError.isAiError(error) ? agentCause(error) : error;
  if (source instanceof CoderStreamError) return source.isRetryable;
  if (source instanceof CoderChatError) return source.retryable;
  return undefined;
};

/**
 * Whether a failure is worth retrying. An explicit verdict carried by a
 * Coder Agents error wins; otherwise throttling, upstream outages, network
 * errors, and turn timeouts are transient, while auth and malformed-response
 * failures are terminal.
 */
export const isTransient = (error: ClassifiableError): boolean => {
  const verdict = retryVerdict(error);
  if (verdict !== undefined) return verdict;
  const reason = classifyError(error);
  return (
    reason === "rate-limit" ||
    reason === "provider-unavailable" ||
    reason === "transport" ||
    reason === "timeout"
  );
};

const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** `AiError` request details require a literal method; default to POST. */
const toHttpMethod = (method: string): HttpMethod => {
  const upper = method.toUpperCase();
  const match = HTTP_METHODS.find((m) => m === upper);
  return match ?? "POST";
};

const requestDetails = (url: string, method: string = "POST") => {
  const urlParams: Array<readonly [string, string]> = [];
  const headers: Record<string, string> = {};
  return {
    method: toHttpMethod(method),
    url,
    urlParams,
    hash: Option.none<string>(),
    headers,
  };
};

/**
 * Map an arbitrary error thrown by an AI SDK model call into `@effect/ai`'s
 * `AiError` union, preserving HTTP details where available.
 */
export const toAiError = (options: {
  readonly module: string;
  readonly method: string;
  readonly error: unknown;
}): AiError.AiError => {
  const { module, method, error } = options;
  if (AiError.isAiError(error)) return error;
  if (error instanceof CoderApiError) {
    return new AiError.HttpResponseError({
      module,
      method,
      reason: "StatusCode",
      request: requestDetails(error.path, error.method),
      response: { status: error.status, headers: {} },
      body: error.detail,
      description: `${error.message} (classified: ${classifyStatus(error.status)})`,
    });
  }
  if (error instanceof CoderChatError) {
    return new AiError.UnknownError({
      module,
      method,
      description: `${error.message} (classified: ${classifyChatError(error)})`,
      cause: error,
    });
  }
  // CoderStreamError is an APICallError without a status: it maps to a
  // Transport HttpRequestError below, keeping the error as `cause`.
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined) {
      return new AiError.HttpRequestError({
        module,
        method,
        reason: "Transport",
        request: requestDetails(error.url),
        description: error.message,
        cause: error,
      });
    }
    return new AiError.HttpResponseError({
      module,
      method,
      reason: "StatusCode",
      request: requestDetails(error.url),
      response: {
        status: error.statusCode,
        headers: error.responseHeaders ?? {},
      },
      body: error.responseBody,
      description: `${error.message} (classified: ${classifyStatus(error.statusCode)})`,
    });
  }
  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    EmptyResponseBodyError.isInstance(error)
  ) {
    return new AiError.MalformedOutput({
      module,
      method,
      description: error.message,
      cause: error,
    });
  }
  if (NoSuchModelError.isInstance(error) || InvalidArgumentError.isInstance(error)) {
    return new AiError.MalformedInput({
      module,
      method,
      description: error.message,
      cause: error,
    });
  }
  return new AiError.UnknownError({
    module,
    method,
    description: error instanceof Error ? error.message : String(error),
    cause: error,
  });
};
