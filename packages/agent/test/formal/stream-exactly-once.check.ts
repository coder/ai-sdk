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
 *   One narrow exception, for a retry whose new attempt streams different
 *   parts (`nextParts`): see `withDiverged`.
 * - ContentInOrder: text and reasoning deltas together follow the wire order
 *   of the committed content parts.
 * - UsageOnce: every `finish` usage counter equals the sum over the turn's
 *   committed assistant messages (latest revision).
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
  usageFor,
  type WorldEvent,
} from "./chatd-world.js";
import { type Chooser, exploreAll } from "./explore.js";

type PropertyName =
  | "Completes"
  | "TextExactlyOnce"
  | "ReasoningExactlyOnce"
  | "ContentInOrder"
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
   * A violation that the current code has, pinned by its fingerprint: the
   * violated properties, the number of violating runs, and the shortest
   * counterexample's verdict per property. Exploration is deterministic, so
   * any other defect in the scenario changes the fingerprint and fails the
   * check. No violation at all also fails: the finding is fixed.
   */
  knownFinding?: KnownFinding;
}

interface KnownFinding {
  id: string;
  violatingRuns: number;
  /** The `=>` line of the shortest counterexample, per violated property. */
  shortest: Partial<Record<PropertyName, string>>;
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
    steps: [{ parts: [text("a"), text("b")], usage: 1 }],
    timeline: [part, part, commit, settle],
    maxDrops: 2,
    maxRuns: 20_000,
  },
  {
    name: "two steps, reasoning then text, follow-up turn",
    start: "follow-up",
    steps: [
      { parts: [reasoning("p"), text("a"), text("b")], usage: 1 },
      { parts: [text("c"), text("d")], usage: 10 },
    ],
    timeline: [part, part, part, commit, part, part, commit, settle],
    maxDrops: 2,
    maxRuns: 100_000,
  },
  {
    name: "step 1 revised (text appended, usage changed) before step 2 starts",
    start: "new-chat",
    steps: [
      { parts: [text("a"), text("b")], usage: 1 },
      { parts: [text("c")], usage: 10 },
    ],
    timeline: [
      part,
      part,
      commit,
      { kind: "revise", step: 0, appendText: "e", usage: 2 },
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
    steps: [{ parts: [text("a"), text("b")], usage: 1 }],
    timeline: [part, retry, part, part, commit, settle],
    maxDrops: 1,
    maxRuns: 20_000,
  },
  {
    name: "attempt fails after a partial stream and chatd retries it with different text",
    start: "new-chat",
    steps: [{ parts: [text("a"), text("b")], usage: 1 }],
    timeline: [
      part,
      part,
      { kind: "retry", nextParts: [text("a"), text("c")] },
      part,
      part,
      commit,
      settle,
    ],
    maxDrops: 1,
    maxRuns: 20_000,
  },
  {
    name: "step 1 revised while step 2 streams, so chatd restarts step 2",
    start: "new-chat",
    steps: [
      { parts: [text("a"), text("b")], usage: 1 },
      { parts: [text("c"), text("d")], usage: 10 },
    ],
    timeline: [
      part,
      part,
      commit,
      part,
      { kind: "revise", step: 0, appendText: "e", usage: 2 },
      part,
      part,
      commit,
      settle,
    ],
    maxDrops: 1,
    maxRuns: 40_000,
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
  /** The highest preview seq delivered to the client, per episode `history_version:generation_attempt`. */
  delivered: Map<string, number>;
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
    case "retry": {
      const base = "the provider call fails with a retryable error; chatd retires the attempt";
      if (!ev.nextParts) return base;
      return `${base}, and the next attempt streams "${ev.nextParts.map((p) => p.text).join("")}"`;
    }
    case "revise":
      return `chatd revises step ${ev.step + 1}'s message (appends "${ev.appendText}", usage unit ${ev.usage})`;
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
    delivered: new Map(),
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
        for (const ev of frame.events) {
          const mp = ev.message_part;
          if (ev.type !== "message_part" || !mp || mp.seq === undefined) continue;
          const key = `${mp.history_version}:${mp.generation_attempt}`;
          outcome.delivered.set(key, Math.max(outcome.delivered.get(key) ?? 0, mp.seq));
        }
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
 * The text of step `step`'s diverged attempt (see `DivergedAttempt` in
 * chatd-world.ts) that reached the client, of one kind or of both. chatd
 * forwards an attempt's parts in seq order and a redial replays them from
 * seq 1, so the delivered parts are always the attempt's first parts.
 */
function divergedPrefix(
  outcome: RunOutcome,
  step: number,
  kind: "text" | "reasoning" | "all",
): string {
  let got = "";
  for (const a of outcome.world.divergedAttempts()) {
    if (a.step !== step) continue;
    const delivered = outcome.delivered.get(`${a.historyVersion}:${a.generationAttempt}`) ?? 0;
    for (const p of a.parts.slice(0, delivered))
      if (kind === "all" || p.kind === kind) got += p.text;
  }
  return got;
}

/**
 * The one exception to exactly-once, scoped to a step whose attempt a retry
 * with `nextParts` abandoned (issue #407). The AI SDK stream cannot take back
 * text, so the abandoned attempt's text that already reached the AI SDK stays.
 * The translator holds back the new attempt's text while it repeats that text.
 * So when the committed text starts with the abandoned text, the AI SDK must
 * get the committed text exactly once. Otherwise it must get the abandoned
 * text, then the complete committed text. Steps without such a retry have an
 * empty `abandoned`, so this is the exact committed text.
 */
function withDiverged(committed: string, abandoned: string): { want: string; shown: string } {
  if (committed.startsWith(abandoned)) return { want: committed, shown: committed };
  return { want: abandoned + committed, shown: `{${abandoned}}${committed}` };
}

/**
 * What a run must deliver for one kind of delta, per committed message: the
 * content its step streamed (see `withDiverged`), and the text that later
 * revisions appended. `shown` is the same for the report: `{ab}` marks
 * abandoned text that the AI SDK must keep.
 */
function expectedDeltas(
  outcome: RunOutcome,
  kind: "text" | "reasoning",
): { own: string[]; shown: string[]; suffix: string[] } {
  const own: string[] = [];
  const shown: string[] = [];
  const suffix: string[] = [];
  for (const [i, m] of outcome.world.turnMessages().entries()) {
    const full = m.content
      .filter((p) => p.type === kind)
      .map((p) => p.text ?? "")
      .join("");
    const appended = kind === "text" ? m.appendedText : "";
    if (!full.endsWith(appended))
      throw new Error("harness: a revision suffix must end its message");
    const expected = withDiverged(
      full.slice(0, full.length - appended.length),
      divergedPrefix(outcome, i, kind),
    );
    own.push(expected.want);
    shown.push(expected.shown);
    suffix.push(appended);
  }
  return { own, shown, suffix };
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
  outcome: RunOutcome,
  kind: "text" | "reasoning",
): string | undefined {
  const { own, shown, suffix } = expectedDeltas(outcome, kind);
  const committed = shown.map((o, i) => (suffix[i] ? `${o}[+${suffix[i]}]` : o)).join("");
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

/**
 * Text and reasoning together: a step's own content arrives in the wire order
 * of its parts, across both kinds (translate.ts walks a snapshot in wire
 * order, #79). Revision suffixes are left out, as in `compareDeltas`.
 */
function compareContentOrder(
  parts: LanguageModelV4StreamPart[],
  outcome: RunOutcome,
): string | undefined {
  const world = outcome.world;
  const suffixLetters = new Set(world.turnMessages().flatMap((m) => [...m.appendedText]));
  const own = (letters: string) => [...letters].filter((ch) => !suffixLetters.has(ch)).join("");
  const got = own(
    parts
      .map((p) =>
        (p.type === "text-delta" || p.type === "reasoning-delta") && "delta" in p ? p.delta : "",
      )
      .join(""),
  );
  const expected = world
    .turnMessages()
    .map((m, i) =>
      withDiverged(
        own(m.content.map((p) => p.text ?? "").join("")),
        divergedPrefix(outcome, i, "all"),
      ),
    );
  const want = expected.map((e) => e.want).join("");
  if (got === want) return undefined;
  return `the AI SDK got text and reasoning in the order "${got}", chatd committed "${expected.map((e) => e.shown).join("")}"`;
}

/**
 * Every usage counter in `finish` equals the sum over the turn's committed
 * assistant messages at their latest revision (translate.ts `accumulateUsage`
 * and `mapUsage`). Each counter is a different multiple of the usage unit
 * (`usageFor`), so double counting any one of them shows.
 */
function compareUsage(
  finish: Extract<LanguageModelV4StreamPart, { type: "finish" }>,
  world: ChatdWorld,
): string | undefined {
  const k = world.turnMessages().reduce((sum, m) => sum + (m.usage ?? 0), 0);
  const u = usageFor(k);
  const want = {
    inputTotal: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0),
    inputNoCache: u.input_tokens,
    cacheRead: u.cache_read_tokens,
    cacheWrite: u.cache_creation_tokens,
    output: u.output_tokens,
    reasoning: u.reasoning_tokens,
    costMicros: u.total_cost_micros,
    runtimeMs: u.total_runtime_ms,
  };
  const coder = finish.providerMetadata?.coder;
  const got = {
    inputTotal: finish.usage.inputTokens.total,
    inputNoCache: finish.usage.inputTokens.noCache,
    cacheRead: finish.usage.inputTokens.cacheRead,
    cacheWrite: finish.usage.inputTokens.cacheWrite,
    output: finish.usage.outputTokens.total,
    reasoning: finish.usage.outputTokens.reasoning,
    costMicros: coder?.total_cost_micros,
    runtimeMs: coder?.total_runtime_ms,
  };
  if (JSON.stringify(got) === JSON.stringify(want)) return undefined;
  return `finish reports usage ${JSON.stringify(got)}, chatd committed ${JSON.stringify(want)} (usage unit ${k})`;
}

/**
 * Every part and suffix is one letter, and no letter repeats: see
 * `compareDeltas`. One exception: a retry's `nextParts` can start with the
 * step's own first letters (the new attempt repeats the abandoned one, then
 * diverges). A scenario has at most one such retry, on a text-only step, so
 * that `withDiverged` describes the whole expected output.
 */
function validate(scn: Scenario): void {
  const fail = (why: string) => new Error(`scenario "${scn.name}": ${why}`);
  const letters = [
    ...scn.steps.flatMap((step) => step.parts.map((p) => p.text)),
    ...scn.timeline.flatMap((ev) => (ev.kind === "revise" ? [ev.appendText] : [])),
  ];
  let step = 0;
  let diverging = 0;
  for (const ev of scn.timeline) {
    if (ev.kind === "commit") step += 1;
    if (ev.kind !== "retry" || !ev.nextParts) continue;
    diverging += 1;
    const parts = scn.steps[step]?.parts ?? [];
    if ([...parts, ...ev.nextParts].some((p) => p.kind !== "text"))
      throw fail("a retry with nextParts needs a text-only step");
    let shared = 0;
    while (shared < parts.length && ev.nextParts[shared]?.text === parts[shared]?.text) shared++;
    letters.push(...ev.nextParts.slice(shared).map((p) => p.text));
  }
  if (diverging > 1) throw fail("at most one retry can have nextParts");
  if (letters.some((l) => l.length !== 1) || new Set(letters).size !== letters.length) {
    throw fail("parts and suffixes must be distinct single letters");
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
  if (finish && parts[parts.length - 1] !== finish) completes.push("parts after finish");
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
  const textProblem = compareDeltas(delta("text-delta"), outcome, "text");
  if (textProblem) violations.push({ property: "TextExactlyOnce", detail: textProblem });
  const reasoningProblem = compareDeltas(delta("reasoning-delta"), outcome, "reasoning");
  if (reasoningProblem)
    violations.push({ property: "ReasoningExactlyOnce", detail: reasoningProblem });
  const orderProblem = compareContentOrder(parts, outcome);
  if (orderProblem) violations.push({ property: "ContentInOrder", detail: orderProblem });
  if (finish) {
    const usageProblem = compareUsage(finish, world);
    if (usageProblem) violations.push({ property: "UsageOnce", detail: usageProblem });
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

/** How a scenario's violations differ from its recorded known finding; empty when they match. */
function fingerprintDifferences(finding: KnownFinding, report: ScenarioReport): string[] {
  const differences: string[] = [];
  if (report.violatingRuns !== finding.violatingRuns) {
    differences.push(`violating runs ${report.violatingRuns}, recorded ${finding.violatingRuns}`);
  }
  const recorded = Object.keys(finding.shortest).sort();
  const got = [...report.shortest.keys()].sort();
  if (got.join(",") !== recorded.join(",")) {
    differences.push(`violated ${got.join(",")}, recorded ${recorded.join(",") || "none"}`);
  }
  for (const [property, cx] of report.shortest) {
    const want = finding.shortest[property];
    if (want !== undefined && want !== cx.detail) {
      differences.push(`${property} shortest "${cx.detail}", recorded "${want}"`);
    }
  }
  return differences;
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
    const differences = finding ? fingerprintDifferences(finding, report) : [];
    if (finding && violated.length > 0 && differences.length === 0) status = "known-finding";
    // One machine-readable line per scenario; mutants.sh in the skill parses it.
    console.log(
      `RESULT scenario="${scn.name}" status=${status} runs=${report.runs} violating=${report.violatingRuns} violated=${violated.join(",") || "none"}`,
    );
    if (finding && violated.length === 0) {
      throw new Error(
        `known finding ${finding.id} no longer reproduces: delete the scenario's knownFinding, so it must pass\n${text}`,
      );
    }
    if (finding && differences.length > 0) {
      console.log(
        `  FINGERPRINT differs from known finding ${finding.id}: ${differences.join("; ")}`,
      );
    }
    // On failure vitest prints the whole report as the received value.
    expect(status === "fail" ? `a property broke:\n${text}` : "ok").toBe("ok");
    if (finding) console.log(`  KNOWN FINDING ${finding.id}: still present, fingerprint matches`);
  });
});
