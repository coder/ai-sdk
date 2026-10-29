/**
 * Bounded exhaustive check: a turn's streamed content reaches the AI SDK
 * exactly once, whatever chatd and the network do within the bounds below.
 *
 * Each run drives the REAL client path — `CoderLanguageModel.doStream` over a
 * real `CoderChatClient`, its `streamChatEvents` reader (src/coder/ws.ts),
 * and `TurnTranslator` (src/model/translate.ts) — against the chatd model in
 * `chatd-world.ts`, through a scripted WebSocket. At every point where chatd
 * or the network can do more than one thing, the harness asks the explorer,
 * which enumerates every combination (see `explore.ts`):
 *
 * - when the next connection's initial sync happens, relative to the turn;
 * - whether chatd forwards a preview part before the attempt ends (chatd
 *   drops parts that it has not forwarded yet, `stream_loop.go` `part`);
 * - after which frame a connection drops (close 1006) or fails its
 *   handshake, up to `maxDrops` times.
 *
 * Properties, checked at the end of every run:
 *
 * - Completes: the stream ends with one `finish` (reason "stop"), no
 *   `error`, after chatd settled the turn.
 * - TextExactlyOnce / ReasoningExactlyOnce: the concatenated deltas equal
 *   the committed assistant text (or reasoning) of the turn, in message order.
 * - UsageOnce: `finish` output tokens equal the sum over the turn's committed
 *   assistant messages (latest revision).
 * - NoInterrupt: the client never interrupts the healthy server run.
 *
 * Run: `.agents/skills/verify-agent-stream-exactly-once/check.sh` from the
 * repository root. The skill explains how to read the result.
 */
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoderChatClient } from "../../src/coder/client.js";
import type { Chat, ChatStreamEvent } from "../../src/coder/types.js";
import type { WebSocketFactory, WebSocketLike } from "../../src/coder/ws.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import {
  CHAT_ID,
  ChatdWorld,
  type Frame,
  frameData,
  type StepSpec,
  type TurnStart,
  type WorldEvent,
} from "./chatd-world.js";
import { type Chooser, exploreAll } from "./explore.js";

type PropertyName =
  | "Completes"
  | "TextExactlyOnce"
  | "ReasoningExactlyOnce"
  | "UsageOnce"
  | "NoInterrupt";

interface Scenario {
  name: string;
  start: TurnStart;
  steps: StepSpec[];
  timeline: WorldEvent[];
  maxDrops: number;
  /** Fails the check when the bounds produce more runs than this. */
  maxRuns: number;
  /**
   * A violation that the current code has. The check fails if the scenario
   * shows a property outside `properties`, or no violation at all (then the
   * finding is fixed: move the scenario to the passing list).
   */
  knownFinding?: { id: string; properties: PropertyName[] };
}

const text = (t: string) => ({ kind: "text" as const, text: t });
const reasoning = (t: string) => ({ kind: "reasoning" as const, text: t });
const part: WorldEvent = { kind: "part" };
const commit: WorldEvent = { kind: "commit" };
const retry: WorldEvent = { kind: "retry" };
const settle: WorldEvent = { kind: "settle" };

/**
 * The bounds. Every part text is a distinct letter, so a duplicate, a gap, or
 * a misordering shows in the concatenated deltas.
 */
