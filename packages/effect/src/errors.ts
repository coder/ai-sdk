/**
 * Error mapping between the AI SDK's provider errors and Effect 4's
 * `effect/ai` `AiError`.
 *
 * `AiError` is a single class whose `reason` is one of a closed set of tagged
 * reason classes (`AuthenticationError`, `RateLimitError`, `NetworkError`,
 * ...), and `LanguageModel.make` implementations must fail with it. This
 * module maps AI SDK and Coder Agents errors *into* that shape without losing
 * information: HTTP status, response headers and body travel in the reason's
 * `http` context, and the Coder-oriented classification plus any explicit
 * Coder Agents retry verdict travel in the reason's `metadata.coder` (see
 * {@link CoderErrorMetadata}). {@link classifyError} / {@link isTransient}
 * read them back, which is useful with `Effect.retry` policies.
 *
 * A reason's built-in `isRetryable` never says `true` where
 * {@link isTransient} says `false`, except for `InvalidOutputError` (Effect
 * treats malformed output as retryable; this bridge treats it as terminal).
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
import * as AiError from "effect/ai/AiError";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Coder-oriented classification of a gateway/model call failure.
 *
 * - `auth`: the credential was rejected (401/403) — Coder token or BYOK key.
 * - `rate-limit`: the gateway or upstream throttled the request (429).
 * - `quota`: the account's quota or billing limit is exhausted (402). Not
 *   transient: retrying cannot succeed until someone acts.
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
  | "quota"
  | "provider-unavailable"
  | "malformed-response"
  | "transport"
  | "timeout"
  | "unknown";

/**
 * What {@link toAiError} records under a reason's `metadata.coder`. Optional
 * keys are present only when the source error carried them:
 *
 * - `retryable`: the explicit retry verdict of a Coder Agents error.
 * - `status`: the HTTP status, also for failures without a request context.
 * - `kind` / `provider`: from `CoderChatError`.
 * - `chatId`: from `CoderStreamError`.
 * - `message`: the source error's message, on reasons without a
 *   `description` field (`RateLimitError`, `QuotaExhaustedError`).
 *
 * A `RateLimitError` also sets `retryAfter` from the response's
 * `Retry-After` header when it is valid.
 */
