# Structured output from an agent run

Coder Agents has no server‑side `response_format`. `CoderAgent` cannot constrain
what the model **says** to a JSON schema: a `responseFormat` /
`experimental_output` request emits a warning and is best‑effort at most.

Pick by what the step needs:

| The step…                                                                       | Use                                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| is pure text‑in / JSON‑out, with no server‑side tools                           | [`@coder/ai-sdk-provider`](../../provider) with `generateObject` / `Output.object` — schema‑constrained; requires AI Gateway on the deployment |
| must produce its answer from an agent run (server‑side tools, MCP, a workspace) | the **`structured_output` tool pattern** below                                                                                                 |

## The `structured_output` tool pattern

What the model _says_ isn't schema‑constrained, but what it passes **into a
tool** is typed. So have it submit its answer by calling a tool whose
`inputSchema` is your Zod schema. The answer arrives as the tool call's typed
`input` — no fishing JSON out of prose.

```ts
import { CoderAgent } from "@coder/ai-sdk-agent";
import { stepCountIs, tool } from "ai";
import { z } from "zod";

const Answer = z.object({ severity: z.enum(["critical", "major", "minor"]), summary: z.string() });

const agent = new CoderAgent({
  organizationId: "your-org-uuid", // connection defaults to CODER_URL + CODER_SESSION_TOKEN
  instructions: "… Submit your final answer by calling the structured_output tool exactly once.",
  tools: {
    structured_output: tool({
      description:
        "Submit your final structured answer as JSON. Call this exactly once, when your work is complete.",
      inputSchema: Answer, // your schema IS the tool's input schema
      // Ack instead of stopping the turn: the model finishes naturally and can
      // wind down anything it still has running (dev servers, watchers, …).
      execute: async () =>
        "Output received. Wind down and end your turn. Do not call structured_output again.",
    }),
  },
  stopWhen: stepCountIs(6), // happy path is 2 steps: file + ack, wind down
});

const result = await agent.generate({ prompt: "…" });
// toolCalls only holds the LAST step's calls — scan all steps. Take the last call
// that VALIDATES: a schema-invalid re-file must not shadow a valid answer (rule 2).
const filed = result.steps
  .flatMap((s) => s.toolCalls)
  .filter((c) => c.toolName === "structured_output");
let answer: z.infer<typeof Answer> | undefined;
for (const call of filed.reverse()) {
  const parsed = Answer.safeParse(call.input);
  if (parsed.success) {
    answer = parsed.data; // typed: { severity: "critical" | "major" | "minor"; summary: string }
    break;
  }
}
if (answer === undefined)
  throw new Error("no valid structured_output call — nudge once on an idle chat (rule 3)");
```

## Rules that keep it robust

Each rule guards against a failure mode observed live.

### 1. Don't force `toolChoice`, and don't stop on the call

- **`toolChoice`** is construction‑time and applies to _every_ segment. After the
  ack it would force the tool again and again, up to the step ceiling. It also
  blocks any other tools the step needs.
- **A `hasToolCall` stop is worse.** The server only receives a client tool
  result as a side effect of the _next_ loop segment. Ending the loop on the
  call strands the chat in `requires_action`: follow‑up messages queue forever
  and `archive()` 409s.

Instructions plus the tool's own description are enough; models file unprompted
most of the time.

### 2. Validate client‑side

The schema is not enforced server‑side. `schema.safeParse` on the tool input is
the real gate. Schema‑invalid calls that the AI SDK catches in‑loop are
automatically answered with a `tool-error` result the model retries against.

### 3. Nudge at most once, and only an idle chat

If the turn ends in prose (`finishReason: "stop"`) without a valid call, send one
typed re‑prompt ("Call the structured_output tool now …"), then fail into your
normal error handling.

Never re‑prompt a chat that isn't idle: the message would queue behind whatever
the server is still doing.

### 4. Settle a turn that stopped on a tool call

If the loop stops on a tool‑call step — e.g. your `stopWhen` ceiling lands
exactly on the `structured_output` call (`finishReason: "tool-calls"`) — the tool
results ran locally but never reached the server. Settle the chat before touching
it again, or it strands as in rule 1:

1. Guard on `agent.chatId`. It is `undefined` until the first turn creates the
   chat.
2. Read the stranded step's (`result.steps.at(-1)`) locally‑executed client
   outcomes off its **content parts**:
   - a `tool-result` part is a success;
   - a `tool-error` part (the tool's `execute` threw) must be submitted with
     `is_error: true` — mirroring what the resume path would have sent.
3. Submit them directly:
   `agent.client.submitToolResults(chatId, { results: [{ tool_call_id, output, is_error }] }, AbortSignal.timeout(8_000))`.
4. If a pending call has no local outcome (or the submit fails), end the
   stranded turn instead with
   `agent.client.interruptChat(chatId, AbortSignal.timeout(8_000))`.

**Bound every one of these recovery requests with an `AbortSignal`.** They
target a server that may already be stalled, and the bare `agent.interrupt()` /
`agent.archive()` helpers carry no timeout.

A settled chat resumes its wind‑down server‑side for a few seconds. Retry a
409ing archive (`agent.client.archiveChat(chatId, signal)`, per‑attempt bound)
under a short deadline instead of giving up.

## Copyable helper

[`examples/06-structured-output.ts`](../examples/06-structured-output.ts)
packages all four rules into a small helper:

- `structuredOutput(schema)` returns `agentOpts` to spread into the constructor,
  plus a typed `ask(agent, prompt)` that runs the settle + one‑nudge ladder and
  returns a `z.infer<typeof schema>`.
- Compose additional client tools through the helper:
  `structuredOutput(schema, { tools: { myTool } })` merges them into one ToolSet.
  Don't pass `tools:` to the constructor next to the spread — the later key
  silently clobbers the other map.
