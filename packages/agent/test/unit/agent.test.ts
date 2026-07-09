import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ChatFileInput,
  CoderChatClient,
  type UploadedChatFile,
} from "../../src/coder/client.js";
import { CoderAgent } from "../../src/agent/coder-agent.js";
import { CoderAgentError, CoderApiError, CoderChatError } from "../../src/errors.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import type {
  Chat,
  ChatStreamEvent,
  CreateChatMessageResponse,
  CreateChatRequest,
  SubmitToolResultsRequest,
} from "../../src/coder/types.js";
import type { WorkspaceFileStore } from "../../src/workspace-files.js";

/** A scripted, in-memory stand-in for {@link CoderChatClient}. */
class FakeClient {
  turns: ChatStreamEvent[][];
  #turnIndex = 0;
  createdChats: CreateChatRequest[] = [];
  submitted: SubmitToolResultsRequest[] = [];
  uploads: ChatFileInput[] = [];
  #nextMessageId = 1000;

  constructor(turns: ChatStreamEvent[][]) {
    this.turns = turns;
  }

  async resolveModelConfigId(): Promise<string | undefined> {
    return undefined;
  }

  async createChat(req: CreateChatRequest): Promise<Chat> {
    this.createdChats.push(req);
    return chatStub("chat-1", req.organization_id);
  }

  async createChatMessage(): Promise<CreateChatMessageResponse> {
    return {
      queued: false,
      message: { id: ++this.#nextMessageId, chat_id: "chat-1", role: "user", created_at: "" },
    };
  }

  async submitToolResults(_chatId: string, req: SubmitToolResultsRequest): Promise<void> {
    this.submitted.push(req);
  }

  async uploadChatFile(_orgId: string, file: ChatFileInput): Promise<UploadedChatFile> {
    this.uploads.push(file);
    return {
      id: `file-${this.uploads.length}`,
      mediaType: file.mediaType ?? "application/octet-stream",
      name: file.name,
    };
  }

  async *streamEvents(): AsyncGenerator<ChatStreamEvent, void, void> {
    const events = this.turns[this.#turnIndex++] ?? [];
    for (const ev of events) {
      // Simulate async delivery.
      await Promise.resolve();
      yield ev;
    }
  }

  async archiveChat(_chatId: string, _signal?: AbortSignal): Promise<void> {}
  async interruptChat(_chatId: string, _signal?: AbortSignal): Promise<Chat> {
    throw new Error("not used");
  }
}

function msg(
  id: number,
  role: "user" | "assistant" | "tool",
  content: { type: string; text?: string }[],
): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "chat-1",
    message: { id, chat_id: "chat-1", role, created_at: "", content: content as never },
  };
}
function textPart(text: string): ChatStreamEvent {
  return {
    type: "message_part",
    chat_id: "chat-1",
    message_part: { role: "assistant", part: { type: "text", text } },
  };
}
function status(s: string): ChatStreamEvent {
  return { type: "status", chat_id: "chat-1", status: { status: s as never } };
}

function chatStub(id: string, organizationId = "org-1"): Chat {
  return {
    id,
    organization_id: organizationId,
    owner_id: "u",
    title: "t",
    status: "running",
    created_at: "",
    updated_at: "",
    archived: false,
  };
}

/** Resolves once the signal aborts (mirrors how the real WS reader unblocks). */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Read a stream to completion (or until it errors). */
async function drain(reader: ReadableStreamDefaultReader<unknown>): Promise<void> {
  while (!(await reader.read()).done) {
    /* discard */
  }
}

/**
 * A fake client whose single turn yields one non-terminal event then never
 * settles until its signal aborts — for exercising cancellation/timeout. The
 * returned `interrupted` array records every `interruptChat` call.
 */
function stallingClient(onRunning?: () => void): { client: unknown; interrupted: string[] } {
  const interrupted: string[] = [];
  const client = {
    resolveModelConfigId: async () => undefined,
    createChat: async () => chatStub("chat-1"),
    interruptChat: async (id: string) => {
      interrupted.push(id);
      return chatStub(id);
    },
    archiveChat: async () => {},
    streamEvents: (_id: string, opts?: { signal?: AbortSignal }) =>
      (async function* () {
        yield status("running");
        onRunning?.();
        await waitForAbort(opts?.signal);
      })(),
  };
  return { client, interrupted };
}

