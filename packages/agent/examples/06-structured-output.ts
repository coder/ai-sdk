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
import { stepCountIs, tool, type ToolSet } from "ai";
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

/** Per-request bound: no settle, interrupt, or archive attempt may hang the caller. */
const REQUEST_TIMEOUT_MS = 8_000;

/** An abort raised by `AbortSignal.timeout` (TimeoutError) or a manual abort. The
 * client propagates these raw; only non-2xx responses become CoderApiError. */
function isAborted(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Best-effort error → text in the AI SDK's spirit: strings pass through, Errors
 * give their message, other values JSON-stringify, with literal fallbacks for
 * values that resist serialization (circular objects, symbols, functions).
 * Total: always returns a string, never throws. */
function errorText(err: unknown): string {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    const json = JSON.stringify(err); // undefined for symbols/functions
    if (typeof json === "string") return json;
  } catch {
    // circular — fall through to String()
  }
  try {
    return String(err);
  } catch {
    return "unserializable thrown value";
  }
}

/** The slice of `CoderAgent` the helper reads (structural, so tests can fake it).
 * The turn shape is structural because the AI SDK types it per-ToolSet; the client
 * reuses the package's own method signatures so they cannot drift. */
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
      // The step's content parts: tool-result (execute succeeded) and tool-error
      // (execute threw) both carry the local outcome the settle must submit.
      content: Array<{ type: string; toolCallId?: string; output?: unknown; error?: unknown }>;
    }>;
  }>;
  readonly chatId: string | undefined;
  readonly client: Pick<CoderChatClient, "submitToolResults" | "interruptChat">;
};

