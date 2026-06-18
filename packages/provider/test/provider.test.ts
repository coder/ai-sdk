import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createCoder, isAnthropicModelId } from "../src/index.js";

interface CapturedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

/**
 * A fetch stub that records the outgoing request and then throws, so we can
 * assert the URL / headers / body the provider built without depending on the
 * upstream response schema. Generations are run with `maxRetries: 0` so each
 * trigger produces exactly one captured call.
 */
function capturingFetch(): { fetch: typeof globalThis.fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    let body: Record<string, unknown> | undefined;
    const raw = init?.body;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    calls.push({ url, headers, body });
    throw new Error("__captured__");
  };
  return { fetch, calls };
}

async function trigger(model: Parameters<typeof generateText>[0]["model"]): Promise<void> {
  await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow();
}

const BASE = "https://coder.example.com";
const TOKEN = "coder-api-token";

describe("isAnthropicModelId", () => {
  it("matches Claude / Anthropic ids", () => {
    expect(isAnthropicModelId("claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicModelId("claude-opus-4.5")).toBe(true);
    expect(isAnthropicModelId("anthropic.claude-3-5-sonnet")).toBe(true);
    expect(isAnthropicModelId("anthropic/claude-3")).toBe(true);
  });

  it("does not match OpenAI-style ids", () => {
    expect(isAnthropicModelId("gpt-4o")).toBe(false);
    expect(isAnthropicModelId("o3-mini")).toBe(false);
    expect(isAnthropicModelId("gemini-2.0-flash")).toBe(false);
  });
});

describe("createCoder routing", () => {
  it("routes a non-Claude id to the OpenAI surface, passing the id through unchanged", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder("gpt-4o"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/aibridge/openai/v1/chat/completions`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body?.model).toBe("gpt-4o");
  });

  it("routes a Claude id to the Anthropic surface, passing the id through unchanged", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder("claude-sonnet-4-6"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/aibridge/anthropic/v1/messages`);
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body?.model).toBe("claude-sonnet-4-6");
  });

  it("explicit .openai() forces the OpenAI surface even for a Claude id", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder.openai("claude-sonnet-4-6"));
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/aibridge/openai/v1/chat/completions`);
  });

  it("explicit .messages() uses the Anthropic surface", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder.messages("claude-opus-4-5"));
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/aibridge/anthropic/v1/messages`);
  });
});

describe("createCoder authentication", () => {
  it("centralized mode sends the Coder token as a Bearer token on the OpenAI surface", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder.openai("gpt-4o"));
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("centralized mode sends the Coder token as a Bearer token on the Anthropic surface", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: BASE, apiKey: TOKEN, fetch });
    await trigger(coder.anthropic("claude-sonnet-4-6"));
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("BYOK mode sends the upstream key and the Coder token in the governance header", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({
      baseURL: BASE,
      apiKey: "sk-real-anthropic-key",
      coderToken: TOKEN,
      fetch,
    });
    await trigger(coder.anthropic("claude-sonnet-4-6"));
    expect(calls[0]!.headers.get("x-api-key")).toBe("sk-real-anthropic-key");
    expect(calls[0]!.headers.get("x-coder-ai-governance-token")).toBe(TOKEN);
  });

  it("merges custom headers into requests", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({
      baseURL: BASE,
      apiKey: TOKEN,
      headers: { "X-Trace-Id": "abc123" },
      fetch,
    });
    await trigger(coder.openai("gpt-4o"));
    expect(calls[0]!.headers.get("x-trace-id")).toBe("abc123");
  });
});

describe("createCoder URL construction", () => {
  it("normalizes a trailing slash in baseURL", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({ baseURL: `${BASE}/`, apiKey: TOKEN, fetch });
    await trigger(coder.openai("gpt-4o"));
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/aibridge/openai/v1/chat/completions`);
  });

  it("honors a custom aiGatewayPath and provider names", async () => {
    const { fetch, calls } = capturingFetch();
    const coder = createCoder({
      baseURL: BASE,
      apiKey: TOKEN,
      aiGatewayPath: "/api/v2/ai-gateway",
      providers: { openai: "azure-openai", anthropic: "anthropic-corp" },
      fetch,
    });
    await trigger(coder.openai("gpt-4o"));
    expect(calls[0]!.url).toBe(`${BASE}/api/v2/ai-gateway/azure-openai/v1/chat/completions`);

    const second = capturingFetch();
    const coder2 = createCoder({
      baseURL: BASE,
      apiKey: TOKEN,
      aiGatewayPath: "/api/v2/ai-gateway",
      providers: { openai: "azure-openai", anthropic: "anthropic-corp" },
      fetch: second.fetch,
    });
    await trigger(coder2.anthropic("claude-sonnet-4-6"));
    expect(second.calls[0]!.url).toBe(`${BASE}/api/v2/ai-gateway/anthropic-corp/v1/messages`);
  });
});

describe("createCoder validation", () => {
  it("throws when baseURL is missing", () => {
    expect(() => createCoder({ baseURL: "", apiKey: TOKEN })).toThrow(/baseURL/);
  });
});