function makeAgent<T extends Record<string, unknown>>(fake: FakeClient, tools?: T) {
  return new CoderAgent({
    client: fake as unknown as CoderChatClient,
    organizationId: "org-1",
    instructions: "be helpful",
    ...(tools ? { tools: tools as never } : {}),
  });
}

describe("CoderAgent integration (mock client)", () => {
  it("generates plain text over one turn", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("Hello!"),
        msg(2, "assistant", [{ type: "text", text: "Hello!" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);
    const result = await agent.generate({ prompt: "hi" });

    expect(result.text).toBe("Hello!");
    expect(result.steps).toHaveLength(1);
    expect(agent.chatId).toBe("chat-1");
    expect(fake.createdChats).toHaveLength(1);
    expect(fake.createdChats[0]?.system_prompt).toBe("be helpful");
    expect(fake.createdChats[0]?.client_type).toBe("api");
  });

  it("runs a custom tool round-trip: action_required → execute → submit results → resume", async () => {
    const execute = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
    const tools = {
      getWeather: tool({
        description: "Get the weather for a city",
        inputSchema: z.object({ city: z.string() }),
        execute,
      }),
    };

    const fake = new FakeClient([
      // Turn 1: assistant says it will check, then requests the client tool.
      // NOTE: chatd emits the `requires_action` status BEFORE the
      // `action_required` event (matching real wire order) — this guards the
      // model loop against breaking before the tool calls arrive.
      [
        status("running"),
        textPart("Checking the weather."),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: "chat-1",
          action_required: {
            tool_calls: [
              { tool_call_id: "tc1", tool_name: "getWeather", args: '{"city":"Paris"}' },
            ],
          },
        },
      ],
      // Turn 2: after results are submitted, assistant produces the final text.
      [
        status("running"),
        textPart("It's 21°C in Paris."),
        msg(3, "assistant", [{ type: "text", text: "It's 21°C in Paris." }]),
        status("waiting"),
      ],
    ]);

    const agent = makeAgent(fake, tools);
    const result = await agent.generate({ prompt: "weather in Paris?" });

    // The tool executed with the parsed args.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({ city: "Paris" });

    // Results were submitted back to chatd with the chatd-issued tool_call_id.
    expect(fake.submitted).toHaveLength(1);
    expect(fake.submitted[0]?.results[0]?.tool_call_id).toBe("tc1");
    expect(fake.submitted[0]?.results[0]?.is_error).toBe(false);

    // Two steps: the tool turn and the final answer turn.
    expect(result.steps).toHaveLength(2);
    expect(result.text).toContain("21");

    // The custom tool was registered as a chatd dynamic tool at chat creation.
    expect(fake.createdChats[0]?.unsafe_dynamic_tools?.map((t) => t.name)).toEqual(["getWeather"]);
  });

  it("streams text deltas via stream()", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("a"),
        textPart("b"),
        textPart("c"),
        msg(2, "assistant", [{ type: "text", text: "abc" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);
    const result = await agent.stream({ prompt: "spell it" });

    let streamed = "";
    for await (const delta of result.textStream) streamed += delta;
    expect(streamed).toBe("abc");
    expect(await result.text).toBe("abc");
  });
});

describe("CoderAgent file uploads", () => {
  it("uploads a file part transparently and references it by id in the new turn", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("Summary."),
        msg(2, "assistant", [{ type: "text", text: "Summary." }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);

    await agent.generate({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              mediaType: "application/pdf",
              filename: "r.pdf",
            },
          ],
        },
      ],
    });

    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]?.mediaType).toBe("application/pdf");
    const content = fake.createdChats[0]?.content;
    expect(content).toContainEqual({ type: "text", text: "summarize" });
    expect(content).toContainEqual({ type: "file", file_id: "file-1" });
  });

  it("attach() uploads and returns a handle whose toFilePart() references the id", async () => {
    const fake = new FakeClient([]);
    const agent = makeAgent(fake);

    const att = await agent.attach({
      content: new Uint8Array([1, 2, 3]),
      mediaType: "application/pdf",
      name: "r.pdf",
    });

    expect(att.id).toBe("file-1");
    expect(att.mediaType).toBe("application/pdf");
    expect(fake.uploads).toHaveLength(1);
    expect(att.toFilePart()).toMatchObject({
      type: "file",
      mediaType: "application/pdf",
      filename: "r.pdf",
      providerOptions: { coder: { fileId: "file-1" } },
    });
  });

  it("reuses an attach()ed file via toFilePart() in generate() without re-uploading", async () => {
    const fake = new FakeClient([
      [
        status("running"),
        textPart("ok"),
        msg(2, "assistant", [{ type: "text", text: "ok" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake);

    const att = await agent.attach({
      content: new Uint8Array([1, 2, 3]),
      mediaType: "application/pdf",
      name: "r.pdf",
    });
    expect(fake.uploads).toHaveLength(1); // the attach() upload itself

    await agent.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "again" }, att.toFilePart()] }],
    });

    // No second upload: the file is referenced by id (providerOptions flows
    // through the AI SDK core→provider conversion).
    expect(fake.uploads).toHaveLength(1);
    expect(fake.createdChats[0]?.content).toContainEqual({ type: "file", file_id: "file-1" });
  });

  it("uploadToWorkspace() throws a helpful error without a workspaceFiles adapter", async () => {
    const agent = makeAgent(new FakeClient([]));
    await expect(
      agent.uploadToWorkspace({ content: new Uint8Array([1]), path: "assets.zip" }),
    ).rejects.toThrow(/workspaceFiles/);
  });

  it("uploadToWorkspace() writes via the adapter and returns the placement", async () => {
    const writes: { path: string }[] = [];
    const store: WorkspaceFileStore = {
      workspaceId: "ws-1",
      write: async ({ path }) => {
        writes.push({ path });
        return { path: `/home/coder/${path}` };
      },
    };
    const agent = new CoderAgent({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
      workspaceFiles: store,
    });

    const placement = await agent.uploadToWorkspace({
      content: new Uint8Array([1, 2]),
      path: "assets.zip",
    });

    expect(placement).toEqual({ workspaceId: "ws-1", path: "/home/coder/assets.zip" });
    expect(writes).toEqual([{ path: "assets.zip" }]);
  });
});

