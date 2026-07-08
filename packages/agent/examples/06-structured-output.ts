// Structured (typed) output from an agent run — the `structured_output` tool pattern.
//
// Coder Agents has no server-side `response_format`, so you cannot schema-constrain
// what the model SAYS. Tool inputs are the reliable channel instead: register a
// client-executed tool whose `inputSchema` IS your Zod schema and instruct the model
// to submit its final answer by CALLING it. The answer arrives as the tool call's
// typed `input` — no fishing JSON out of prose. (For pure text-in/JSON-out steps
// with no server-side tools, prefer @coder/ai-sdk-provider + generateObject.)
//
//   tsx examples/06-structured-output.ts   (or: pnpm example:structured)
import { stepCountIs, tool } from "ai";
import { z } from "zod";
import { CoderAgent, CoderApiError, type CoderChatClient } from "../src/index.js";
import { heading, loadEnv } from "./_shared.js";

// ── The helper (copy this into your project) ─────────────────────────────────
// Bind the schema ONCE: it becomes the tool's input schema AND the client-side
// parse gate, so the two can never drift apart.

/** The tool result the model sees after filing. Returning an ack — instead of
 * stopping the turn at the call — lets the turn complete naturally, so the model
 * can wind down anything it still has running (dev servers, watchers) first. */
const ACK =
  "Output received. You may now gracefully shut down anything you still have running, " +
  "then end your turn. Do not call structured_output again.";

const NUDGE =
  "You have not submitted a valid structured_output call for this request. Call the " +
  "structured_output tool now with your final answer as JSON matching the tool's input schema exactly.";

/** The slice of `CoderAgent` the helper reads (structural, so tests can fake it).
 * The turn shape is structural because the AI SDK types it per-ToolSet; the client
 * reuses the package's own signature so it cannot drift. */
type StructuredAgent = {
  generate(opts: { prompt: string }): Promise<{
    finishReason: string;
    steps: Array<{
      toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
        providerExecuted?: boolean;
      }>;
      toolResults: Array<{ toolCallId: string; output: unknown }>;
    }>;
  }>;
  readonly chatId: string | undefined;
  readonly client: Pick<CoderChatClient, "submitToolResults">;
  interrupt(): Promise<void>;
};

function structuredOutput<T>(schema: z.ZodType<T>, opts: { maxSteps?: number } = {}) {
  return {
    // Spread into `new CoderAgent({ … })`. Deliberately NO `toolChoice` force (it is
    // construction-time, so it would re-force the tool on every segment after the ack)
    // and NO `hasToolCall` stop (ending the loop on the call strands the chat — see
    // the settle step in ask()). The happy path is two steps: file + ack, wind down.
    agentOpts: {
      tools: {
        structured_output: tool({
          description:
            "Submit your final structured answer as JSON. Call this exactly once, when your work is complete.",
          inputSchema: schema,
          execute: async () => ACK,
        }),
      },
      stopWhen: stepCountIs(opts.maxSteps ?? 6),
    },

    /** Run one prompt and return the schema-validated answer. */
    async ask(agent: StructuredAgent, prompt: string): Promise<T> {
      for (const p of [prompt, NUDGE]) {
        const turn = await agent.generate({ prompt: p });

        // SETTLE. The server receives a client tool result only as a side effect of
        // the NEXT loop segment. If the loop stopped ON a tool-call segment (the
        // stopWhen ceiling landed there → finishReason "tool-calls"), the results ran
        // locally but never reached the server: the chat is stuck in
        // `requires_action` — new messages queue behind it, archive() 409s. Submit
        // the stranded step's locally-executed client results directly (for
        // structured_output that is the ack; any other client tool gets its real
        // result). `steps.at(-1)` is exactly the stranded segment — earlier steps'
        // calls were answered by their own resume segments. Note: this direct submit
        // bypasses the SDK's own submitted-ids bookkeeping, so if you later continue
        // the session by replaying `messages`, prefer a fresh chat/session instead.
        const last = turn.steps.at(-1);
        const pending =
          turn.finishReason === "tool-calls"
            ? (last?.toolCalls ?? []).filter((c) => !c.providerExecuted)
            : [];
        const localResults = new Map(
          (last?.toolResults ?? []).map((r) => [r.toolCallId, r.output]),
        );
        const answerable = pending.filter((c) => localResults.has(c.toolCallId));
        let settled = true;
        if (answerable.length > 0 && agent.chatId) {
          settled = await agent.client
            .submitToolResults(
              agent.chatId,
              {
                results: answerable.map((c) => ({
                  tool_call_id: c.toolCallId,
                  output: localResults.get(c.toolCallId) ?? null,
                  is_error: false,
                })),
              },
              AbortSignal.timeout(8_000), // a stalled settle must not wedge the caller
            )
            .then(
              () => true,
              (err) => {
                // Best-effort: a settle failure must never mask an answer we can read.
                console.warn("structured_output settle failed:", err);
                return false;
              },
            );
        }
        // A pending call with no local result (e.g. the SDK marked it invalid) cannot
        // be answered; same if the settle POST failed. Interrupt so the stranded turn
        // ends and the chat is safe to archive or reuse instead of wedged forever.
        if (pending.length > answerable.length) settled = false;
        if (!settled) await agent.interrupt().catch(() => {});

        console.log(
          `  [ask] turn finished "${turn.finishReason}" after ${turn.steps.length} step(s)` +
            (pending.length > 0
              ? ` — settled ${answerable.length}/${pending.length} pending call(s)${settled ? "" : ", interrupted"}`
              : ""),
        );

        // READ. The answer is the tool call's INPUT. Scan every step, last call wins
        // (a re-filed answer supersedes an earlier one). The server does NOT enforce
        // the schema, so safeParse is the real gate — schema-invalid calls the AI SDK
        // catches in-loop are already retried against a tool-error result automatically.
        const report = turn.steps
          .flatMap((s) => s.toolCalls)
          .findLast((c) => c.toolName === "structured_output")?.input;
        if (report !== undefined) {
          const parsed = schema.safeParse(report);
          if (parsed.success) return parsed.data;
        }

        // NUDGE — at most once, and only on an idle chat (the turn ended in prose,
        // finishReason "stop"). Never re-prompt a settled turn: its wind-down is still
        // running server-side, so the nudge would queue behind it — and contradict the
        // ack the model just received. Fail into your normal error handling instead
        // (an unsettled chat was interrupted above, so cleanup can archive it).
        if (turn.finishReason !== "stop" || !settled) {
          throw new Error(
            `no structured_output answer (turn finished: ${turn.finishReason}) — not re-prompting a busy chat`,
          );
        }
      }
      throw new Error("no valid structured_output call after one nudge");
    },
  };
}