function structuredOutput<T>(
  schema: z.ZodType<T>,
  opts: { maxSteps?: number; tools?: ToolSet } = {},
) {
  if (opts.tools && "structured_output" in opts.tools) {
    // Fail loudly instead of silently replacing the caller's tool with the ack tool.
    throw new Error(
      'structuredOutput: opts.tools must not define "structured_output" — the helper owns that name',
    );
  }
  return {
    // Spread into `new CoderAgent({ … })`. Compose additional client tools via
    // `opts.tools` (merged here) — do NOT also pass `tools:` to the constructor
    // next to the spread, or whichever comes later silently clobbers the other.
    // Deliberately NO `toolChoice` force (it is construction-time, so it would
    // re-force the tool on every segment after the ack) and NO `hasToolCall` stop
    // (ending the loop on the call strands the chat — see the settle in ask()).
    // The happy path is two steps: file + ack, wind down.
    agentOpts: {
      tools: {
        ...opts.tools,
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
        // the stranded step's locally-executed client outcomes directly: tool-result
        // parts as successes (for structured_output that is the ack), tool-error
        // parts as ERRORS — mirroring what the resume path would have sent. (Known
        // boundary: a tool's custom `toModelOutput` mapping is not applied here; the
        // raw execute() result is submitted.) `steps.at(-1)` is exactly the stranded
        // segment — earlier steps' calls were answered by their own resume segments.
        // Note: this direct submit bypasses the SDK's own submitted-ids bookkeeping,
        // so if you later continue the session by replaying `messages`, prefer a
        // fresh chat/session instead.
        const last = turn.steps.at(-1);
        const pending =
          turn.finishReason === "tool-calls"
            ? (last?.toolCalls ?? []).filter((c) => !c.providerExecuted)
            : [];
        const outcomes = new Map<string, { output: unknown; isError: boolean }>();
        for (const part of last?.content ?? []) {
          if (part.toolCallId === undefined) continue;
          if (part.type === "tool-result") {
            outcomes.set(part.toolCallId, { output: part.output ?? null, isError: false });
          } else if (part.type === "tool-error") {
            outcomes.set(part.toolCallId, { output: errorText(part.error), isError: true });
          }
        }
        const answerable = pending.filter((c) => outcomes.has(c.toolCallId));
        let settled = true;
        if (answerable.length > 0 && agent.chatId) {
          settled = await agent.client
            .submitToolResults(
              agent.chatId,
              {
                results: answerable.map((c) => {
                  const outcome = outcomes.get(c.toolCallId);
                  return {
                    tool_call_id: c.toolCallId,
                    output: outcome?.output ?? null,
                    is_error: outcome?.isError ?? false,
                  };
                }),
              },
              AbortSignal.timeout(REQUEST_TIMEOUT_MS), // a stalled settle must not wedge the caller
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
        // A pending call with no local outcome (e.g. an approval-gated call) cannot
        // be answered; same if the settle POST failed. Interrupt — bounded, against
        // the same possibly-stalled server — so the stranded turn ends and the chat
        // is safe to archive or reuse instead of wedged forever.
        if (pending.length > answerable.length) settled = false;
        if (!settled && agent.chatId) {
          await agent.client
            .interruptChat(agent.chatId, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
            .catch(() => {});
        }

        console.log(
          `  [ask] turn finished "${turn.finishReason}" after ${turn.steps.length} step(s)` +
            (pending.length > 0
              ? ` — settled ${answerable.length}/${pending.length} pending call(s)${settled ? "" : ", interrupted"}`
              : ""),
        );

        // READ. The answer is the tool call's INPUT. Scan every step, LAST VALID call
        // wins: a re-filed answer supersedes an earlier one, but a schema-invalid
        // re-file must not shadow a valid answer already in hand (deliberate tradeoff:
        // an invalid "correction" after a valid answer returns the earlier valid one
        // instead of burning the nudge). The server does NOT enforce the schema, so
        // safeParse is the real gate.
        const filed = turn.steps
          .flatMap((s) => s.toolCalls)
          .filter((c) => c.toolName === "structured_output");
        for (const call of filed.reverse()) {
          const parsed = schema.safeParse(call.input);
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

/** Cleanup that tolerates a chat still winding down. A settled (or interrupted)
 * turn resumes server-side for a few seconds, and archive() 409s until the chat
 * parks — so interrupt and retry under a deadline instead of giving up on the
 * first attempt (a bare `archive()` or `await using` would leak the chat here).
 * Every attempt carries an AbortSignal so a stalled request is truly cancelled
 * (not abandoned mid-flight), and the deadline is checked BEFORE each attempt so
 * the documented bound holds. Retries cover only the wind-down outcomes — a 409
 * or an aborted attempt; anything else (401/403/404) will not heal: warn, stop. */
async function archiveQuietly(agent: {
  readonly chatId: string | undefined;
  readonly client: Pick<CoderChatClient, "archiveChat" | "interruptChat">;
}): Promise<void> {
  if (!agent.chatId) return; // no chat was ever created
  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn("could not archive the chat before the deadline, leaving it:", lastErr);
      return;
    }
    try {
      await agent.client.archiveChat(
        agent.chatId,
        AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      );
      return;
    } catch (err) {
      lastErr = err;
      const stillWindingDown =
        isAborted(err) || (err instanceof CoderApiError && err.status === 409);
      if (!stillWindingDown) {
        console.warn("could not archive the chat, leaving it:", err);
        return;
      }
      // Out of budget: skip the doomed interrupt + sleep; the loop top reports.
      if (deadline - Date.now() <= 0) continue;
      await agent.client
        .interruptChat(
          agent.chatId,
          AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(deadline - Date.now(), 1))),
        )
        .catch(() => {}); // stop whatever is still running, then retry
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

const { baseUrl, token, organizationId, toolModel } = await loadEnv();

// Extra client tools would go into structuredOutput's opts: structuredOutput(
// TriageSchema, { tools: { myTool } }) — merged into one ToolSet with
// structured_output, and ask()'s settle answers them too on a stranded step.
const so = structuredOutput(TriageSchema);
const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId,
  // Tool-calling is more reliable on a stronger model; override with CODER_TOOL_MODEL.
  model: toolModel,
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