const SCENARIOS: Scenario[] = [
  {
    name: "one step, two text parts, new chat",
    start: "new-chat",
    steps: [{ parts: [text("a"), text("b")], outputTokens: 1 }],
    timeline: [part, part, commit, settle],
    maxDrops: 2,
    maxRuns: 20_000,
  },
  {
    name: "two steps, reasoning then text, follow-up turn",
    start: "follow-up",
    steps: [
      { parts: [reasoning("p"), text("a"), text("b")], outputTokens: 1 },
      { parts: [text("c"), text("d")], outputTokens: 10 },
    ],
    timeline: [part, part, part, commit, part, part, commit, settle],
    maxDrops: 2,
    maxRuns: 100_000,
  },
  {
    name: "step 1 revised (text appended, usage changed) before step 2 starts",
    start: "new-chat",
    steps: [
      { parts: [text("a"), text("b")], outputTokens: 1 },
      { parts: [text("c")], outputTokens: 10 },
    ],
    timeline: [
      part,
      part,
      commit,
      { kind: "revise", step: 0, appendText: "e", outputTokens: 2 },
      part,
      commit,
      settle,
    ],
    maxDrops: 2,
    maxRuns: 40_000,
  },
  {
    name: "attempt fails after a partial stream and chatd retries it",
    start: "new-chat",
    steps: [{ parts: [text("a"), text("b")], outputTokens: 1 }],
    timeline: [part, retry, part, part, commit, settle],
    maxDrops: 1,
    maxRuns: 20_000,
    knownFinding: { id: "restart-keeps-abandoned-deltas", properties: ["TextExactlyOnce"] },
  },
  {
    name: "step 1 revised while step 2 streams, so chatd restarts step 2",
    start: "new-chat",
    steps: [
      { parts: [text("a"), text("b")], outputTokens: 1 },
      { parts: [text("c"), text("d")], outputTokens: 10 },
    ],
    timeline: [
      part,
      part,
      commit,
      part,
      { kind: "revise", step: 0, appendText: "e", outputTokens: 2 },
      part,
      part,
      commit,
      settle,
    ],
    maxDrops: 1,
    maxRuns: 40_000,
    knownFinding: { id: "restart-keeps-abandoned-deltas", properties: ["TextExactlyOnce"] },
  },
];

type Listener = (ev: unknown) => void;

/** A scripted WebSocket: the harness decides when it connects, what it delivers, and when it drops. */
class ScriptedSocket {
  readonly url: string;
  closedByClient = false;
  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
  }
  send(_data: string): void {}
  close(_code?: number): void {
    this.closedByClient = true;
  }
  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }
  emit(type: "open" | "message" | "error" | "close", ev?: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(ev);
  }
}

function chatStub(): Chat {
  return {
    id: CHAT_ID,
    organization_id: "org-1",
    owner_id: "u",
    title: "t",
    status: "running",
    created_at: "",
    updated_at: "",
    archived: false,
  };
}

function fakeFetch(world: ChatdWorld, calls: string[]): typeof globalThis.fetch {
  return ((url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method} ${pathname}`);
    let body: unknown = chatStub();
    if (init.method === "POST" && pathname.endsWith(`/${CHAT_ID}/messages`)) {
      body = {
        queued: false,
        message: {
          id: world.promptId,
          chat_id: CHAT_ID,
          role: "user",
          created_at: "",
          content: [{ type: "text", text: "hi" }],
        },
      };
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
}

/** Runs every microtask, then every timer that is due now, three times over. */
async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.advanceTimersByTime(0);
  }
}

interface RunOutcome {
  parts: LanguageModelV4StreamPart[];
  consumerError: unknown;
  finished: boolean;
  fetchCalls: string[];
  world: ChatdWorld;
  trace: string[];
}

function describeEvent(ev: ChatStreamEvent): string {
  switch (ev.type) {
    case "message_part": {
      const mp = ev.message_part;
      return `${mp?.part.type} part "${mp?.part.text}" (history ${mp?.history_version}, attempt ${mp?.generation_attempt}, seq ${mp?.seq})`;
    }
    case "message": {
      const m = ev.message;
      const body = (m?.content ?? []).map((p) => p.text ?? "").join("");
      return `message ${m?.id} ${m?.role} "${body}"`;
    }
    case "status":
      return `status ${ev.status?.status}`;
    default:
      return ev.type;
  }
}

function describeFrame(frame: Frame): string {
  return frame.events.map(describeEvent).join(", ");
}

function describeWorld(ev: WorldEvent): string {
  switch (ev.kind) {
    case "part":
      return "chatd streams the next part of the current step";
    case "commit":
      return "chatd commits the current step as an assistant message";
    case "retry":
      return "the provider call fails with a retryable error; chatd retires the attempt";
    case "revise":
      return `chatd revises step ${ev.step + 1}'s message (appends "${ev.appendText}", output tokens ${ev.outputTokens})`;
    case "settle":
      return "chatd settles the turn (status waiting)";
  }
}

