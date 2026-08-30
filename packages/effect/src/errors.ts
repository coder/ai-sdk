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
import * as AiError from "@effect/ai/AiError";
import * as Option from "effect/Option";

/**
 * Coder-oriented classification of a gateway/model call failure.
 *
 * - `auth`: the credential was rejected (401/403) — Coder token or BYOK key.
 * - `rate-limit`: the gateway or upstream throttled or exhausted quota (402/429).
 * - `provider-unavailable`: the upstream or gateway failed server-side (5xx).
 * - `malformed-response`: the response could not be parsed or validated.
 * - `transport`: the request never produced an HTTP response (network error).
 * - `unknown`: anything else.
 */
export type ErrorReason =
  | "auth"
  | "rate-limit"
  | "provider-unavailable"
  | "malformed-response"
  | "transport"
  | "unknown";

/** Classify an HTTP status code into an {@link ErrorReason}. */
export const classifyStatus = (status: number): ErrorReason => {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "rate-limit";
  if (status >= 500) return "provider-unavailable";
  return "unknown";
};

const classifyAiError = (error: AiError.AiError): ErrorReason => {
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

/**
 * Classify an error into an {@link ErrorReason}: either an `@effect/ai`
 * `AiError` produced by this bridge, or a raw AI SDK error (which is first
 * mapped with {@link toAiError}).
 */
export const classifyError = (error: AiError.AiError | AISDKError): ErrorReason => {
  if (AiError.isAiError(error)) return classifyAiError(error);
  return classifyAiError(toAiError({ module: "CoderAiError", method: "classifyError", error }));
};

/**
 * Whether a failure is worth retrying (throttling, upstream outage, or a
 * network error). Auth and malformed-response failures are terminal.
 */
export const isTransient = (error: AiError.AiError | AISDKError): boolean => {
  const reason = classifyError(error);
  return reason === "rate-limit" || reason === "provider-unavailable" || reason === "transport";
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
