import { APICallError, JSONParseError, TypeValidationError } from "@ai-sdk/provider";
import { CoderApiError, CoderChatError, CoderStreamError } from "@coder/ai-sdk-agent";
import * as AiError from "effect/ai/AiError";
import * as Duration from "effect/Duration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyError, classifyStatus, isTransient, toAiError } from "../src/errors.js";

const apiCallError = (statusCode?: number): APICallError =>
  new APICallError({
    message: `gateway failure${statusCode === undefined ? "" : ` (${statusCode})`}`,
    url: "https://coder.example.com/api/v2/aibridge/openai/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "x-request-id": "req_123" },
    responseBody: statusCode === undefined ? undefined : `{"error":"failure"}`,
  });

describe("classifyStatus", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "rate-limit"],
    [500, "provider-unavailable"],
    [502, "provider-unavailable"],
    [529, "provider-unavailable"],
    [404, "unknown"],
    [400, "unknown"],
  ] as const)("classifies %d as %s", (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });
});

describe("toAiError", () => {
  const map = (error: unknown): AiError.AiError =>
    toAiError({ module: "Test", method: "call", error });

  it("maps an HTTP status failure to its reason, preserving details", () => {
    const error = map(apiCallError(429));
    expect(error.module).toBe("Test");
    expect(error.method).toBe("call");
    const reason = error.reason as AiError.RateLimitError;
    expect(reason._tag).toBe("RateLimitError");
    expect(reason.http?.request.url).toContain("/chat/completions");
    expect(reason.http?.response).toEqual({ status: 429, headers: { "x-request-id": "req_123" } });
    expect(reason.http?.body).toBe(`{"error":"failure"}`);
    expect(reason.metadata).toEqual({
      coder: { classification: "rate-limit", status: 429, message: "gateway failure (429)" },
    });
  });

  it.each([
    [400, "InvalidRequestError"],
    [401, "AuthenticationError"],
    [402, "QuotaExhaustedError"],
    [403, "AuthenticationError"],
    [404, "UnknownError"],
    [503, "InternalProviderError"],
  ] as const)("maps HTTP %d to %s", (status, tag) => {
    expect(map(apiCallError(status)).reason._tag).toBe(tag);
  });

  it("maps HTTP 402 to QuotaExhaustedError, preserving details", () => {
    const error = map(apiCallError(402));
    const reason = error.reason as AiError.QuotaExhaustedError;
    expect(reason._tag).toBe("QuotaExhaustedError");
    expect(reason.isRetryable).toBe(false);
    expect(reason.http?.response).toEqual({ status: 402, headers: { "x-request-id": "req_123" } });
    expect(reason.http?.body).toBe(`{"error":"failure"}`);
    expect(reason.metadata).toEqual({
      coder: { classification: "quota", status: 402, message: "gateway failure (402)" },
    });
  });

  describe("RateLimitError.retryAfter", () => {
    const throttled = (headers: Record<string, string>): AiError.AiError =>
      map(
        new APICallError({
          message: "slow down",
          url: "https://coder.example.com/api/v2/aibridge/openai/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: headers,
        }),
      );
    const retryAfterMillis = (headers: Record<string, string>): number | undefined => {
      const { retryAfter } = throttled(headers);
      return retryAfter === undefined ? undefined : Duration.toMillis(retryAfter);
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reads delay-seconds from the retry-after header", () => {
      expect(retryAfterMillis({ "retry-after": "120" })).toBe(120_000);
    });

    it("reads an HTTP-date relative to now, with any header-name case", () => {
      vi.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") });
      expect(retryAfterMillis({ "Retry-After": "Mon, 12 Oct 2026 12:00:30 GMT" })).toBe(30_000);
    });

    it("treats an HTTP-date in the past as retry now", () => {
      vi.useFakeTimers({ now: Date.parse("2026-10-12T12:00:00Z") });
      expect(retryAfterMillis({ "retry-after": "Mon, 12 Oct 2026 11:00:00 GMT" })).toBe(0);
    });

    it.each([
      ["missing", {}],
      ["not a number or date", { "retry-after": "soon" }],
      ["fractional seconds", { "retry-after": "1.5" }],
      ["negative seconds", { "retry-after": "-5" }],
    ])("leaves retryAfter unset when the header is %s", (_label, headers) => {
      expect(retryAfterMillis(headers)).toBeUndefined();
    });
  });

  it("maps a network failure (no status) to NetworkError", () => {
    const reason = map(apiCallError(undefined)).reason as AiError.NetworkError;
    expect(reason._tag).toBe("NetworkError");
    expect(reason.reason).toBe("TransportError");
  });

  it("maps parse/validation failures to InvalidOutputError", () => {
    const parse = map(new JSONParseError({ text: "not json", cause: new Error("bad") }));
    expect(parse.reason._tag).toBe("InvalidOutputError");
    const validation = map(new TypeValidationError({ value: 1, cause: new Error("bad") }));
    expect(validation.reason._tag).toBe("InvalidOutputError");
  });

  it("passes an existing AiError through unchanged and wraps a bare reason", () => {
    const original = AiError.make({
      module: "Other",
      method: "call",
      reason: new AiError.InvalidRequestError({}),
    });
    expect(map(original)).toBe(original);
    const reason = new AiError.ContentPolicyError({ description: "blocked" });
    expect(map(reason).reason).toBe(reason);
  });

  it("maps anything else to UnknownError with the message", () => {
    const error = map(new Error("boom"));
    expect(error.reason._tag).toBe("UnknownError");
    expect(error.message).toContain("boom");
  });
});