/** Sentinel rejection used by {@link bounded} so callers can tell "attempt timed
 * out" (retryable — the server may just be busy) apart from a real API error. */
const TIMED_OUT = new Error("attempt timed out");

/** Race work against a per-attempt deadline. Both outcomes of `work` stay handled,
 * so a late loser can never become an unhandled rejection. */
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMED_OUT), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Cleanup that tolerates a chat still winding down. A settled (or interrupted)
 * turn resumes server-side for a few seconds, and archive() 409s until the chat
 * parks — so interrupt and retry under a deadline instead of giving up on the
 * first attempt (a bare `archive()` or `await using` would leak the chat here).
 * Retries cover only the wind-down outcomes: a 409, or a timed-out attempt.
 * Anything else (401/403/404, network down) will not heal — warn and stop. */
async function archiveQuietly(agent: {
  interrupt(): Promise<void>;
  archive(): Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await bounded(agent.archive(), 8_000);
      return;
    } catch (err) {
      const stillWindingDown =
        err === TIMED_OUT || (err instanceof CoderApiError && err.status === 409);
      if (!stillWindingDown || Date.now() > deadline) {
        console.warn("could not archive the chat, leaving it:", err);
        return;
      }
      await bounded(agent.interrupt(), 8_000).catch(() => {}); // stop whatever is still running, then retry
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

// ── Usage ─────────────────────────────────────────────────────────────────────

const TriageSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  component: z.string().describe("the subsystem at fault"),
  summary: z.string().describe("one-sentence diagnosis"),
  reproSteps: z.array(z.string()),
});

const BUG_REPORT = `
Since the 2.3.1 update, clicking "Export CSV" on the billing dashboard downloads
an empty file. The network tab shows /api/billing/export returning 200 with
content-length: 0. Logging out and back in does not help. Exports from the audit
page still work fine.
`;

const { baseUrl, token, organizationId } = await loadEnv();
// Tool-calling is more reliable on a stronger model; override with CODER_TOOL_MODEL.
// (`||`, not `??`: a set-but-empty env var should fall back too.)
const model = process.env.CODER_TOOL_MODEL || "sonnet";

const so = structuredOutput(TriageSchema);
const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  // Other client tools compose fine: ask()'s settle answers every pending client
  // call from its locally-executed result. Server-side tools are unaffected.
  instructions:
    "You triage bug reports. Submit your final answer by calling the structured_output tool exactly once.",
  // Bound each server segment so a wedged turn fails loudly instead of hanging.
  requestTimeoutMs: 120_000,
  ...so.agentOpts,
});

try {
  heading("structured output via the structured_output tool");
  const triage = await so.ask(agent, `Triage this bug report:\n${BUG_REPORT}`);

  // `triage` is fully typed: severity is "critical" | "major" | "minor", etc.
  console.log("Severity     :", triage.severity);
  console.log("Component    :", triage.component);
  console.log("Summary      :", triage.summary);
  console.log("Repro steps  :", triage.reproSteps.length > 0 ? triage.reproSteps : "(none given)");
  console.log("Chat id      :", agent.chatId);
} finally {
  await archiveQuietly(agent);
}
