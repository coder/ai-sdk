import {
  CoderChatClient,
  type CoderTransportEvent,
  type TransportEventHandler,
} from "@coder/ai-sdk-agent";
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as CoderAgentModel from "../../src/agent-model.js";

/**
 * Live checks of the Effect agent model against a real Coder deployment.
 *
 * Required env: CODER_URL, CODER_SESSION_TOKEN. Optional: CODER_ORG_ID,
 * CODER_MODEL (default "haiku"). Creates new chats only (no workspaces) and
 * archives them afterward.
 */
const baseUrl = process.env.CODER_URL;
const token = process.env.CODER_SESSION_TOKEN;
const ready = Boolean(baseUrl && token);
const suite = ready ? describe : describe.skip;

let organizationId: string;
const chats = new Set<string>();

/** Records every transport event and the chat ids they name. */
const recorder = (): {
  events: Array<CoderTransportEvent>;
  onTransportEvent: TransportEventHandler;
} => {
  const events: Array<CoderTransportEvent> = [];
  return {
    events,
    onTransportEvent: (event) => {
      events.push(event);
      if (event.type === "segment:start" || event.type === "segment:settle") {
        if (event.chatId) chats.add(event.chatId);
      }
    },
  };
};

beforeAll(async () => {
  if (!ready) return;
  organizationId = process.env.CODER_ORG_ID ?? "";
  if (!organizationId) {
    const response = await fetch(`${baseUrl}/api/v2/users/me`, {
      headers: { "Coder-Session-Token": token as string },
    });
    const me = (await response.json()) as { organization_ids: Array<string> };
    organizationId = me.organization_ids[0] as string;
  }
});

afterAll(async () => {
  if (!ready) return;
  const client = new CoderChatClient({ baseUrl: baseUrl as string, token: token as string });
  for (const id of chats) {
    // An interrupted run keeps winding down briefly; retry the archive.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await client.archiveChat(id);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}, 60_000);

suite("CoderAgentModel (live)", () => {
  const settings = (onTransportEvent: TransportEventHandler) => ({
    organizationId,
    model: process.env.CODER_MODEL ?? "haiku",
    onTransportEvent,
  });

  it("generates, then continues the same chat with per-call reasoning effort", async () => {
    const { events, onTransportEvent } = recorder();
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* LanguageModel.generateText({ prompt: "Reply with exactly: pong" });
        const b = yield* LanguageModel.generateText({
          prompt: "Reply with exactly the word you said before, in uppercase.",
        }).pipe(CoderAgentModel.withAgentOptions({ reasoningEffort: "low" }));
        return [a, b] as const;
      }).pipe(Effect.provide(CoderAgentModel.layer(settings(onTransportEvent)))),
    );

    expect(first.text.toLowerCase()).toContain("pong");
    expect(first.finishReason).toBe("stop");
    expect(second.text).toContain("PONG");
    const settled = events.filter((e) => e.type === "segment:settle");
    expect(settled).toHaveLength(2);
    expect(new Set(settled.map((e) => e.type === "segment:settle" && e.chatId)).size).toBe(1);
  }, 120_000);

  it("interrupts the chat exactly once when the stream fiber is interrupted", async () => {
    const { events, onTransportEvent } = recorder();
    await Effect.runPromise(
      Effect.gen(function* () {
        let deltas = 0;
        const fiber = yield* Effect.fork(
          Stream.runForEach(
            LanguageModel.streamText({
              prompt: "Count slowly from 1 to 300, one number per line, with no other text.",
            }),
            (part) =>
              Effect.sync(() => {
                if (part.type === "text-delta") deltas += 1;
              }),
          ),
        );
        // Wait until the answer is streaming, then interrupt mid-turn.
        yield* Effect.repeat(Effect.sleep("100 millis").pipe(Effect.map(() => deltas)), {
          until: (count) => count >= 3,
        }).pipe(Effect.timeout("60 seconds"));
        yield* Fiber.interrupt(fiber);
        yield* Effect.sleep("2 seconds");
      }).pipe(Effect.provide(CoderAgentModel.layer(settings(onTransportEvent)))),
    );

    const interrupts = events.filter((e) => e.type === "http:request" && e.op === "interruptChat");
    expect(interrupts).toHaveLength(1);
    expect(events.some((e) => e.type === "ws:close")).toBe(true);
  }, 120_000);
});