describe("classifyError / isTransient", () => {
  it("classifies bridge-produced AiErrors back to the taxonomy", () => {
    const auth = toAiError({ module: "T", method: "m", error: apiCallError(401) });
    expect(classifyError(auth)).toBe("auth");
    expect(isTransient(auth)).toBe(false);

    const throttled = toAiError({ module: "T", method: "m", error: apiCallError(429) });
    expect(classifyError(throttled)).toBe("rate-limit");
    expect(isTransient(throttled)).toBe(true);

    const quota = toAiError({ module: "T", method: "m", error: apiCallError(402) });
    expect(classifyError(quota)).toBe("quota");
    expect(isTransient(quota)).toBe(false);

    const upstream = toAiError({ module: "T", method: "m", error: apiCallError(503) });
    expect(classifyError(upstream)).toBe("provider-unavailable");
    expect(isTransient(upstream)).toBe(true);

    const network = toAiError({ module: "T", method: "m", error: apiCallError(undefined) });
    expect(classifyError(network)).toBe("transport");
    expect(isTransient(network)).toBe(true);
  });

  it("classifies raw AI SDK errors directly (documented contract)", () => {
    expect(classifyError(apiCallError(403))).toBe("auth");
    expect(classifyError(apiCallError(429))).toBe("rate-limit");
    expect(classifyError(apiCallError(402))).toBe("quota");
    expect(classifyError(apiCallError(undefined))).toBe("transport");
    expect(classifyError(new JSONParseError({ text: "x", cause: new Error("y") }))).toBe(
      "malformed-response",
    );
    expect(isTransient(apiCallError(503))).toBe(true);
    expect(isTransient(apiCallError(401))).toBe(false);
    expect(isTransient(apiCallError(402))).toBe(false);
    expect(isTransient(apiCallError(429))).toBe(true);
  });

  it("classifies effect/ai's own quota and rate-limit reasons by tag", () => {
    const quota = AiError.make({
      module: "T",
      method: "m",
      reason: new AiError.QuotaExhaustedError({}),
    });
    expect(classifyError(quota)).toBe("quota");
    expect(isTransient(quota)).toBe(false);
    const throttled = AiError.make({
      module: "T",
      method: "m",
      reason: new AiError.RateLimitError({}),
    });
    expect(classifyError(throttled)).toBe("rate-limit");
    expect(isTransient(throttled)).toBe(true);
  });

  it("classifies malformed output as terminal", () => {
    const malformed = AiError.make({
      module: "T",
      method: "m",
      reason: new AiError.InvalidOutputError({ description: "bad" }),
    });
    expect(classifyError(malformed)).toBe("malformed-response");
    expect(isTransient(malformed)).toBe(false);
  });
});

