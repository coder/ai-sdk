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
import { CoderAgent } from "../src/index.js";
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

/** The slice of `CoderAgent` the helper reads (structural, so tests can fake it). */
type StructuredAgent = {
  generate(opts: { prompt: string }): Promise<{
    finishReason: string;
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    steps: Array<{ toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> }>;
  }>;
  readonly chatId: string | undefined;
  readonly client: {
    submitToolResults(
      chatId: string,
      req: { results: Array<{ tool_call_id: string; output: unknown; is_error?: boolean }> },
      signal?: AbortSignal,
    ): Promise<void>;
  };
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
        // the NEXT loop segment. If the loop stopped ON the tool-call segment (the
        // stopWhen ceiling landed there → finishReason "tool-calls"), the ack ran
        // locally but never reached the server: the chat is stuck in
        // `requires_action` — new messages queue behind it, archive() 409s. Ack the
        // pending calls directly before touching the chat again. `turn.toolCalls` is
        // the FINAL step's calls (ai v6) — exactly the stranded segment; calls from
        // earlier steps were already answered by their own resume segments.
        let settled = true;
        const pending =
          turn.finishReason === "tool-calls"
            ? turn.toolCalls.filter((c) => c.toolName === "structured_output")
            : [];
        if (pending.length > 0 && agent.chatId) {
          settled = await agent.client
            .submitToolResults(
              agent.chatId,
              {
                results: pending.map((c) => ({
                  tool_call_id: c.toolCallId,
                  output: ACK,
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

        console.log(
          `  [ask] turn finished "${turn.finishReason}" after ${turn.steps.length} step(s)` +
            (pending.length > 0 ? ` — settled ${pending.length} pending call(s): ${settled}` : ""),
        );

        // READ. The answer is the tool call's INPUT. `turn.toolCalls` holds only the
        // LAST step's calls, so scan every step; the last call wins (a re-filed answer
        // supersedes an earlier one). The server does NOT enforce the schema, so
        // safeParse is the real gate — schema-invalid calls the AI SDK catches in-loop
        // are already retried against a tool-error result automatically.
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
        // ack the model just received. Fail into your normal error handling instead.
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

/** Cleanup that tolerates a chat still winding down. A settled (or interrupted)
 * turn resumes server-side for a few seconds, and archive() 409s until the chat
 * parks — so interrupt and retry under a deadline instead of giving up on the
 * first attempt (a bare `archive()` or `await using` would leak the chat here). */
async function archiveQuietly(agent: {
  interrupt(): Promise<void>;
  archive(): Promise<void>;
}): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await agent.archive();
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        console.warn("could not archive the chat, leaving it:", err);
        return;
      }
      await agent.interrupt().catch(() => {}); // stop whatever is still running, then retry
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
const model = process.env.CODER_TOOL_MODEL ?? "sonnet";

const so = structuredOutput(TriageSchema);
const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  model,
  // Keep structured_output the agent's only CLIENT-executed tool — ask()'s settle
  // covers just this tool's calls. Server-side tools (shell, MCP, …) are fine.
  instructions:
    "You triage bug reports. Submit your final answer by calling the structured_output tool exactly once.",
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