describe("CoderAgent cancellation & failures", () => {
  it("interrupts the server run when the caller aborts mid-turn", async () => {
    let reachedStream!: () => void;
    const midStream = new Promise<void>((r) => {
      reachedStream = r;
    });
    const { client, interrupted } = stallingClient(reachedStream);
    const agent = new CoderAgent({
      client: client as CoderChatClient,
      organizationId: "org-1",
    });

    const ac = new AbortController();
    const p = agent.generate({ prompt: "hi", abortSignal: ac.signal });
    await midStream;
    ac.abort();

    await expect(p).rejects.toThrow();
    // Aborting must stop the *server* run, not merely close the socket.
    expect(interrupted).toEqual(["chat-1"]);
  });

  it("interrupts and errors a turn that exceeds requestTimeoutMs", async () => {
    const { client, interrupted } = stallingClient();
    const model = new CoderLanguageModel({
      client: client as CoderChatClient,
      organizationId: "o",
      requestTimeoutMs: 30,
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    await expect(drain(stream.getReader())).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "timeout",
    });
    expect(interrupted).toEqual(["chat-1"]);
  });

  it("errors (not a silent stop) when the stream ends before a terminal status", async () => {
    // No terminal status — the socket closed mid-run.
    const fake = new FakeClient([[status("running"), textPart("partial…")]]);
    const model = new CoderLanguageModel({
      client: fake as unknown as CoderChatClient,
      organizationId: "o",
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    await expect(drain(stream.getReader())).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "stream_closed",
    });
  });

  it("re-throws a caller's own AbortSignal.timeout as an abort, not a coder timeout", async () => {
    // Caller supplies their own deadline; the agent has no requestTimeoutMs. The
    // abort must surface as the caller's TimeoutError, not be rewritten into a
    // bogus CoderChatError(kind:"timeout", "…undefined ms…").
    const { client, interrupted } = stallingClient();
    const model = new CoderLanguageModel({
      client: client as CoderChatClient,
      organizationId: "o",
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: AbortSignal.timeout(30),
    } as never);
    const err = await drain(stream.getReader()).then(
      () => undefined,
      (e) => e as { name?: string },
    );
    expect(err?.name).toBe("TimeoutError");
    expect(err).not.toBeInstanceOf(CoderChatError);
    expect(interrupted).toEqual(["chat-1"]);
  });

  it("surfaces a mid-turn stream transport error as a retryable stream_closed", async () => {
    const client = {
      resolveModelConfigId: async () => undefined,
      createChat: async () => chatStub("chat-1"),
      interruptChat: async (id: string) => chatStub(id),
      streamEvents: () =>
        (async function* () {
          yield status("running");
          throw new CoderAgentError("chat stream socket error");
        })(),
    };
    const model = new CoderLanguageModel({
      client: client as unknown as CoderChatClient,
      organizationId: "o",
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    await expect(drain(stream.getReader())).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "stream_closed",
      retryable: true,
    });
  });

  it("classifies a timeout during chat creation as a retryable timeout error", async () => {
    const client = {
      resolveModelConfigId: async () => undefined,
      // Hangs until the per-turn timeout aborts the signal, then rejects like fetch.
      createChat: async (_req: unknown, signal?: AbortSignal) => {
        await waitForAbort(signal);
        throw signal?.reason ?? new Error("aborted");
      },
      interruptChat: async (id: string) => chatStub(id),
      streamEvents: () => (async function* () {})(),
    };
    const model = new CoderLanguageModel({
      client: client as unknown as CoderChatClient,
      organizationId: "o",
      requestTimeoutMs: 30,
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    await expect(drain(stream.getReader())).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "timeout",
    });
  });

  it("interrupts the server run when the stream is cancelled mid-turn", async () => {
    let reached!: () => void;
    const midStream = new Promise<void>((r) => {
      reached = r;
    });
    const { client, interrupted } = stallingClient(reached);
    const model = new CoderLanguageModel({
      client: client as CoderChatClient,
      organizationId: "o",
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    const reader = stream.getReader();
    await reader.read(); // stream-start
    const pending = reader.read(); // drive to mid-stream, then block on the reader
    await midStream;
    await reader.cancel(); // teardown without aborting a caller signal
    await pending.catch(() => {});

    expect(interrupted).toEqual(["chat-1"]);
  });
});

describe("CoderLanguageModel guards", () => {
  it("warns that responseFormat is not enforced server-side", async () => {
    const fake = new FakeClient([
      [status("running"), msg(2, "assistant", [{ type: "text", text: "{}" }]), status("waiting")],
    ]);
    const model = new CoderLanguageModel({
      client: fake as unknown as CoderChatClient,
      organizationId: "o",
    });

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      responseFormat: { type: "json" },
    } as never);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value).toMatchObject({ type: "stream-start" });
    expect((first.value as { warnings: unknown[] }).warnings).toContainEqual(
      expect.objectContaining({ type: "unsupported", feature: "responseFormat" }),
    );
    await drain(reader);
  });

  it("throws on a prompt with no user message or tool results", async () => {
    const model = new CoderLanguageModel({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
    });
    const { stream } = await model.doStream({
      prompt: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    } as never);
    const reader = stream.getReader();
    await reader.read(); // stream-start
    await expect(reader.read()).rejects.toThrow(/no user message or tool results/);
  });

  it("rejects concurrent turns on one instance (single-flight)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking = {
      resolveModelConfigId: async () => undefined,
      createChat: async () => chatStub("c1", "o"),
      interruptChat: async (id: string) => chatStub(id),
      archiveChat: async () => {},
      // Yields one non-terminal event then blocks (on a releasable gate),
      // keeping turn 1 in-flight while we attempt a concurrent turn 2.
      streamEvents: async function* () {
        yield status("running");
        await gate;
      },
    };
    const model = new CoderLanguageModel({
      client: blocking as unknown as CoderChatClient,
      organizationId: "o",
    });

    const s1 = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    const r1 = s1.stream.getReader();
    await r1.read(); // starts turn 1 → sets in-flight

    const s2 = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi2" }] }],
    } as never);
    const r2 = s2.stream.getReader();
    await expect(r2.read()).rejects.toThrow(/single-flight/);

    release(); // let turn 1 unblock so cleanup completes
    await r1.cancel();
  }, 10_000);
});