describe("Coder Agents errors", () => {
  const map = (error: unknown): AiError.AiError =>
    toAiError({ module: "Test", method: "call", error });
  const streamError = (isRetryable: boolean) =>
    new CoderStreamError({
      message: "stream dropped",
      url: "https://coder.example.com/api/experimental/chats/c1/stream",
      isRetryable,
      chatId: "c1",
    });

  it("maps CoderApiError to a status reason with its request", () => {
    const error = map(
      new CoderApiError({
        status: 401,
        method: "POST",
        path: "/api/experimental/chats",
        message: "Unauthorized",
        detail: "token expired",
      }),
    );
    const reason = error.reason as AiError.AuthenticationError;
    expect(reason._tag).toBe("AuthenticationError");
    expect(reason.http?.response?.status).toBe(401);
    expect(reason.http?.request.method).toBe("POST");
    expect(reason.http?.request.url).toBe("/api/experimental/chats");
    expect(reason.http?.body).toBe("token expired");
    expect(classifyError(error)).toBe("auth");
    expect(isTransient(error)).toBe(false);
  });

  it.each([
    [402, "quota", false],
    [429, "rate-limit", true],
    [503, "provider-unavailable", true],
    [409, "unknown", false],
  ] as const)("classifies a CoderApiError %d as %s", (status, reason, transient) => {
    const raw = new CoderApiError({ status, method: "GET", path: "/p", message: "m" });
    expect(classifyError(raw)).toBe(reason);
    expect(isTransient(raw)).toBe(transient);
    expect(isTransient(map(raw))).toBe(transient);
  });

  it("honors CoderStreamError.isRetryable over the transport default", () => {
    for (const retryable of [true, false]) {
      const raw = streamError(retryable);
      const mapped = map(raw);
      const reason = mapped.reason as AiError.UnknownError;
      expect(reason._tag).toBe("UnknownError");
      expect(reason.metadata).toEqual({
        coder: { classification: "transport", retryable, chatId: "c1" },
      });
      expect(classifyError(mapped)).toBe("transport");
      expect(classifyError(raw)).toBe("transport");
      expect(isTransient(mapped)).toBe(retryable);
      expect(isTransient(raw)).toBe(retryable);
      expect(mapped.isRetryable).toBe(false);
    }
  });

  it("classifies a turn timeout as a retryable timeout", () => {
    const raw = new CoderChatError({ message: "too slow", kind: "timeout", retryable: true });
    const mapped = map(raw);
    const reason = mapped.reason as AiError.UnknownError;
    expect(reason._tag).toBe("UnknownError");
    expect(reason.metadata).toEqual({
      coder: { classification: "timeout", retryable: true, kind: "timeout" },
    });
    expect(classifyError(mapped)).toBe("timeout");
    expect(isTransient(mapped)).toBe(true);
  });

  it.each([
    [{ kind: "stream_closed", retryable: true }, "transport", true],
    [{ status_code: 429, retryable: true }, "rate-limit", true],
    [{ status_code: 402 }, "quota", false],
    [{ status_code: 503, retryable: false }, "provider-unavailable", false],
    [{ status_code: 401 }, "auth", false],
    [{ kind: "generic" }, "unknown", false],
  ] as const)(
    "classifies chat error %o as %s and follows its retryable flag",
    (payload, reason, transient) => {
      const raw = new CoderChatError({ message: "chat failed", ...payload });
      expect(classifyError(raw)).toBe(reason);
      expect(classifyError(map(raw))).toBe(reason);
      expect(isTransient(raw)).toBe(transient);
      expect(isTransient(map(raw))).toBe(transient);
      // Effect's own retry flag never invites a retry the verdict ruled out.
      if (!transient) expect(map(raw).isRetryable).toBe(false);
    },
  );

  it("keeps the chat error's status, kind, and provider in metadata", () => {
    const raw = new CoderChatError({
      message: "upstream failed",
      kind: "generic",
      provider: "anthropic",
      status_code: 529,
      retryable: true,
    });
    const reason = map(raw).reason as AiError.InternalProviderError;
    expect(reason._tag).toBe("InternalProviderError");
    expect(reason.metadata).toEqual({
      coder: {
        classification: "provider-unavailable",
        retryable: true,
        status: 529,
        kind: "generic",
        provider: "anthropic",
      },
    });
  });

  it("recognizes agent errors from another installed copy by name", () => {
    // Stand-ins for classes from a duplicate @coder/ai-sdk-agent install:
    // same names and fields, different class identity.
    class ForeignChatError extends Error {
      override name = "CoderChatError";
      readonly kind = "timeout";
      readonly retryable = true;
      readonly statusCode = undefined;
      readonly provider = undefined;
    }
    const chat = new ForeignChatError("too slow");
    expect(chat instanceof CoderChatError).toBe(false);
    expect(classifyError(map(chat))).toBe("timeout");
    expect(isTransient(map(chat))).toBe(true);

    const stream = new APICallError({
      message: "stream dropped",
      url: "https://coder.example.com/stream",
      requestBodyValues: undefined,
      isRetryable: false,
    });
    stream.name = "CoderStreamError";
    expect(isTransient(stream)).toBe(false);
    expect(isTransient(map(stream))).toBe(false);

    class ForeignApiError extends Error {
      override name = "CoderApiError";
      readonly status = 401;
      readonly method = "GET";
      readonly path = "/p";
      readonly detail = undefined;
    }
    expect(classifyError(map(new ForeignApiError("denied")))).toBe("auth");
  });
});