async function runOnce(scn: Scenario, chooser: Chooser): Promise<RunOutcome> {
  const world = new ChatdWorld(scn.start, scn.steps);
  const sockets: ScriptedSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const s = new ScriptedSocket(url);
    sockets.push(s);
    // SAFETY: ScriptedSocket implements every WebSocketLike method the reader calls.
    return s as unknown as WebSocketLike;
  };
  const fetchCalls: string[] = [];
  const client = new CoderChatClient({
    baseUrl: "https://coder.test",
    token: "t",
    fetch: fakeFetch(world, fetchCalls),
    webSocketFactory: factory,
  });
  const config: ConstructorParameters<typeof CoderLanguageModel>[0] = {
    client,
    organizationId: "org-1",
  };
  if (scn.start === "follow-up") {
    config.chatId = CHAT_ID;
    config.lastSeenMessageId = world.promptId - 1;
  }
  const model = new CoderLanguageModel(config);
  const trace: string[] = [];
  const outcome: RunOutcome = {
    parts: [],
    consumerError: undefined,
    finished: false,
    fetchCalls,
    world,
    trace,
  };

  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  } as never);
  const reader = stream.getReader();
  const consumer = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        outcome.parts.push(value);
      }
    } catch (err) {
      outcome.consumerError = err;
    }
    outcome.finished = true;
  })();

  let nextEvent = 0;
  let queue: Frame[] = [];
  let socket: ScriptedSocket | undefined;
  let connected = false;
  let drops = 0;
  const connection = () => sockets.length;

  /** After a drop, lets the reader's backoff run until it dials again or gives up. */
  const awaitRedial = async (): Promise<void> => {
    const before = sockets.length;
    for (let i = 0; i < 64 && sockets.length === before && !outcome.finished; i++) {
      vi.advanceTimersByTime(1000);
      await drain();
    }
  };

  await drain();
  for (let tick = 0; ; tick++) {
    if (tick > 1000) throw new Error("harness: run did not converge in 1000 steps");
    if (outcome.finished) break;
    const latest = sockets[sockets.length - 1];
    if (!latest) {
      trace.push("the client never dialed the stream");
      break;
    }
    if (latest !== socket) {
      socket = latest;
      connected = false;
      queue = [];
    }
    const upcoming = scn.timeline[nextEvent];
    const options: string[] = [];
    if (!connected) {
      options.push("connect");
      if (upcoming) options.push("world");
      if (drops < scn.maxDrops) options.push("refuse");
    } else {
      const head = queue[0];
      if (head) {
        options.push("deliver");
        // Delivering a preview part before or after a later part changes
        // nothing; it matters only when the next event ends the attempt.
        if (head.preview && upcoming && world.endsAttempt(upcoming)) options.push("world");
      } else if (upcoming) {
        options.push("world");
      }
      if (options.length === 0) {
        trace.push("chatd has nothing left to send, and the turn has not finished");
        break;
      }
      if (drops < scn.maxDrops) options.push("drop");
    }

    const choice = chooser.choose(options);
    switch (choice) {
      case "connect": {
        const afterParam = new URL(socket.url).searchParams.get("after_id");
        const afterId = afterParam === null ? undefined : Number(afterParam);
        queue = world.connect(afterId);
        connected = true;
        socket.emit("open");
        trace.push(
          `connection ${connection()} opens (after_id=${afterParam ?? "none"}); chatd queues the initial sync and ${queue.length - 1} replayed preview part(s)`,
        );
        break;
      }
      case "refuse": {
        drops += 1;
        trace.push(`connection ${connection()} fails its handshake (502)`);
        socket.emit("error", { message: "Unexpected server response: 502" });
        socket.emit("close", { code: 1006 });
        await drain();
        await awaitRedial();
        break;
      }
      case "deliver": {
        const frame = queue.shift();
        if (!frame) throw new Error("harness: deliver with an empty queue");
        trace.push(`connection ${connection()} delivers: ${describeFrame(frame)}`);
        socket.emit("message", { data: frameData(frame) });
        break;
      }
      case "world": {
        const ev = scn.timeline[nextEvent];
        if (!ev) throw new Error("harness: world step past the timeline");
        nextEvent += 1;
        const frames = world.apply(ev);
        let note = "";
        if (connected) {
          if (world.endsAttempt(ev)) {
            const lost = queue.filter((f) => f.preview).length;
            if (lost > 0) note = ` (${lost} unforwarded preview part(s) dropped)`;
            queue = queue.filter((f) => !f.preview);
          }
          queue.push(...frames);
        }
        trace.push(`${describeWorld(ev)}${note}`);
        break;
      }
      case "drop": {
        drops += 1;
        trace.push(
          `connection ${connection()} drops (close 1006) with ${queue.length} undelivered frame(s)`,
        );
        queue = [];
        connected = false;
        socket.emit("close", { code: 1006 });
        await drain();
        await awaitRedial();
        break;
      }
      default:
        throw new Error(`harness: unknown choice ${choice}`);
    }
    await drain();
  }

  if (!outcome.finished) {
    await reader.cancel();
    await drain();
  }
  await consumer;
  await drain();
  vi.clearAllTimers();
  return outcome;
}