/** One complete assistant turn (used to establish a chatId before cleanup tests). */
function okTurn(): ChatStreamEvent[] {
  return [
    status("running"),
    msg(2, "assistant", [{ type: "text", text: "hi" }]),
    status("waiting"),
  ];
}

function err409(): CoderApiError {
  return new CoderApiError({
    status: 409,
    method: "PATCH",
    path: "/api/experimental/chats/chat-1",
    message: "Chat is not in an archivable state.",
  });
}

/** A FakeClient with scripted archive behavior and interrupt/archive call recording. */
class ScriptedArchiveClient extends FakeClient {
  archiveCalls = 0;
  archiveSignals: (AbortSignal | undefined)[] = [];
  interrupted: { chatId: string; signal: AbortSignal | undefined }[] = [];
  interruptError: Error | undefined;
  readonly #archiveImpl: (attempt: number) => void;

  constructor(turns: ChatStreamEvent[][], archiveImpl: (attempt: number) => void) {
    super(turns);
    this.#archiveImpl = archiveImpl;
  }

  override async archiveChat(_chatId: string, signal?: AbortSignal): Promise<void> {
    this.archiveCalls += 1;
    this.archiveSignals.push(signal);
    this.#archiveImpl(this.archiveCalls);
  }

  override async interruptChat(chatId: string, signal?: AbortSignal): Promise<Chat> {
    this.interrupted.push({ chatId, signal });
    if (this.interruptError) throw this.interruptError;
    return chatStub(chatId);
  }
}