const CoderErrorMetadata = Schema.Struct({
  classification: Schema.Literals([
    "auth",
    "rate-limit",
    "quota",
    "provider-unavailable",
    "malformed-response",
    "transport",
    "timeout",
    "unknown",
  ]),
  retryable: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.Int),
  kind: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  chatId: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

/** The shape of a reason's `metadata.coder`; see `toAiError`. */
export type CoderErrorMetadata = typeof CoderErrorMetadata.Type;

const decodeCoderMetadata = Schema.decodeUnknownOption(CoderErrorMetadata);

/** Classify an HTTP status code into an {@link ErrorReason}. */
export const classifyStatus = (status: number): ErrorReason => {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
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

/**
 * Agent error guards. They also match by `name` (the agent package's
 * documented contract for `CoderStreamError`), so errors thrown by another
 * installed copy of `@coder/ai-sdk-agent` keep their retry verdicts.
 */
const isCoderApiError = (error: Error): error is CoderApiError =>
  error instanceof CoderApiError || error.name === "CoderApiError";
const isCoderChatError = (error: Error): error is CoderChatError =>
  error instanceof CoderChatError || error.name === "CoderChatError";
const isCoderStreamError = (error: Error): error is CoderStreamError =>
  error instanceof CoderStreamError ||
  (APICallError.isInstance(error) && error.name === "CoderStreamError");

/** The `metadata.coder` that {@link toAiError} recorded, if any. */
const coderMetadata = (error: AiError.AiError): Option.Option<CoderErrorMetadata> =>
  "metadata" in error.reason ? decodeCoderMetadata(error.reason.metadata.coder) : Option.none();

/** Classification of an `AiError` that carries no `metadata.coder`. */
const classifyReason = (reason: AiError.AiErrorReason): ErrorReason => {
  switch (reason._tag) {
    case "AuthenticationError":
      return "auth";
    case "RateLimitError":
      return "rate-limit";
    case "QuotaExhaustedError":
      return "quota";
    case "InternalProviderError":
      return "provider-unavailable";
    case "NetworkError":
      return "transport";
    case "InvalidOutputError":
    case "InvalidResponseError":
    case "StructuredOutputError":
      return "malformed-response";
  }
  const status = "http" in reason ? reason.http?.response?.status : undefined;
  return status === undefined ? "unknown" : classifyStatus(status);
};

/** Errors accepted by {@link classifyError} and {@link isTransient}. */
export type ClassifiableError = AiError.AiError | AISDKError | CoderAgentError;

const asAiError = (error: ClassifiableError): AiError.AiError =>
  AiError.isAiError(error)
    ? error
    : toAiError({ module: "CoderAiError", method: "classifyError", error });

/**
 * Classify an error into an {@link ErrorReason}: either an `AiError` (from
 * this bridge or from `effect/ai` itself), or a raw AI SDK / Coder Agents
 * error (which is first mapped with {@link toAiError}).
 */
export const classifyError = (error: ClassifiableError): ErrorReason => {
  const aiError = asAiError(error);
  return Option.match(coderMetadata(aiError), {
    onNone: () => classifyReason(aiError.reason),
    onSome: (coder) => coder.classification,
  });
};

/**
 * Whether a failure is worth retrying. An explicit verdict carried by a
 * Coder Agents error wins (`CoderStreamError.isRetryable` is downgraded to
 * `false` by the agent when replaying the prompt would duplicate server-side
 * effects; `CoderChatError.retryable` is chatd's own verdict). Otherwise
 * throttling, upstream outages, network errors, and turn timeouts are
 * transient, while auth, exhausted quota, and malformed-response failures
 * are terminal.
 */
export const isTransient = (error: ClassifiableError): boolean => {
  const verdict = Option.getOrUndefined(coderMetadata(asAiError(error)))?.retryable;
  if (verdict !== undefined) return verdict;
  const reason = classifyError(error);
  return (
    reason === "rate-limit" ||
    reason === "provider-unavailable" ||
    reason === "transport" ||
    reason === "timeout"
  );
};

type HttpContext = typeof AiError.HttpContext.Type;
type HttpMethod = HttpContext["request"]["method"];
const HTTP_METHODS: ReadonlyArray<HttpMethod> = [
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "QUERY",
];

const httpContext = (options: {
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): HttpContext => {
  const upper = (options.method ?? "POST").toUpperCase();
  const { status } = options;
  return {
    // `HttpRequestDetails` requires a literal method; default to POST.
    request: {
      method: HTTP_METHODS.find((m) => m === upper) ?? "POST",
      url: options.url,
      urlParams: [],
      headers: {},
    },
    response: status === undefined ? undefined : { status, headers: options.headers ?? {} },
    body: options.body,
  };
};

const DELAY_SECONDS = /^\d+$/;
// IMF-fixdate, the HTTP-date form senders must use (RFC 9110 §5.6.7).
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * The `Retry-After` header (RFC 9110 §10.2.3): delay-seconds, or an
 * HTTP-date. A date in the past means retry now. Any other value is ignored.
 */
const parseRetryAfter = (
  headers: Record<string, string> | undefined,
): Duration.Duration | undefined => {
  const name = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === "retry-after");
  const value = name === undefined ? undefined : headers?.[name]?.trim();
  if (value === undefined) return undefined;
  if (DELAY_SECONDS.test(value)) return Duration.seconds(Number(value));
  if (!IMF_FIXDATE.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Duration.millis(Math.max(0, at - Date.now()));
};

/**
 * The reason class for a classification. A `false` Coder Agents verdict on a
 * reason that Effect considers retryable downgrades it to `UnknownError`, so
 * `isRetryable` never invites a retry the agent ruled out.
 */
const reasonFor = (
  coder: CoderErrorMetadata,
  description: string,
  http: HttpContext | undefined,
  retryAfter?: Duration.Duration,
): AiError.AiErrorReason => {
  const common = { description, http, metadata: { coder: { ...coder } } };
  let reason: AiError.AiErrorReason;
  switch (coder.classification) {
    case "auth":
      reason = new AiError.AuthenticationError({
        ...common,
        kind: coder.status === 403 ? "InsufficientPermissions" : "InvalidKey",
      });
      break;
    case "rate-limit":
      reason = new AiError.RateLimitError({
        http,
        retryAfter,
        metadata: { coder: { ...coder, message: description } },
      });
      break;
    case "quota":
      reason = new AiError.QuotaExhaustedError({
        http,
        metadata: { coder: { ...coder, message: description } },
      });
      break;
    case "provider-unavailable":
      reason = new AiError.InternalProviderError(common);
      break;
    default:
      reason =
        coder.status === 400
          ? new AiError.InvalidRequestError(common)
          : new AiError.UnknownError(common);
  }
  if (coder.retryable === false && reason.isRetryable) {
    return new AiError.UnknownError(common);
  }
  return reason;
};

type MutableMetadata = { -readonly [K in keyof CoderErrorMetadata]: CoderErrorMetadata[K] };

/** The chat error's metadata, with only the keys it carries (plain JSON). */
const chatMetadata = (error: CoderChatError): CoderErrorMetadata => {
  const coder: MutableMetadata = {
    classification: classifyChatError(error),
    retryable: error.retryable,
  };
  if (error.statusCode !== undefined) coder.status = error.statusCode;
  if (error.kind !== undefined) coder.kind = error.kind;
  if (error.provider !== undefined) coder.provider = error.provider;
  return coder;
};

const toReason = (error: Error): AiError.AiErrorReason => {
  if (isCoderApiError(error)) {
    const classification = classifyStatus(error.status);
    const http = httpContext({
      url: error.path,
      method: error.method,
      status: error.status,
      body: error.detail,
    });
    return reasonFor({ classification, status: error.status }, error.message, http);
  }
  if (isCoderChatError(error)) {
    return reasonFor(chatMetadata(error), error.message, undefined);
  }
  if (isCoderStreamError(error)) {
    const coder: MutableMetadata = { classification: "transport", retryable: error.isRetryable };
    if (error.chatId !== undefined) coder.chatId = error.chatId;
    return new AiError.UnknownError({
      description: error.message,
      http: httpContext({ url: error.url }),
      metadata: { coder: { ...coder } },
    });
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === undefined) {
      return new AiError.NetworkError({
        reason: "TransportError",
        request: httpContext({ url: error.url }).request,
        description: error.message,
      });
    }
    const http = httpContext({
      url: error.url,
      status: error.statusCode,
      headers: error.responseHeaders,
      body: error.responseBody,
    });
    const classification = classifyStatus(error.statusCode);
    return reasonFor(
      { classification, status: error.statusCode },
      error.message,
      http,
      parseRetryAfter(error.responseHeaders),
    );
  }
  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    EmptyResponseBodyError.isInstance(error)
  ) {
    return new AiError.InvalidOutputError({ description: error.message });
  }
  if (InvalidArgumentError.isInstance(error)) {
    return new AiError.InvalidRequestError({
      parameter: error.argument,
      description: error.message,
    });
  }
  if (NoSuchModelError.isInstance(error)) {
    return new AiError.InvalidRequestError({ parameter: "modelId", description: error.message });
  }
  return new AiError.UnknownError({ description: error.message });
};

/**
 * Map an arbitrary error thrown by an AI SDK model call into an `AiError`,
 * preserving HTTP details and Coder Agents verdicts (see the module docs).
 * An existing `AiError` passes through unchanged; a bare `AiError` reason is
 * wrapped with the given `module` and `method`.
 */
export const toAiError = (options: {
  readonly module: string;
  readonly method: string;
  readonly error: unknown;
}): AiError.AiError => {
  const { module, method, error } = options;
  if (AiError.isAiError(error)) return error;
  let reason: AiError.AiErrorReason;
  if (AiError.isAiErrorReason(error)) {
    reason = error;
  } else if (error instanceof Error) {
    reason = toReason(error);
  } else {
    reason = new AiError.UnknownError({ description: String(error) });
  }
  return AiError.make({ module, method, reason });
};