interface Violation {
  property: PropertyName;
  detail: string;
}

/**
 * What a run must deliver for one kind of delta, per committed message: the
 * content its step streamed, and the text that later revisions appended.
 */
function expectedDeltas(
  world: ChatdWorld,
  kind: "text" | "reasoning",
): { own: string[]; suffix: string[] } {
  const own: string[] = [];
  const suffix: string[] = [];
  for (const m of world.turnMessages()) {
    const full = m.content
      .filter((p) => p.type === kind)
      .map((p) => p.text ?? "")
      .join("");
    const appended = kind === "text" ? m.appendedText : "";
    if (!full.endsWith(appended))
      throw new Error("harness: a revision suffix must end its message");
    own.push(full.slice(0, full.length - appended.length));
    suffix.push(appended);
  }
  return { own, suffix };
}

/**
 * Compares one kind of delta with what chatd committed. A step's content must
 * arrive exactly once, in step order. A revision can append text to a message
 * that has already committed. The translator emits that suffix when it sees
 * the revision (translate.ts, `#reconcileRevision`), which can be after later
 * steps' text. So a suffix must arrive exactly once, in order, after its
 * message's own content, at any later point. Every letter in a scenario is
 * distinct (see `validate`), so each letter's position is unambiguous.
 */
function compareDeltas(
  got: string,
  world: ChatdWorld,
  kind: "text" | "reasoning",
): string | undefined {
  const { own, suffix } = expectedDeltas(world, kind);
  const committed = own.map((o, i) => (suffix[i] ? `${o}[+${suffix[i]}]` : o)).join("");
  const mismatch = `the AI SDK got ${kind} "${got}", chatd committed "${committed}"`;
  const suffixLetters = new Set(suffix.join(""));
  const gotOwn = [...got].filter((ch) => !suffixLetters.has(ch)).join("");
  if (gotOwn !== own.join("")) return mismatch;
  for (const [i, appended] of suffix.entries()) {
    if (appended === "") continue;
    const ownOfMessage = own[i] ?? "";
    let after = ownOfMessage === "" ? -1 : got.indexOf(ownOfMessage.slice(-1));
    for (const ch of appended) {
      const at = got.indexOf(ch);
      if (at === -1 || at !== got.lastIndexOf(ch) || at < after) return mismatch;
      after = at;
    }
  }
  return undefined;
}

/** Every part and suffix is one letter, and no letter repeats: see `compareDeltas`. */
function validate(scn: Scenario): void {
  const letters = [
    ...scn.steps.flatMap((step) => step.parts.map((p) => p.text)),
    ...scn.timeline.flatMap((ev) => (ev.kind === "revise" ? [ev.appendText] : [])),
  ];
  if (letters.some((l) => l.length !== 1) || new Set(letters).size !== letters.length) {
    throw new Error(`scenario "${scn.name}": parts and suffixes must be distinct single letters`);
  }
}

function check(outcome: RunOutcome): Violation[] {
  const { parts, world } = outcome;
  const violations: Violation[] = [];
  const finishes = parts.filter((p) => p.type === "finish");
  const errors = parts.filter((p) => p.type === "error");
  const completes: string[] = [];
  if (!outcome.finished) completes.push("the stream never ended");
  if (outcome.consumerError !== undefined)
    completes.push(`the stream threw: ${String(outcome.consumerError)}`);
  if (errors.length > 0) completes.push(`${errors.length} error part(s)`);
  if (finishes.length !== 1) completes.push(`${finishes.length} finish parts`);
  const finish = finishes[0];
  if (finish && finish.finishReason.unified !== "stop") {
    completes.push(`finish reason ${finish.finishReason.unified}`);
  }
  if (outcome.finished && !world.settled)
    completes.push("the stream ended before chatd settled the turn");
  if (completes.length > 0)
    violations.push({ property: "Completes", detail: completes.join("; ") });

  const delta = (type: "text-delta" | "reasoning-delta") =>
    parts
      .filter((p) => p.type === type)
      .map((p) => ("delta" in p ? p.delta : ""))
      .join("");
  const textProblem = compareDeltas(delta("text-delta"), world, "text");
  if (textProblem) violations.push({ property: "TextExactlyOnce", detail: textProblem });
  const reasoningProblem = compareDeltas(delta("reasoning-delta"), world, "reasoning");
  if (reasoningProblem)
    violations.push({ property: "ReasoningExactlyOnce", detail: reasoningProblem });
  if (finish) {
    const got = finish.usage.outputTokens.total;
    const want = world.turnMessages().reduce((sum, m) => sum + (m.outputTokens ?? 0), 0);
    if (got !== want) {
      violations.push({
        property: "UsageOnce",
        detail: `finish reports ${got} output tokens, chatd committed ${want}`,
      });
    }
  }
  const interrupts = outcome.fetchCalls.filter((c) => c.endsWith("/interrupt"));
  if (interrupts.length > 0) {
    violations.push({ property: "NoInterrupt", detail: interrupts.join(", ") });
  }
  return violations;
}

