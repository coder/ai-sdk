import { tool } from "ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CoderAgent, CoderChatClient } from "../../src/index.js";

/**
 * Live end-to-end tests against a real Coder deployment.
 *
 * Required env: CODER_URL, CODER_SESSION_TOKEN. Optional: CODER_ORG_ID,
 * CODER_MODEL (default "haiku"), CODER_TOOL_MODEL (default "sonnet").
 *
 * These create NEW chats only (no workspaces) and archive them afterward.
 */
const baseUrl = process.env.CODER_URL;
const token = process.env.CODER_SESSION_TOKEN;
const ready = Boolean(baseUrl && token);

const suite = ready ? describe : describe.skip;

let client: CoderChatClient;
let organizationId: string;
const cleanup: string[] = [];

beforeAll(async () => {
  if (!ready) return;
  client = new CoderChatClient({ baseUrl: baseUrl as string, token: token as string });
  organizationId = process.env.CODER_ORG_ID ?? "";
  if (!organizationId) {
    const me = (await (
      await fetch(`${baseUrl}/api/v2/users/me`, { headers: { "Coder-Session-Token": token as string } })
    ).json()) as { organization_ids: string[] };
    organizationId = me.organization_ids[0] as string;
  }
});

afterEach(async () => {
  for (const id of cleanup.splice(0)) {
    try {
      await client.archiveChat(id);
    } catch {
      // Active chats (e.g. left in requires_action) can't be archived directly;
      // interrupt first, then archive. Best-effort.
      try {
        await client.interruptChat(id);
        await client.archiveChat(id);
      } catch {
        /* give up */
      }
    }
  }
});

suite("CoderAgent e2e (live Coder)", () => {
  it(
    "generates plain text",
    async () => {
      const agent = new CoderAgent({
        client,
        organizationId,
        model: process.env.CODER_MODEL ?? "haiku",
        instructions: "You are terse. Answer with a single word when possible.",
      });
      const result = await agent.generate({ prompt: "Reply with exactly the word: pong" });
      if (agent.chatId) cleanup.push(agent.chatId);

      expect(result.text.toLowerCase()).toContain("pong");
      expect(result.finishReason).toBe("stop");
      expect(result.steps.length).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );

  it(
    "streams text deltas",
    async () => {
      const agent = new CoderAgent({
        client,
        organizationId,
        model: process.env.CODER_MODEL ?? "haiku",
        instructions: "Be concise.",
      });
      const result = await agent.stream({ prompt: "Name three primary colors, comma-separated." });
      if (agent.chatId) cleanup.push(agent.chatId);

      let streamed = "";
      let chunks = 0;
      for await (const delta of result.textStream) {
        streamed += delta;
        chunks++;
      }
      expect(streamed.length).toBeGreaterThan(0);
      expect(await result.text).toBe(streamed);
      expect(chunks).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );

  it(
    "round-trips a custom (client-executed) tool",
    async () => {
      // A tool whose output the model cannot guess, forcing a real call.
      const calls: Array<{ topic: string }> = [];
      const agent = new CoderAgent({
        client,
        organizationId,
        model: process.env.CODER_TOOL_MODEL ?? "sonnet",
        instructions: "You must call the provided tools to look up information you do not already know.",
        tools: {
          lookup: tool({
            description: "Look up the secret value for a topic. You must call this; the value is not knowable otherwise.",
            inputSchema: z.object({ topic: z.string() }),
            execute: async (args) => {
              calls.push(args);
              return { value: `SECRET-${args.topic}-91` };
            },
          }),
        },
      });

      const result = await agent.generate({
        prompt: "Use the lookup tool with topic 'coder', then reply with exactly the value it returns.",
      });
      if (agent.chatId) cleanup.push(agent.chatId);

      // The custom tool actually executed locally with the model's args (round-trip worked).
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]?.topic).toBe("coder");
      // chatd resumed and produced a final answer using the (un-guessable) result.
      expect(result.text).toContain("SECRET-coder-91");
      expect(result.steps.length).toBeGreaterThanOrEqual(2);
      // The tool call is recorded in the AI SDK result (in the first step).
      expect(result.steps.flatMap((s) => s.toolCalls).some((c) => c.toolName === "lookup")).toBe(true);
    },
    180_000,
  );
});
