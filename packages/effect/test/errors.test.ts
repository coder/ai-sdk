import { APICallError, JSONParseError, TypeValidationError } from "@ai-sdk/provider";
import { CoderApiError, CoderChatError, CoderStreamError } from "@coder/ai-sdk-agent";
import * as AiError from "@effect/ai/AiError";
import { describe, expect, it } from "vitest";
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
    [402, "rate-limit"],
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

  it("maps an HTTP status failure to HttpResponseError, preserving details", () => {
    const error = map(apiCallError(429));
    expect(error._tag).toBe("HttpResponseError");
    const response = error as AiError.HttpResponseError;
    expect(response.response.status).toBe(429);
    expect(response.response.headers).toEqual({ "x-request-id": "req_123" });
    expect(response.body).toBe(`{"error":"failure"}`);
    expect(response.description).toContain("classified: rate-limit");
    expect(response.module).toBe("Test");
    expect(response.method).toBe("call");
  });

  it("maps a network failure (no status) to HttpRequestError", () => {
    const error = map(apiCallError(undefined));
    expect(error._tag).toBe("HttpRequestError");
    expect((error as AiError.HttpRequestError).reason).toBe("Transport");
  });

  it("maps parse/validation failures to MalformedOutput", () => {
    const parse = map(new JSONParseError({ text: "not json", cause: new Error("bad") }));
    expect(parse._tag).toBe("MalformedOutput");
    const validation = map(new TypeValidationError({ value: 1, cause: new Error("bad") }));
    expect(validation._tag).toBe("MalformedOutput");
  });

  it("passes an existing AiError through unchanged", () => {
    const original = new AiError.MalformedInput({ module: "Test", method: "call" });
    expect(map(original)).toBe(original);
  });

  it("maps anything else to UnknownError with the cause attached", () => {
    const cause = new Error("boom");
    const error = map(cause);
    expect(error._tag).toBe("UnknownError");
    expect((error as AiError.UnknownError).cause).toBe(cause);
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
    expect(classifyError(apiCallError(undefined))).toBe("transport");
    expect(classifyError(new JSONParseError({ text: "x", cause: new Error("y") }))).toBe(
      "malformed-response",
    );
    expect(isTransient(apiCallError(503))).toBe(true);
    expect(isTransient(apiCallError(401))).toBe(false);
  });

  it("classifies malformed output as terminal", () => {
    const malformed = new AiError.MalformedOutput({ module: "T", method: "m" });
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

  it("maps CoderApiError to HttpResponseError with its status", () => {
    const error = map(
      new CoderApiError({
        status: 401,
        method: "POST",
        path: "/api/experimental/chats",
        message: "Unauthorized",
        detail: "token expired",
      }),
    );
    expect(error._tag).toBe("HttpResponseError");
    const response = error as AiError.HttpResponseError;
    expect(response.response.status).toBe(401);
    expect(response.request.method).toBe("POST");
    expect(response.request.url).toBe("/api/experimental/chats");
    expect(response.body).toBe("token expired");
    expect(classifyError(error)).toBe("auth");
    expect(isTransient(error)).toBe(false);
  });

  it.each([
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
      expect(mapped._tag).toBe("HttpRequestError");
      expect((mapped as AiError.HttpRequestError).cause).toBe(raw);
      expect(classifyError(mapped)).toBe("transport");
      expect(classifyError(raw)).toBe("transport");
      expect(isTransient(mapped)).toBe(retryable);
      expect(isTransient(raw)).toBe(retryable);
    }
  });

  it("classifies a turn timeout as a retryable timeout", () => {
    const raw = new CoderChatError({ message: "too slow", kind: "timeout", retryable: true });
    const mapped = map(raw);
    expect(mapped._tag).toBe("UnknownError");
    expect((mapped as AiError.UnknownError).cause).toBe(raw);
    expect(mapped.description).toContain("classified: timeout");
    expect(classifyError(mapped)).toBe("timeout");
    expect(isTransient(mapped)).toBe(true);
  });

  it.each([
    [{ kind: "stream_closed", retryable: true }, "transport", true],
    [{ status_code: 429, retryable: true }, "rate-limit", true],
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
    },
  );
});