interface Counterexample {
  detail: string;
  trace: string[];
}

interface ScenarioReport {
  runs: number;
  violatingRuns: number;
  /** The shortest counterexample per violated property. */
  shortest: Map<PropertyName, Counterexample & { count: number }>;
}

async function explore(scn: Scenario): Promise<ScenarioReport> {
  validate(scn);
  const report: ScenarioReport = { runs: 0, violatingRuns: 0, shortest: new Map() };
  // FORMAL_SHOW_RUN=<n> prints run n of each scenario (0-based), to see what
  // one run does without a violation.
  const show = process.env.FORMAL_SHOW_RUN;
  let index = 0;
  report.runs = await exploreAll(async (chooser) => {
    const outcome = await runOnce(scn, chooser);
    const violations = check(outcome);
    if (show !== undefined && Number(show) === index) {
      const got = outcome.parts.map((p) => ("delta" in p ? `${p.type}:${p.delta}` : p.type));
      console.log(
        [
          `  run ${index}:`,
          ...outcome.trace.map((t) => `    ${t}`),
          `    parts: ${got.join(" ")}`,
        ].join("\n"),
      );
    }
    index += 1;
    if (violations.length > 0) report.violatingRuns += 1;
    for (const v of violations) {
      const prev = report.shortest.get(v.property);
      if (!prev) {
        report.shortest.set(v.property, { detail: v.detail, trace: outcome.trace, count: 1 });
        continue;
      }
      prev.count += 1;
      if (outcome.trace.length < prev.trace.length) {
        prev.detail = v.detail;
        prev.trace = outcome.trace;
      }
    }
  }, scn.maxRuns);
  return report;
}

function render(scn: Scenario, report: ScenarioReport): string {
  const lines = [
    `scenario: ${scn.name}`,
    `  runs: ${report.runs}, violating runs: ${report.violatingRuns}, max drops: ${scn.maxDrops}`,
  ];
  for (const [property, cx] of report.shortest) {
    lines.push(`  VIOLATION ${property} in ${cx.count} run(s). Shortest counterexample:`);
    cx.trace.forEach((step, i) => lines.push(`    ${i + 1}. ${step}`));
    lines.push(`    => ${cx.detail}`);
  }
  return lines.join("\n");
}

describe("agent stream exactly-once (bounded exhaustive)", () => {
  beforeEach(() => {
    // setImmediate stays real: drain() uses it to run every pending microtask.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(SCENARIOS)("$name", async (scn) => {
    const report = await explore(scn);
    const text = render(scn, report);
    console.log(text);
    const violated = [...report.shortest.keys()];
    const finding = scn.knownFinding;
    let status = violated.length === 0 ? "pass" : "fail";
    if (finding && violated.length > 0) {
      status = violated.every((p) => finding.properties.includes(p)) ? "known-finding" : "fail";
    }
    // One machine-readable line per scenario; mutants.sh in the skill parses it.
    console.log(
      `RESULT scenario="${scn.name}" status=${status} runs=${report.runs} violated=${violated.join(",") || "none"}`,
    );
    if (finding && violated.length === 0) {
      throw new Error(
        `known finding ${finding.id} no longer reproduces: delete the scenario's knownFinding, so it must pass\n${text}`,
      );
    }
    // On failure vitest prints the whole report as the received value.
    expect(status === "fail" ? `a property broke:\n${text}` : "ok").toBe("ok");
    if (finding) console.log(`  KNOWN FINDING ${finding.id}: still present`);
  });
});