function settlingAgent(
  archiveImpl: (attempt: number) => void,
  timings?: { deadlineMs?: number; retryDelayMs?: number },
) {
  const fake = new ScriptedArchiveClient([okTurn()], archiveImpl);
  const agent = new CoderAgent({
    client: fake as unknown as CoderChatClient,
    organizationId: "org-1",
    settleDeadlineMs: timings?.deadlineMs ?? 5_000,
    settleRetryDelayMs: timings?.retryDelayMs ?? 10,
  });
  return { fake, agent };
}

describe("CoderAgent bounded cleanup (interrupt/archive/dispose)", () => {
  it("archive() retries a settling 409 and then succeeds", async () => {
    const { fake, agent } = settlingAgent((n) => {
      if (n <= 2) throw err409();
    });
    await agent.generate({ prompt: "hi" });
    await agent.archive();
    expect(fake.archiveCalls).toBe(3);
  });

  it("archive() is a no-op before any turn (no chat to archive)", async () => {
    const { fake, agent } = settlingAgent(() => {
      throw err409();
    });
    await agent.archive();
    expect(fake.archiveCalls).toBe(0);
  });

  it("archive() gives up with the last 409 once the deadline passes", async () => {
    const { fake, agent } = settlingAgent(
      () => {
        throw err409();
      },
      { deadlineMs: 80, retryDelayMs: 20 },
    );
    await agent.generate({ prompt: "hi" });
    await expect(agent.archive()).rejects.toMatchObject({ name: "CoderApiError", status: 409 });
    // Bounded: retried at least once, but capped by the deadline/backoff budget.
    expect(fake.archiveCalls).toBeGreaterThan(1);
    expect(fake.archiveCalls).toBeLessThanOrEqual(5);
  });

  it("archive() rethrows non-409 API errors immediately", async () => {
    const { fake, agent } = settlingAgent(() => {
      throw new CoderApiError({ status: 500, method: "PATCH", path: "/x", message: "boom" });
    });
    await agent.generate({ prompt: "hi" });
    await expect(agent.archive()).rejects.toMatchObject({ status: 500 });
    expect(fake.archiveCalls).toBe(1);
  });

  it("archive() rethrows non-API errors immediately", async () => {
    const { fake, agent } = settlingAgent(() => {
      throw new TypeError("fetch failed");
    });
    await agent.generate({ prompt: "hi" });
    await expect(agent.archive()).rejects.toThrow(TypeError);
    expect(fake.archiveCalls).toBe(1);
  });

  it("archive() forwards a signal to the client and stops retrying on caller abort", async () => {
    const { fake, agent } = settlingAgent(
      () => {
        throw err409();
      },
      { deadlineMs: 10_000, retryDelayMs: 5_000 },
    );
    await agent.generate({ prompt: "hi" });

    const ac = new AbortController();
    const outcome = agent.archive({ signal: ac.signal }).then(
      () => "resolved",
      (e: { name?: string }) => e?.name,
    );
    setTimeout(() => ac.abort(), 20); // abort during the first backoff pause
    expect(await outcome).toBe("AbortError");
    expect(fake.archiveCalls).toBe(1);
    // The client saw a real signal (the caller's, combined with the deadline).
    expect(fake.archiveSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it("interrupt() forwards the caller's signal to the client verbatim", async () => {
    const { fake, agent } = settlingAgent(() => {});
    await agent.generate({ prompt: "hi" });
    const ac = new AbortController();
    await agent.interrupt({ signal: ac.signal });
    expect(fake.interrupted).toEqual([{ chatId: "chat-1", signal: ac.signal }]);
  });

  it("[Symbol.asyncDispose] interrupts, then archives, under a shared deadline signal", async () => {
    const { fake, agent } = settlingAgent(() => {});
    await agent.generate({ prompt: "hi" });
    await agent[Symbol.asyncDispose]();
    expect(fake.interrupted).toHaveLength(1);
    expect(fake.archiveCalls).toBe(1);
    expect(fake.interrupted[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.archiveSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it("[Symbol.asyncDispose] never throws: interrupt failure + chat that never settles", async () => {
    const { fake, agent } = settlingAgent(
      () => {
        throw err409();
      },
      { deadlineMs: 60, retryDelayMs: 10 },
    );
    fake.interruptError = new Error("interrupt exploded");
    await agent.generate({ prompt: "hi" });
    await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(fake.archiveCalls).toBeGreaterThan(1); // retried before giving up quietly
  });

  it("[Symbol.asyncDispose] swallows immediate archive failures too", async () => {
    const { fake, agent } = settlingAgent(() => {
      throw new CoderApiError({ status: 500, method: "PATCH", path: "/x", message: "boom" });
    });
    await agent.generate({ prompt: "hi" });
    await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(fake.archiveCalls).toBe(1);
  });
});

describe("CoderAgent previews", () => {
  /** A fetch fake serving the v2 endpoints the preview helpers compose. */
  function previewFetch() {
    const routes: Record<string, () => Response> = {
      "/api/v2/workspaces/ws-1": () =>
        new Response(
          JSON.stringify({
            id: "ws-1",
            owner_name: "alice",
            name: "dev",
            latest_build: { resources: [{ agents: [{ name: "main" }] }] },
          }),
          { status: 200 },
        ),
      "/api/v2/applications/host": () =>
        new Response(JSON.stringify({ host: "*.apps.example.com" }), { status: 200 }),
      "/api/v2/workspaces/ws-1/port-share": () =>
        new Response(
          JSON.stringify({
            workspace_id: "ws-1",
            agent_name: "main",
            port: 3000,
            share_level: "public",
            protocol: "http",
          }),
          { status: 200 },
        ),
    };
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const route = routes[new URL(url).pathname];
      return Promise.resolve(route ? route() : new Response("{}", { status: 599 }));
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  }

  function previewAgent(fetchFn: typeof globalThis.fetch) {
    return new CoderAgent({
      baseUrl: "https://coder.example.com",
      token: "t",
      organizationId: "org-1",
      workspaceId: "ws-1",
      fetch: fetchFn,
    });
  }

  it("getPreview() requires the workspaceId setting", async () => {
    const agent = new CoderAgent({
      baseUrl: "https://coder.example.com",
      token: "t",
      organizationId: "org-1",
    });
    await expect(agent.getPreview({ port: 3000 })).rejects.toThrow(/workspaceId/);
  });

  it("getPreview() requires REST credentials when built from a bare client", async () => {
    const agent = new CoderAgent({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
      workspaceId: "ws-1",
    });
    await expect(agent.getPreview({ port: 3000 })).rejects.toThrow(/baseUrl/);
  });

  it("getPreview() composes the subdomain URL from the v2 API", async () => {
    const { fn } = previewFetch();
    await expect(previewAgent(fn).getPreview({ port: 3000 })).resolves.toEqual({
      url: "https://3000--main--dev--alice.apps.example.com",
    });
  });

  it("sharePreview() upserts the port share and returns the URL + level", async () => {
    const { fn, calls } = previewFetch();
    const result = await previewAgent(fn).sharePreview({ port: 3000, shareLevel: "public" });

    expect(result).toEqual({
      url: "https://3000--main--dev--alice.apps.example.com",
      shareLevel: "public",
    });
    const post = calls.find((c) => c.init.method === "POST" && c.url.includes("port-share"));
    expect(JSON.parse(String(post?.init.body))).toEqual({
      agent_name: "main",
      port: 3000,
      share_level: "public",
      protocol: "http",
    });
  });
});
