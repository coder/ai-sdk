import { APICallError } from "@ai-sdk/provider";
import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ChatFileInput,
  CoderChatClient,
  type UploadedChatFile,
} from "../../src/coder/client.js";
import { CoderAgent } from "../../src/agent/coder-agent.js";
import {
  CoderAgentError,
  CoderApiError,
  CoderChatError,
  CoderStreamError,
} from "../../src/errors.js";
import { CoderLanguageModel } from "../../src/model/language-model.js";
import type {
  Chat,
  ChatMessage,
  ChatMessagePart,
  ChatMessagesResponse,
  ChatStreamEvent,
  CreateChatMessageResponse,
  CreateChatRequest,
  SubmitToolResultsRequest,
} from "../../src/coder/types.js";
import type { WebSocketFactory, WebSocketLike } from "../../src/coder/ws.js";
import type { WorkspaceFileStore } from "../../src/workspace-files.js";

/** A scripted, in-memory stand-in for {@link CoderChatClient}. */
class FakeClient {
  turns: ChatStreamEvent[][];
  #turnIndex = 0;
  createdChats: CreateChatRequest[] = [];
  submitted: SubmitToolResultsRequest[] = [];
  uploads: ChatFileInput[] = [];
  #nextMessageId = 1000;
  /** streamEvents() invocations — one per dialed socket. */
  dials = 0;
  #live: { queue: ChatStreamEvent[]; wake: (() => void) | undefined; open: boolean } | undefined;

  constructor(turns: ChatStreamEvent[][]) {
    this.turns = turns;
  }

  /** Whether the most recently dialed stream is still open. */
  get liveOpen(): boolean {
    return this.#live?.open ?? false;
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
    // The resumed generation's events arrive on the LIVE stream — the model
    // retains the socket across the requires_action pause (#44), so the next
    // scripted batch is pushed rather than served by a fresh dial. Without a
    // live stream (never dialed, or already closed) the batch waits for the
    // next dial instead.
    if (this.#live?.open) {
      this.#live.queue.push(...(this.turns[this.#turnIndex++] ?? []));
      this.#live.wake?.();
    }
  }

  async uploadChatFile(_orgId: string, file: ChatFileInput): Promise<UploadedChatFile> {
    this.uploads.push(file);
    return {
      id: `file-${this.uploads.length}`,
      mediaType: file.mediaType ?? "application/octet-stream",
      name: file.name,
    };
  }

  /**
   * A live-subscription stand-in for the real stream reader: each dial
   * delivers the next scripted batch and then stays open (chatd's stream
   * outlives a settled turn), waiting for batches pushed by
   * {@link submitToolResults} on the retained socket. Ends only when the
   * stream's lifetime signal aborts (session close) or on generator teardown.
   */
  streamEvents(
    _chatId: string,
    opts?: { afterId?: number; signal?: AbortSignal },
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    this.dials += 1;
    const chan = {
      queue: [...(this.turns[this.#turnIndex++] ?? [])],
      wake: undefined as (() => void) | undefined,
      open: true,
    };
    this.#live = chan;
    const signal = opts?.signal;
    return (async function* () {
      try {
        while (!signal?.aborted) {
          while (chan.queue.length > 0) {
            // Simulate async delivery.
            await Promise.resolve();
            yield chan.queue.shift() as ChatStreamEvent;
          }
          // Idle live subscription: wait for the next pushed batch, waking on
          // the lifetime signal so close() can settle a pending read.
          await new Promise<void>((resolve) => {
            chan.wake = resolve;
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          chan.wake = undefined;
        }
      } finally {
        chan.open = false;
      }
    })();
  }

  async getMessages(): Promise<ChatMessagesResponse> {
    return { messages: [], queued_messages: [], has_more: false };
  }

  async archiveChat(_chatId: string, _signal?: AbortSignal): Promise<void> {}
  async interruptChat(_chatId: string, _signal?: AbortSignal): Promise<Chat> {
    throw new Error("not used");
  }
}

function msg(
  id: number,
  role: ChatMessage["role"],
  content: ChatMessagePart[],
  usage?: ChatMessage["usage"],
): ChatStreamEvent {
  return {
    type: "message",
    chat_id: "chat-1",
    message: { id, chat_id: "chat-1", role, created_at: "", content, usage },
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

    // ONE stream for the whole turn (#44): the requires_action pause retained
    // the socket and the resume segment read from it — no re-dial.
    expect(fake.dials).toBe(1);

    // The custom tool was registered as a chatd dynamic tool at chat creation.
    expect(fake.createdChats[0]?.unsafe_dynamic_tools?.map((t) => t.name)).toEqual(["getWeather"]);
  });

  it("interrupt() during tool execution closes the paused stream; the resume dials fresh", async () => {
    // agent.interrupt() between segments (while a client tool runs) kills the
    // paused turn: the retained socket must not survive it — it would buffer
    // the interrupt's own settle events, which the resume would then consume
    // as if they were the resumed generation's — so the resume re-dials.
    const interrupted: string[] = [];
    class InterruptibleClient extends FakeClient {
      override async interruptChat(chatId: string): Promise<Chat> {
        interrupted.push(chatId);
        return chatStub(chatId);
      }
    }
    const fake = new InterruptibleClient([
      [
        status("running"),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: "chat-1",
          action_required: {
            tool_calls: [{ tool_call_id: "tc1", tool_name: "getWeather", args: '{"city":"P"}' }],
          },
        },
      ],
      // Delivered AFTER the interrupt — on the fresh dial, not the dead pause.
      [
        status("running"),
        msg(3, "assistant", [{ type: "text", text: "Cut short." }]),
        status("waiting"),
      ],
    ]);
    let agent!: ReturnType<typeof makeAgent<Record<string, unknown>>>;
    const tools = {
      getWeather: tool({
        description: "Get weather",
        inputSchema: z.object({ city: z.string() }),
        execute: async () => {
          await agent.interrupt();
          return { temp: 0 };
        },
      }),
    };
    agent = makeAgent(fake, tools);

    const result = await agent.generate({ prompt: "weather?" });
    expect(interrupted).toEqual(["chat-1"]);
    // The paused socket was closed by the interrupt, so the resumed segment
    // dialed a fresh stream (which delivered the post-interrupt batch).
    expect(fake.dials).toBe(2);
    expect(result.text).toBe("Cut short.");
  });

  it("archive() releases a socket retained by an abandoned client-tool pause", async () => {
    // A tool WITHOUT an execute handler: the AI SDK stops after the pause and
    // returns the tool calls to the caller — the retained socket has no
    // resume coming. archive(), the guaranteed-cleanup path, must release it.
    const tools = {
      getWeather: tool({
        description: "Get weather",
        inputSchema: z.object({ city: z.string() }),
      }),
    };
    const fake = new FakeClient([
      [
        status("running"),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: "chat-1",
          action_required: {
            tool_calls: [{ tool_call_id: "tc1", tool_name: "getWeather", args: '{"city":"P"}' }],
          },
        },
      ],
    ]);
    const agent = makeAgent(fake, tools);
    const result = await agent.generate({ prompt: "weather?" });
    expect(result.finishReason).toBe("tool-calls");
    expect(fake.liveOpen).toBe(true); // paused, awaiting a resume that never comes

    await agent.archive();
    expect(fake.liveOpen).toBe(false);
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

describe("CoderAgent turn usage", () => {
  const weatherTools = () => ({
    getWeather: tool({
      description: "Get weather",
      inputSchema: z.object({ city: z.string() }),
      execute: async () => ({ temp: 21 }),
    }),
  });

  it("reports the whole turn's token consumption (all steps, cache included)", async () => {
    // Mirrors the real protocol: every committed assistant message carries
    // that step's usage, and chatd normalizes `input_tokens` to the UNCACHED
    // count. A turn that pauses for a client tool spans two segments.
    const fake = new FakeClient([
      // Segment 1: a server-tool step, then a step requesting the client tool.
      [
        status("running"),
        msg(1, "user", [{ type: "text", text: "hi" }]),
        msg(
          2,
          "assistant",
          [{ type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } }],
          { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 800, total_cost_micros: 100 },
        ),
        msg(3, "tool", [
          { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
        ]),
        msg(
          4,
          "assistant",
          [
            {
              type: "tool-call",
              tool_call_id: "c1",
              tool_name: "getWeather",
              args: { city: "Paris" },
            },
          ],
          { input_tokens: 1100, output_tokens: 40, total_cost_micros: 110 },
        ),
        status("requires_action"),
        {
          type: "action_required",
          chat_id: "chat-1",
          action_required: {
            tool_calls: [{ tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' }],
          },
        },
      ],
      // Segment 2 (resume after the tool result): the final text step.
      [
        status("running"),
        msg(5, "tool", [
          {
            type: "tool-result",
            tool_call_id: "c1",
            tool_name: "getWeather",
            result: { temp: 21 },
          },
        ]),
        msg(6, "assistant", [{ type: "text", text: "It is 21C in Paris." }], {
          input_tokens: 1200,
          output_tokens: 30,
          cache_read_tokens: 1000,
          total_cost_micros: 120,
          context_limit: 200000,
        }),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(fake, weatherTools());

    const result = await agent.generate({ prompt: "hi" });

    expect(result.text).toBe("It is 21C in Paris.");
    expect(result.finishReason).toBe("stop");
    expect(result.steps).toHaveLength(2);

    // Turn totals across all three model steps: full prompt size (uncached +
    // cache reads), not the near-zero uncached count of the last step only.
    expect(result.usage.inputTokens).toBe(1000 + 1100 + 1200 + 800 + 1000);
    expect(result.usage.outputTokens).toBe(50 + 40 + 30);
    expect(result.usage.inputTokenDetails.noCacheTokens).toBe(3300);
    expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(1800);

    // Cost is mirrored per step (each step sums its segment's chatd steps:
    // 100+110, then 120); whole-turn cost is the sum over the steps.
    expect(result.steps.map((s) => s.providerMetadata?.coder)).toEqual([
      { total_cost_micros: 210 },
      { total_cost_micros: 120 },
    ]);
  });

  it("resuming a chat does not absorb replayed history into the turn's usage or text", async () => {
    // A fresh instance resuming an existing chat (config.chatId) whose
    // submission gets QUEUED has no committed message id to anchor on; the
    // turn boundary must come from the chat's newest message, and the
    // full-history replay on the stream must not leak earlier turns' content
    // or usage into this turn.
    class ResumedChatClient extends FakeClient {
      override async getMessages(): Promise<ChatMessagesResponse> {
        // Newest-first, like the real endpoint's default paging.
        return {
          messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
          queued_messages: [],
          has_more: false,
        };
      }
      override async createChatMessage(): Promise<CreateChatMessageResponse> {
        return { queued: true }; // busy chat: no committed message in the response
      }
    }
    const fake = new ResumedChatClient([
      [
        status("running"),
        // Initial sync replays the chat's history (ids at or below 40).
        msg(38, "assistant", [{ type: "text", text: "old answer" }], {
          input_tokens: 999,
          output_tokens: 999,
          total_cost_micros: 999,
        }),
        msg(40, "assistant", [{ type: "text", text: "older answer" }], {
          input_tokens: 999,
          output_tokens: 999,
        }),
        // The queued message commits, then the turn's real step.
        msg(41, "user", [{ type: "text", text: "hi again" }]),
        msg(42, "assistant", [{ type: "text", text: "Fresh answer." }], {
          input_tokens: 100,
          output_tokens: 10,
        }),
        status("waiting"),
      ],
    ]);
    const agent = new CoderAgent({
      client: fake as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
    });

    const result = await agent.generate({ prompt: "hi again" });

    // Only the turn's own step counts — not the replayed history.
    expect(result.text).toBe("Fresh answer.");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
    // The replayed message's cost (999) must not surface either.
    expect(result.steps[0]?.providerMetadata).toBeUndefined();
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
    // No terminal status — the reader ended mid-run (with redial internal to
    // the real reader, a clean `done` means the stream was torn down
    // underneath the segment). Ends the generator explicitly: the FakeClient
    // models a live subscription that never ends on its own.
    const client = {
      resolveModelConfigId: async () => undefined,
      createChat: async () => chatStub("chat-1"),
      interruptChat: async (id: string) => chatStub(id),
      streamEvents: () =>
        (async function* () {
          yield status("running");
          yield textPart("partial…");
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

  it("resetSession() mid-segment still interrupts the orphaned server run", async () => {
    // Reset closes the attached stream and clears the session id; the failing
    // segment's teardown must interrupt THIS turn's run via its captured chat
    // id — otherwise the server generation keeps burning with no listener.
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
    const err = drain(stream.getReader()).then(
      () => undefined,
      (e: unknown) => e,
    );
    await midStream;
    model.resetSession();
    expect(await err).toMatchObject({ name: "CoderChatError", kind: "stream_closed" });
    expect(interrupted).toEqual(["chat-1"]);
    expect(model.chatId).toBeUndefined();
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

type StreamListener = (ev: unknown) => void;

/** A scripted WebSocket for driving the REAL stream reader (redial) end-to-end. */
class FakeStreamSocket {
  readonly url: string;
  /** Whether the CLIENT closed this socket (reader teardown). */
  closed = false;
  #listeners = new Map<string, Set<StreamListener>>();

  constructor(url: string) {
    this.url = url;
  }
  send(_data: string): void {}
  close(_code?: number): void {
    this.closed = true;
  }
  addEventListener(type: string, cb: StreamListener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: StreamListener): void {
    this.#listeners.get(type)?.delete(cb);
  }
  emit(type: "message" | "error" | "close", ev?: unknown): void {
    for (const cb of this.#listeners.get(type) ?? []) cb(ev);
  }
}

/**
 * A CoderLanguageModel wired to a REAL CoderChatClient with a scripted fetch
 * and WebSocket factory, so turns exercise the actual stream reader — redial,
 * replay suppression, and the interrupt policy — not a fake `streamEvents`.
 */
function redialModel(config?: {
  requestTimeoutMs?: number;
  chatId?: string;
  workspaceId?: string;
  /** Simulate a deployment that auto-assigns a workspace on chat creation. */
  serverAssignsWorkspace?: boolean;
  /** Simulate a deployment that auto-attaches MCP servers on chat creation. */
  serverAssignsMcpServers?: boolean;
  /** Scripted GET /messages body (cursor seeding and the requires_action REST fallback). */
  messagesResponse?: () => ChatMessagesResponse | Promise<ChatMessagesResponse>;
  /** Fail this many POST /tool-results calls with a 500 before succeeding. */
  toolResultsFailures?: number;
}) {
  const { serverAssignsWorkspace, serverAssignsMcpServers, messagesResponse, ...modelConfig } =
    config ?? {};
  let toolResultsFailures = config?.toolResultsFailures ?? 0;
  delete (modelConfig as { toolResultsFailures?: number }).toolResultsFailures;
  const sockets: FakeStreamSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const s = new FakeStreamSocket(url);
    sockets.push(s);
    return s as WebSocketLike;
  };
  const fetchCalls: string[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    fetchCalls.push(`${init.method} ${pathname}${search}`);
    if (init.method === "GET" && pathname.endsWith("/messages")) {
      const body = messagesResponse?.() ?? { messages: [], queued_messages: [], has_more: false };
      // Mirror real fetch: reject when the request signal aborts (the
      // requires_action fallback passes the turn signal through getMessages).
      return new Promise<Response>((resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          const onAbort = () => {
            fetchCalls.push(`ABORT ${pathname}${search}`);
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        }
        void Promise.resolve(body).then((b) =>
          resolve(
            new Response(JSON.stringify(b), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );
      });
    }
    if (init.method === "POST" && pathname.endsWith("/tool-results") && toolResultsFailures > 0) {
      toolResultsFailures -= 1;
      return Promise.resolve(
        new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    const body = {
      ...chatStub("chat-1"),
      ...(serverAssignsWorkspace ? { workspace_id: "ws-server" } : {}),
      ...(serverAssignsMcpServers ? { mcp_server_ids: ["mcp-server"] } : {}),
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new CoderChatClient({
    baseUrl: "https://x",
    token: "t",
    fetch: fetchFn,
    webSocketFactory: factory,
  });
  const model = new CoderLanguageModel({ client, organizationId: "org-1", ...modelConfig });
  return { model, client, sockets, fetchCalls };
}

const streamFrame = (...events: ChatStreamEvent[]) => ({ data: JSON.stringify(events) });
const deltaEv = (seq: number, text: string): ChatStreamEvent => ({
  type: "message_part",
  chat_id: "chat-1",
  message_part: {
    role: "assistant",
    part: { type: "text", text },
    history_version: 1,
    generation_attempt: 1,
    seq,
  },
});

describe("CoderLanguageModel stream redial (real reader)", () => {
  it("redials a dropped mid-turn stream and completes without duplicates or an interrupt", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const parts: { type: string; delta?: string }[] = [];
      const done = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          parts.push(value as { type: string; delta?: string });
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]?.emit("message", streamFrame(status("running"), deltaEv(1, "Hel")));
      await vi.advanceTimersByTimeAsync(0);
      // The socket drops mid-message. The reader must redial — NOT interrupt
      // the healthy server run.
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      // chatd replays the in-progress attempt from seq 1, then the rest of the
      // turn: the missed delta, the trailing snapshot, and the settle status.
      sockets[1]?.emit(
        "message",
        streamFrame(
          status("running"),
          deltaEv(1, "Hel"),
          deltaEv(2, "lo"),
          msg(2, "assistant", [{ type: "text", text: "Hello" }], {
            input_tokens: 3,
            output_tokens: 2,
          }),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await done;

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Hello");
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not duplicate earlier steps when a multi-step turn redials mid-turn", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const parts: { type: string; delta?: string }[] = [];
      const done = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          parts.push(value as { type: string; delta?: string });
        }
      })();

      const step1 = msg(
        2,
        "assistant",
        [
          { type: "text", text: "Step one" },
          { type: "tool-call", tool_call_id: "s1", tool_name: "web_search", args: { q: "x" } },
        ],
        { input_tokens: 10, output_tokens: 2 },
      );
      const toolMsg = msg(3, "tool", [
        { type: "tool-result", tool_call_id: "s1", tool_name: "web_search", result: { hits: 1 } },
      ]);
      await vi.advanceTimersByTimeAsync(0);
      // Step one commits (text + server tool round), then the socket drops.
      sockets[0]?.emit("message", streamFrame(status("running"), step1, toolMsg));
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      // The redial replays the whole turn from the original cursor, then the
      // turn finishes with step two.
      sockets[1]?.emit(
        "message",
        streamFrame(
          status("running"),
          step1,
          toolMsg,
          msg(4, "assistant", [{ type: "text", text: "Step two" }], {
            input_tokens: 20,
            output_tokens: 3,
          }),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await done;

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Step oneStep two");
      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits text committed while the stream was disconnected (snapshot longer than deltas)", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const parts: { type: string; delta?: string }[] = [];
      const done = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          parts.push(value as { type: string; delta?: string });
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), deltaEv(1, "Hel")));
      await vi.advanceTimersByTimeAsync(0);
      // Drop; the message COMMITS during the gap, so the redialed stream
      // replays only its full snapshot — no further deltas for that episode.
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      sockets[1]?.emit(
        "message",
        streamFrame(
          msg(2, "assistant", [{ type: "text", text: "Hello world" }], {
            input_tokens: 3,
            output_tokens: 4,
          }),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await done;

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Hello world");
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits the tail from a commit-during-disconnect snapshot when the text block already closed", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const parts: { type: string; delta?: string }[] = [];
      const done = (async () => {
        const reader = stream.getReader();
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          parts.push(value as { type: string; delta?: string });
        }
      })();

      await vi.advanceTimersByTimeAsync(0);
      // Text streams, then reasoning opens — closing the text block (#60's
      // closed-cursor case, unlike the open-block recovery above).
      sockets[0]?.emit(
        "message",
        streamFrame(status("running"), deltaEv(1, "A"), {
          type: "message_part",
          chat_id: "chat-1",
          message_part: {
            role: "assistant",
            part: { type: "reasoning", text: "Th" },
            history_version: 1,
            generation_attempt: 1,
            seq: 2,
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      // Drop; the message COMMITS during the gap with more reasoning AND more
      // text after the reasoning. The redialed stream replays only the full
      // snapshot — every remaining suffix must be emitted.
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      sockets[1]?.emit(
        "message",
        streamFrame(
          msg(2, "assistant", [
            { type: "text", text: "A" },
            { type: "reasoning", text: "Think" },
            { type: "text", text: "B" },
          ]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await done;

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("AB");
      const reasoning = parts
        .filter((p) => p.type === "reasoning-delta")
        .map((p) => p.delta)
        .join("");
      expect(reasoning).toBe("Think");
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts and surfaces an AI-SDK-retryable error once the redial budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      // The network dies for good. The first connection only ever delivered a
      // status — chatd replays one on every connect, so that is not progress —
      // and five progress-less connections exhaust the budget.
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(sockets).toHaveLength(5);
      const err = await done;
      // The error names the stranded chat (#113) — the discard below erases
      // the session's own id.
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: true, chatId: "chat-1" });
      expect(APICallError.isInstance(err)).toBe(true);
      // Redial exhaustion abandons the run — THAT is an interrupt case.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);
      // The dead session is discarded so an automatic retry (maxRetries) makes
      // a FRESH chat instead of double-submitting the prompt into this one.
      expect(model.chatId).toBeUndefined();
      // The stranded chat stays targetable for cleanup (#113).
      expect(model.lastKnownChatId).toBe("chat-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("downgrades exhaustion to non-retryable when server-side tools may have executed", async () => {
    vi.useFakeTimers();
    try {
      // A workspace-bound chat can run non-idempotent server-side tools before
      // the stream dies; an automatic replay would execute them again, and the
      // async interrupt cannot undo external effects. The dead fresh chat is
      // still discarded so a MANUAL retry does not attach to it.
      const { model, sockets } = redialModel({ workspaceId: "ws-1" });
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const err = await done;
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: false });
      expect(model.chatId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("downgrades exhaustion to non-retryable when the server auto-assigned a workspace", async () => {
    vi.useFakeTimers();
    try {
      // No workspaceId configured, but the deployment binds one at chat
      // creation (createChat's response carries workspace_id): its tools are
      // just as non-idempotent as an explicitly configured workspace's.
      const { model, sockets } = redialModel({ serverAssignsWorkspace: true });
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const err = await done;
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: false });
      expect(model.chatId).toBeUndefined(); // the dead fresh chat is still discarded
    } finally {
      vi.useRealTimers();
    }
  });

  it("downgrades exhaustion to non-retryable when the server auto-attached MCP servers", async () => {
    vi.useFakeTimers();
    try {
      // No mcpServerIds configured, but the deployment auto-attaches MCP
      // servers at chat creation (createChat's response carries
      // mcp_server_ids): their tools are just as non-idempotent as a
      // configured server's, so the exhaustion must not stay auto-retryable.
      const { model, sockets } = redialModel({ serverAssignsMcpServers: true });
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const err = await done;
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: false });
      expect(model.chatId).toBeUndefined(); // the dead fresh chat is still discarded
    } finally {
      vi.useRealTimers();
    }
  });

  it("downgrades exhaustion to non-retryable when the turn uploaded attachments", async () => {
    vi.useFakeTimers();
    try {
      // An inline file part is uploaded before the chat exists; an automatic
      // replay would upload it AGAIN, accumulating redundant file records.
      const { model, sockets } = redialModel();
      const { stream } = await model.doStream({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              {
                type: "file",
                data: { type: "data", data: new Uint8Array([1, 2, 3]) },
                mediaType: "text/plain",
                filename: "a.txt",
              },
            ],
          },
        ],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const err = await done;
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: false });
      expect(model.chatId).toBeUndefined(); // the dead fresh chat is still discarded
    } finally {
      vi.useRealTimers();
    }
  });

  it("downgrades exhaustion to non-retryable when the chat has prior state", async () => {
    vi.useFakeTimers();
    try {
      // Resuming a pre-existing chat: an automatic re-invocation would submit
      // the same prompt into it AGAIN as a new user turn, so isRetryable must
      // be false and the session must be kept for the caller to decide.
      const { model, sockets } = redialModel({ chatId: "chat-1" });
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running")));
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 5; i++) {
        sockets.at(-1)?.emit("close", { code: 1006 });
        await vi.advanceTimersByTimeAsync(30_000);
      }
      const err = await done;
      // The attached chat's id rides the downgraded wrap too (#113).
      expect(err).toMatchObject({ name: "CoderStreamError", isRetryable: false, chatId: "chat-1" });
      expect(APICallError.isInstance(err)).toBe(true);
      expect(model.chatId).toBe("chat-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestTimeoutMs bounds the segment across redial attempts", async () => {
    // Real timers: AbortSignal.timeout is not under vitest's fake-timer control.
    const { model, sockets, fetchCalls } = redialModel({ requestTimeoutMs: 50 });
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);
    const done = drain(stream.getReader()).then(
      () => undefined,
      (e: unknown) => e,
    );
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await tick();
    sockets[0]?.emit("message", streamFrame(status("running")));
    await tick();
    // Drop mid-turn: the reader starts a 1s redial sleep, but the 50ms budget
    // expires first — the timeout must cut through the backoff.
    sockets[0]?.emit("close", { code: 1006 });
    const err = await done;
    expect(err).toMatchObject({ name: "CoderChatError", kind: "timeout" });
    await tick();
    expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);
    expect(sockets).toHaveLength(1); // the budget expired before any redial
  });
});

/** A raw {@link ChatMessage} as returned by GET /messages (the REST fallback source). */
function historyMsg(
  id: number,
  role: ChatMessage["role"],
  content: ChatMessagePart[],
  usage?: ChatMessage["usage"],
): ChatMessage {
  return { id, chat_id: "chat-1", role, created_at: "", content, usage };
}

describe("CoderLanguageModel requires_action REST fallback (real reader)", () => {
  const GRACE_MS = 2_000;
  // The exact recovery request: cursor-less (newest-first — an `after_id`
  // cursor would page oldest-first and could truncate away the pending call)
  // at the endpoint's maximum page size.
  const GET_MESSAGES = "GET /api/experimental/chats/chat-1/messages?limit=200";
  const pendingCall: ChatMessagePart = {
    type: "tool-call",
    tool_call_id: "c1",
    tool_name: "getWeather",
    args: { city: "Paris" },
  };
  const weatherOptions = () =>
    ({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
      tools: [
        {
          type: "function",
          name: "getWeather",
          description: "Get weather",
          inputSchema: { type: "object" },
        },
      ],
    }) as never;
  const collect = (stream: ReadableStream<unknown>) => {
    const parts: Record<string, unknown>[] = [];
    const done = (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        parts.push(value as Record<string, unknown>);
      }
    })();
    return { parts, done };
  };

  it("recovers pending tool calls from history when action_required never arrives", async () => {
    vi.useFakeTimers();
    try {
      const content: ChatMessagePart[] = [{ type: "text", text: "Checking." }, pendingCall];
      const usage = { input_tokens: 7, output_tokens: 2 };
      const { model, sockets, fetchCalls } = redialModel({
        messagesResponse: () => ({
          messages: [historyMsg(3, "assistant", content, usage)],
          queued_messages: [],
          has_more: false,
        }),
      });
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      // The turn settles into requires_action; the assistant snapshot arrived
      // (it is DB-backed and replayed on reconnects) but the action_required
      // event never does — consumed by a previous connection.
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(3, "assistant", content, usage),
          status("requires_action"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Within the grace period nothing fires — no polling, no REST call.
      await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(0);

      // Grace expiry: one REST fetch recovers the pending tool call.
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);

      const toolCalls = parts.filter((p) => p.type === "tool-call");
      expect(toolCalls).toEqual([
        expect.objectContaining({
          toolCallId: "c1",
          toolName: "getWeather",
          input: '{"city":"Paris"}',
        }),
      ]);
      // Re-ingesting the REST snapshot of a message the stream already
      // delivered must not duplicate its text or double-count its usage.
      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(text).toBe("Checking.");
      const finish = parts.find((p) => p.type === "finish") as {
        finishReason: { unified: string; raw: string };
        usage: { inputTokens: { noCache?: number } };
      };
      expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: "requires_action" });
      expect(finish.usage.inputTokens.noCache).toBe(7);
      // The server run is legitimately paused for tool results — no interrupt.
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fires the fallback when action_required arrives promptly (fast path)", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(3, "assistant", [pendingCall]),
          status("requires_action"),
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await done;

      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      // Long after the segment completed: the canceled grace timer must not
      // have left anything behind that fetches.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late action_required within the grace period wins the race — no REST call, no duplicates", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(3, "assistant", [pendingCall]),
          status("requires_action"),
        ),
      );
      await vi.advanceTimersByTimeAsync(GRACE_MS - 500);
      sockets[0]?.emit("message", {
        data: JSON.stringify([
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ]),
      });
      await vi.advanceTimersByTimeAsync(0);
      await done;

      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits no duplicates when the stream delivers the event while the recovery fetch is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel({
        // The REST response takes 500ms — the WS event lands in that window.
        messagesResponse: () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  messages: [historyMsg(3, "assistant", [pendingCall])],
                  queued_messages: [],
                  has_more: false,
                }),
              500,
            ),
          ),
      });
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(3, "assistant", [pendingCall]),
          status("requires_action"),
        ),
      );
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);
      // The lost event shows up after all, mid-fetch.
      sockets[0]?.emit("message", {
        data: JSON.stringify([
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ]),
      });
      await vi.advanceTimersByTimeAsync(500);
      await done;

      expect(parts.filter((p) => p.type === "tool-call")).toEqual([
        expect.objectContaining({ toolCallId: "c1", toolName: "getWeather" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hanging recovery fetch does not block a late stream event from completing the segment", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel({
        // The REST request never settles; only the stream can finish the turn.
        messagesResponse: () => new Promise<ChatMessagesResponse>(() => {}),
      });
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);
      // Long after the fetch hung, the lost event arrives over the stream —
      // it must still complete the segment (no requestTimeoutMs is set, so a
      // serial await on the fetch would hang this turn forever).
      await vi.advanceTimersByTimeAsync(30_000);
      sockets[0]?.emit("message", {
        data: JSON.stringify([
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ]),
      });
      await vi.advanceTimersByTimeAsync(0);
      await done;
      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      // The losing (hung) recovery request was canceled at segment exit — it
      // must not outlive the turn and leak its connection.
      expect(
        fetchCalls.filter((c) => c.startsWith("ABORT ") && c.includes("/messages")),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from a truncated history page — the pending call rides the newest-first page", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel({
        // A turn too long for one page: only the newest messages are present
        // and has_more is set. The derivation needs only the tail (the last
        // assistant message and anything after it), which a cursor-less
        // newest-first read guarantees on the first page.
        messagesResponse: () => ({
          messages: [
            historyMsg(60, "assistant", [pendingCall]),
            historyMsg(59, "assistant", [{ type: "text", text: "an earlier step" }]),
          ],
          queued_messages: [],
          has_more: true,
        }),
      });
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      await done;

      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);
      expect(parts.filter((p) => p.type === "tool-call")).toEqual([
        expect.objectContaining({ toolCallId: "c1", toolName: "getWeather" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a JSON null tool argument during recovery", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = redialModel({
        messagesResponse: () => ({
          messages: [
            historyMsg(3, "assistant", [
              { type: "tool-call", tool_call_id: "c1", tool_name: "getWeather", args: null },
            ]),
          ],
          queued_messages: [],
          has_more: false,
        }),
      });
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      await done;

      // chatd would send the raw JSON text "null" — recovery must too, not "{}".
      expect(parts.filter((p) => p.type === "tool-call")).toEqual([
        expect.objectContaining({ toolCallId: "c1", input: "null" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is one-shot: an empty recovery keeps waiting on the stream without polling", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const { stream } = await model.doStream(weatherOptions());
      const { parts, done } = collect(stream);

      await vi.advanceTimersByTimeAsync(0);
      // History shows nothing pending (default empty messagesResponse).
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);
      // Much later: still exactly one fetch — no retry loop, no polling.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);

      // The stream can still complete the segment afterwards.
      sockets[0]?.emit("message", {
        data: JSON.stringify([
          {
            type: "action_required",
            chat_id: "chat-1",
            action_required: {
              tool_calls: [
                { tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' },
              ],
            },
          },
        ]),
      });
      await vi.advanceTimersByTimeAsync(0);
      await done;
      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects a caller abort that lands during the recovery fetch", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel({
        // The recovery fetch hangs; only the abort settles it.
        messagesResponse: () => new Promise<ChatMessagesResponse>(() => {}),
      });
      const abort = new AbortController();
      const { stream } = await model.doStream({
        ...(weatherOptions() as Record<string, unknown>),
        abortSignal: abort.signal,
      } as never);
      const done = drain(stream.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );

      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(1);

      abort.abort();
      const err = await done;
      expect(err).toMatchObject({ name: "AbortError" });
      // The abort interrupts the server run (standard abort policy).
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestTimeoutMs still bounds a requires_action wait shorter than the grace period", async () => {
    // Real timers: AbortSignal.timeout is not under vitest's fake-timer control.
    const { model, sockets, fetchCalls } = redialModel({ requestTimeoutMs: 50 });
    const { stream } = await model.doStream(weatherOptions());
    const done = drain(stream.getReader()).then(
      () => undefined,
      (e: unknown) => e,
    );
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await tick();
    sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
    // The 50ms budget expires long before the 2s grace: the timeout wins and
    // the fallback never fires.
    const err = await done;
    expect(err).toMatchObject({ name: "CoderChatError", kind: "timeout" });
    expect(fetchCalls.filter((c) => c === GET_MESSAGES)).toHaveLength(0);
    await tick();
    expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);
  });

  it("completes a full tool round-trip when segment 1 recovers via the fallback", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async ({ city }: { city: string }) => ({ city, tempC: 21 }));
      const tools = {
        getWeather: tool({
          description: "Get the weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute,
        }),
      };
      // The stream loses BOTH the assistant snapshot and the action_required
      // event; history is the sole source. Recovery must also advance the
      // message cursor so the resume segment does not replay the snapshot.
      const { client, sockets, fetchCalls } = redialModel({
        messagesResponse: () => ({
          messages: [
            historyMsg(3, "assistant", [{ type: "text", text: "Checking." }, pendingCall]),
          ],
          queued_messages: [],
          has_more: false,
        }),
      });
      const agent = new CoderAgent({ client, organizationId: "org-1", tools });
      const resultPromise = agent.generate({ prompt: "weather in Paris?" });

      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]?.emit("message", streamFrame(status("running"), status("requires_action")));
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      // Segment 1 recovered; the AI SDK executes the tool and resumes ON THE
      // RETAINED SOCKET (#44) — no second dial.
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toEqual({ city: "Paris" });
      expect(fetchCalls.filter((c) => c.includes("/tool-results"))).toHaveLength(1);
      expect(sockets).toHaveLength(1);

      // The resumed generation arrives on the same socket. The recovered
      // snapshot (id 3) advanced the cursor even though the stream never
      // delivered it — a late replay of it must be a no-op for the resume
      // segment, not duplicated text.
      sockets[0]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(3, "assistant", [{ type: "text", text: "Checking." }, pendingCall]),
          msg(5, "assistant", [{ type: "text", text: "It is 21C in Paris." }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;
      expect(result.text).toBe("It is 21C in Paris.");
      expect(result.steps).toHaveLength(2);
      // The terminal settle closed the retained socket.
      expect(sockets[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CoderLanguageModel stream reuse across segments (#44)", () => {
  const weatherTools = [
    {
      type: "function",
      name: "getWeather",
      description: "Get weather",
      inputSchema: { type: "object" },
    },
  ];
  const newTurnOptions = (abortSignal?: AbortSignal) =>
    ({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
      tools: weatherTools,
      ...(abortSignal ? { abortSignal } : {}),
    }) as never;
  /** The AI SDK's follow-up call after executing the client tool. */
  const resumeOptions = () =>
    ({
      prompt: [
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "getWeather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "getWeather",
              output: { type: "json", value: { temp: 21 } },
            },
          ],
        },
      ],
      tools: weatherTools,
    }) as never;
  const delta = (hv: number, seq: number, text: string): ChatStreamEvent => ({
    type: "message_part",
    chat_id: "chat-1",
    message_part: {
      role: "assistant",
      part: { type: "text", text },
      history_version: hv,
      generation_attempt: 1,
      seq,
    },
  });
  const actionRequired: ChatStreamEvent = {
    type: "action_required",
    chat_id: "chat-1",
    action_required: {
      tool_calls: [{ tool_call_id: "c1", tool_name: "getWeather", args: '{"city":"Paris"}' }],
    },
  };
  /** Segment 1 of the scripted turn: streams text, then pauses for the tool. */
  const segmentOne = [
    status("running"),
    delta(1, 1, "Checking."),
    msg(3, "assistant", [
      { type: "text", text: "Checking." },
      { type: "tool-call", tool_call_id: "c1", tool_name: "getWeather", args: { city: "Paris" } },
    ]),
    status("requires_action"),
    actionRequired,
  ];
  /** The resumed generation (a NEW episode: history_version bumped). */
  const segmentTwo = [
    status("running"),
    msg(4, "tool", [
      { type: "tool-result", tool_call_id: "c1", tool_name: "getWeather", result: { temp: 21 } },
    ]),
    delta(2, 1, "It is 21C."),
    msg(5, "assistant", [{ type: "text", text: "It is 21C." }]),
    status("waiting"),
  ];
  const collect = (stream: ReadableStream<unknown>) => {
    const parts: Record<string, unknown>[] = [];
    const done = (async () => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        parts.push(value as Record<string, unknown>);
      }
    })();
    return { parts, done };
  };
  const textOf = (parts: Record<string, unknown>[]) =>
    parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");

  it("reuses ONE socket across requires_action → resume → terminal settle", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();

      // Segment 1: new turn, settles at the client-tool pause.
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;
      expect(s1.parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      // The pause RETAINED the socket instead of closing it.
      expect(sockets[0]?.closed).toBe(false);

      // Segment 2: the tool-result resume reads the SAME socket — no re-dial.
      const s2 = collect((await model.doStream(resumeOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.filter((c) => c.includes("/tool-results"))).toHaveLength(1);
      expect(sockets).toHaveLength(1);
      sockets[0]?.emit("message", streamFrame(...segmentTwo));
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;

      expect(textOf(s2.parts)).toBe("It is 21C.");
      // No duplicate tool calls or text leaked across the boundary.
      expect(s2.parts.filter((p) => p.type === "tool-call")).toHaveLength(0);
      // The terminal settle closed the retained socket; the healthy paused run
      // was never interrupted.
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.closed).toBe(true);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers events buffered while paused (adopted pending read; nothing lost)", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = redialModel();
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;

      // The whole resumed generation arrives BEFORE the resume segment
      // attaches (the client was busy running the tool): it lands in the
      // paused stream's prefetched read + reader queue.
      sockets[0]?.emit("message", streamFrame(...segmentTwo));
      await vi.advanceTimersByTimeAsync(0);

      const s2 = collect((await model.doStream(resumeOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;
      expect(textOf(s2.parts)).toBe("It is 21C.");
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redials a drop during the pause with the TURN's cursor; the resume attaches to the redial", async () => {
    vi.useFakeTimers();
    try {
      // Resume an existing chat so the turn has a real starting cursor (the
      // newest committed message, id 2) that must be reused verbatim on the
      // redial — NOT the advanced per-segment cursor.
      const { model, sockets, fetchCalls } = redialModel({
        chatId: "chat-1",
        messagesResponse: () => ({
          messages: [historyMsg(2, "assistant", [])],
          queued_messages: [],
          has_more: false,
        }),
      });
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toContain("after_id=2");
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;

      // The socket drops while the client tool executes. The paused stream's
      // outstanding read keeps the redial machinery live: it redials in the
      // BACKGROUND (after backoff) with the turn's original cursor.
      sockets[0]?.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);
      expect(sockets[1]?.url).toContain("after_id=2");

      // The reconnect's initial sync replays the turn so far — including the
      // already-answered pause (chatd re-sends `action_required` while the
      // chat is still requires_action) — before the resumed generation.
      const s2 = collect((await model.doStream(resumeOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[1]?.emit(
        "message",
        streamFrame(
          status("requires_action"),
          msg(3, "assistant", [
            { type: "text", text: "Checking." },
            {
              type: "tool-call",
              tool_call_id: "c1",
              tool_name: "getWeather",
              args: { city: "Paris" },
            },
          ]),
          actionRequired,
          ...segmentTwo,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;

      // The replayed snapshot and pause must be no-ops for the resume segment:
      // no duplicated text, and — critically — no re-emitted tool call for the
      // already-submitted result (the SDK would execute the tool again).
      expect(textOf(s2.parts)).toBe("It is 21C.");
      expect(s2.parts.filter((p) => p.type === "tool-call")).toHaveLength(0);
      const finish = s2.parts.find((p) => p.type === "finish") as {
        finishReason: { unified: string };
      };
      expect(finish.finishReason.unified).toBe("stop");
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a per-segment abort closes the shared socket (never reusable); the next turn dials fresh", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel();
      const abort = new AbortController();
      const s1 = (await model.doStream(newTurnOptions(abort.signal))).stream;
      const err1 = drain(s1.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(status("running"), delta(1, 1, "Hel")));
      await vi.advanceTimersByTimeAsync(0);

      abort.abort();
      expect(await err1).toMatchObject({ name: "AbortError" });
      // The abort interrupted the server run AND closed the retained socket:
      // its half-read episode could never be reused, so keeping it open would
      // only leak the connection until session teardown.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);
      expect(sockets[0]?.closed).toBe(true);

      // The next turn dials fresh; no stale content leaks into it.
      const s2 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      sockets[1]?.emit(
        "message",
        streamFrame(
          status("running"),
          msg(6, "assistant", [{ type: "text", text: "Fresh." }]),
          status("waiting"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;
      expect(textOf(s2.parts)).toBe("Fresh.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the paused stream when the resume's tool-result submission fails; a retry dials fresh", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets, fetchCalls } = redialModel({ toolResultsFailures: 1 });
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;
      expect(sockets[0]?.closed).toBe(false); // paused, retained

      // The resume dies in the REST phase, BEFORE it takes ownership of the
      // retained stream. The dead turn must not leave the paused socket
      // behind: the run is interrupted (pushing interrupt-era events into its
      // buffer), so a retry attaching there would end before the resumed
      // generation. It must be closed instead.
      const failed = (await model.doStream(resumeOptions())).stream;
      const err = await drain(failed.getReader()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: "CoderApiError", status: 500 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[0]?.closed).toBe(true);
      expect(fetchCalls.filter((c) => c.includes("/interrupt"))).toHaveLength(1);

      // A retry re-submits (the failed ids were never marked submitted) and
      // dials FRESH instead of attaching to the dead stream's buffer.
      const s2 = collect((await model.doStream(resumeOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls.filter((c) => c.includes("/tool-results"))).toHaveLength(2);
      expect(sockets).toHaveLength(2);
      sockets[1]?.emit("message", streamFrame(...segmentTwo));
      await vi.advanceTimersByTimeAsync(0);
      await s2.done;
      expect(textOf(s2.parts)).toBe("It is 21C.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retain the stream when an abort lands while the pause's tool calls are being yielded", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = redialModel();
      const abort = new AbortController();
      const reader = (await model.doStream(newTurnOptions(abort.signal))).stream.getReader();
      // Pull until the tool-call part is out — the turn generator is then
      // suspended mid-settle, with retainStream about to be computed. (The
      // pulls also drive the turn to dial the socket in the first place.)
      const untilToolCall = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || (value as { type: string }).type === "tool-call") return;
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await untilToolCall;
      abort.abort();
      const err = await drain(reader).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ name: "AbortError" });

      // The segment rejected, so its pause was never delivered to the SDK: the
      // socket must be closed, not left paused-reusable — a retry attaching
      // would wait forever (the consumed requires_action events are not
      // re-sent without a reconnect).
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[Symbol.asyncDispose] closes a socket retained by a client-tool pause", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = redialModel();
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;
      expect(sockets[0]?.closed).toBe(false);

      await model[Symbol.asyncDispose]();
      expect(sockets[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetSession() closes the retained socket", async () => {
    vi.useFakeTimers();
    try {
      const { model, sockets } = redialModel();
      const s1 = collect((await model.doStream(newTurnOptions())).stream);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]?.emit("message", streamFrame(...segmentOne));
      await vi.advanceTimersByTimeAsync(0);
      await s1.done;

      model.resetSession();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets[0]?.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it("hostile settle knobs are sanitized so dispose still never throws", async () => {
    // AbortSignal.timeout rejects non-integer, negative, and non-finite delays
    // with a RangeError; the knobs must never let that reach dispose.
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -5, 1.5]) {
      const fake = new ScriptedArchiveClient([okTurn()], () => {});
      const agent = new CoderAgent({
        client: fake as unknown as CoderChatClient,
        organizationId: "org-1",
        settleDeadlineMs: bad,
        settleRetryDelayMs: bad,
      });
      await agent.generate({ prompt: "hi" });
      await expect(agent[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(fake.archiveCalls).toBe(1);
    }
  });
});

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

describe("CoderAgent previews", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    // Ambient credentials would satisfy the env fallback and mask the error.
    vi.stubEnv("CODER_URL", undefined);
    vi.stubEnv("CODER_SESSION_TOKEN", undefined);
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

describe("CoderAgent connection env defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Header record `workspaces.ts#request` builds for the v2 preview calls. */
  function sessionToken(init: RequestInit | undefined): string | undefined {
    return (init?.headers as Record<string, string> | undefined)?.["Coder-Session-Token"];
  }

  it("falls back to CODER_URL/CODER_SESSION_TOKEN when baseUrl/token are absent", async () => {
    vi.stubEnv("CODER_URL", "https://env.coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", "env-token");
    const { fn, calls } = previewFetch();
    const agent = new CoderAgent({ organizationId: "org-1", workspaceId: "ws-1", fetch: fn });
    // getPreview() surfaces the resolved credentials: the request URL carries
    // the base URL and the auth header carries the token.
    await expect(agent.getPreview({ port: 3000 })).resolves.toEqual({
      url: "https://3000--main--dev--alice.apps.example.com",
    });
    expect(calls[0]?.url).toBe("https://env.coder.example.com/api/v2/workspaces/ws-1");
    expect(sessionToken(calls[0]?.init)).toBe("env-token");
  });

  it("explicit baseUrl/token win over the environment", async () => {
    vi.stubEnv("CODER_URL", "https://env.coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", "env-token");
    const { fn, calls } = previewFetch();
    const agent = new CoderAgent({
      baseUrl: "https://explicit.coder.example.com",
      token: "explicit-token",
      organizationId: "org-1",
      workspaceId: "ws-1",
      fetch: fn,
    });
    await agent.getPreview({ port: 3000 });
    expect(calls[0]?.url).toBe("https://explicit.coder.example.com/api/v2/workspaces/ws-1");
    expect(sessionToken(calls[0]?.init)).toBe("explicit-token");
  });

  it("an explicit baseUrl pairs with an env token", async () => {
    vi.stubEnv("CODER_URL", undefined);
    vi.stubEnv("CODER_SESSION_TOKEN", "env-token");
    const { fn, calls } = previewFetch();
    const agent = new CoderAgent({
      baseUrl: "https://explicit.coder.example.com",
      organizationId: "org-1",
      workspaceId: "ws-1",
      fetch: fn,
    });
    await agent.getPreview({ port: 3000 });
    expect(calls[0]?.url).toBe("https://explicit.coder.example.com/api/v2/workspaces/ws-1");
    expect(sessionToken(calls[0]?.init)).toBe("env-token");
  });

  it("an env baseUrl pairs with an explicit token", async () => {
    vi.stubEnv("CODER_URL", "https://env.coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", undefined);
    const { fn, calls } = previewFetch();
    const agent = new CoderAgent({
      token: "explicit-token",
      organizationId: "org-1",
      workspaceId: "ws-1",
      fetch: fn,
    });
    await agent.getPreview({ port: 3000 });
    expect(calls[0]?.url).toBe("https://env.coder.example.com/api/v2/workspaces/ws-1");
    expect(sessionToken(calls[0]?.init)).toBe("explicit-token");
  });

  it("throws without settings or env credentials, naming the env fallback", () => {
    vi.stubEnv("CODER_URL", undefined);
    vi.stubEnv("CODER_SESSION_TOKEN", undefined);
    expect(() => new CoderAgent({ organizationId: "org-1" })).toThrow(
      /CODER_URL and CODER_SESSION_TOKEN/,
    );
    // One env var alone (here: the token) does not satisfy the pair.
    vi.stubEnv("CODER_SESSION_TOKEN", "env-token");
    expect(() => new CoderAgent({ organizationId: "org-1" })).toThrow(CoderAgentError);
  });

  it("client-only construction survives environments without `process`", () => {
    // Browser bundles have no `process` global; the env lookup must not turn
    // the documented client-only form into a ReferenceError.
    vi.stubGlobal("process", undefined);
    try {
      const agent = new CoderAgent({
        client: new FakeClient([]) as unknown as CoderChatClient,
        organizationId: "org-1",
      });
      expect(agent.chatId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("client-only construction resolves env credentials for the preview helpers", async () => {
    vi.stubEnv("CODER_URL", "https://env.coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", "env-token");
    const { fn, calls } = previewFetch();
    const agent = new CoderAgent({
      client: new FakeClient([]) as unknown as CoderChatClient,
      organizationId: "org-1",
      workspaceId: "ws-1",
      fetch: fn,
    });
    await expect(agent.getPreview({ port: 3000 })).resolves.toEqual({
      url: "https://3000--main--dev--alice.apps.example.com",
    });
    expect(sessionToken(calls[0]?.init)).toBe("env-token");
  });
});

/**
 * Stranded-chat cleanup (#113): a fresh-chat stream failure discards the
 * session (so a retry starts on a fresh chat) — but the failed chat still
 * exists server-side. The thrown CoderStreamError names it, and
 * archive()/interrupt() keep targeting it via the last-known chat id instead
 * of silently no-oping.
 */
describe("stranded chat cleanup (#113)", () => {
  /**
   * A client whose first `failures` dialed streams fail terminally with a
   * CoderStreamError — standing in for the real reader's redial exhaustion,
   * which stamps the chat id it streamed (see ws.ts) — stranding the chat the
   * turn created. Later dials serve the scripted turns normally, and chat ids
   * are sequential so a post-discard chat is distinguishable from the
   * stranded one.
   */
  class StrandingClient extends FakeClient {
    archived: string[] = [];
    interrupted: string[] = [];
    /** Omit chatId from thrown errors (a custom stream source that doesn't stamp). */
    omitChatId = false;
    #failures: number;
    #chatSeq = 0;
    constructor(turns: ChatStreamEvent[][], failures = 1) {
      super(turns);
      this.#failures = failures;
    }
    override async createChat(req: CreateChatRequest): Promise<Chat> {
      this.createdChats.push(req);
      return chatStub(`chat-${++this.#chatSeq}`, req.organization_id);
    }
    override streamEvents(
      chatId: string,
      opts?: { afterId?: number; signal?: AbortSignal },
    ): AsyncGenerator<ChatStreamEvent, void, void> {
      if (this.#failures > 0) {
        this.#failures -= 1;
        const args: ConstructorParameters<typeof CoderStreamError>[0] = {
          message: "stream lost (test)",
          url: "wss://x/stream",
        };
        if (!this.omitChatId) args.chatId = chatId;
        return (async function* () {
          // The run started streaming, then the connection died for good.
          yield status("running");
          throw new CoderStreamError(args);
        })();
      }
      return super.streamEvents(chatId, opts);
    }
    override async archiveChat(chatId: string): Promise<void> {
      this.archived.push(chatId);
    }
    override async interruptChat(chatId: string): Promise<Chat> {
      this.interrupted.push(chatId);
      return chatStub(chatId);
    }
  }

  const settledTurn = [
    status("running"),
    textPart("ok"),
    msg(2, "assistant", [{ type: "text", text: "ok" }]),
    status("waiting"),
  ];

  async function strandedAgent(failures = 1, turns: ChatStreamEvent[][] = []) {
    const fake = new StrandingClient(turns, failures);
    const agent = makeAgent(fake);
    const err = await agent.generate({ prompt: "hi" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { fake, agent, err };
  }

  it("surfaces the stranded chat id on the error and retains it after the discard", async () => {
    const { agent, err } = await strandedAgent();
    expect(err).toMatchObject({ name: "CoderStreamError", chatId: "chat-1" });
    // The session was discarded (a retry starts fresh) …
    expect(agent.chatId).toBeUndefined();
    // … but the cleanup target survives it.
    expect(agent.lastKnownChatId).toBe("chat-1");
  });

  it("archive() targets the last-known chat after a discard and clears it on success", async () => {
    const { fake, agent } = await strandedAgent();
    expect(agent.strandedChatIds).toEqual(["chat-1"]);
    await expect(agent.archive()).resolves.toEqual({
      archived: true,
      chatId: "chat-1",
      archivedChatIds: ["chat-1"],
    });
    expect(fake.archived).toEqual(["chat-1"]);
    expect(agent.lastKnownChatId).toBeUndefined();
    expect(agent.strandedChatIds).toEqual([]);
    // Cleanup succeeded against it — a second archive has nothing to target.
    await expect(agent.archive()).resolves.toEqual({ archived: false });
    expect(fake.archived).toEqual(["chat-1"]);
  });

  it("stamps the turn's chat id on stream errors from sources that don't name it", async () => {
    // A custom client's stream source may throw a CoderStreamError without a
    // chatId; the model layer must stamp the turn's own id so the documented
    // "the error names the failed turn's chat" guarantee still holds.
    const fake = new StrandingClient([]);
    fake.omitChatId = true;
    const agent = makeAgent(fake);
    const err = await agent.generate({ prompt: "hi" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: "CoderStreamError", chatId: "chat-1" });
  });

  it("accumulates every chat stranded by repeated failures and archive() retires them all", async () => {
    // Each failed fresh-chat attempt strands its own chat (an AI-SDK
    // maxRetries loop does exactly this); a single last-known slot would leak
    // all but the newest.
    const { fake, agent } = await strandedAgent(2, [settledTurn]);
    const err2 = await agent.generate({ prompt: "again" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err2).toMatchObject({ name: "CoderStreamError", chatId: "chat-2" });
    expect(agent.lastKnownChatId).toBe("chat-2");
    expect(agent.strandedChatIds).toEqual(["chat-1", "chat-2"]);
    // A successful turn supersedes the cleanup target but keeps the ledger.
    const result = await agent.generate({ prompt: "third time lucky" });
    expect(result.text).toBe("ok");
    expect(agent.chatId).toBe("chat-3");
    expect(agent.strandedChatIds).toEqual(["chat-1", "chat-2"]);
    // One archive() retires the stranded chats AND the live session's chat.
    await expect(agent.archive()).resolves.toEqual({
      archived: true,
      chatId: "chat-3",
      archivedChatIds: ["chat-1", "chat-2", "chat-3"],
    });
    expect(fake.archived).toEqual(["chat-1", "chat-2", "chat-3"]);
    expect(agent.strandedChatIds).toEqual([]);
    expect(agent.lastKnownChatId).toBeUndefined();
  });

  it("archive() spends ONE settle window across the whole batch, not one per target", async () => {
    /** 409s archiveChat a scripted number of times per chat before succeeding. */
    class SettlingClient extends StrandingClient {
      /** chat id → number of 409s left to serve (Infinity = never settles). */
      readonly fail409 = new Map<string, number>();
      readonly archiveAttempts: string[] = [];
      override async archiveChat(chatId: string): Promise<void> {
        this.archiveAttempts.push(chatId);
        const left = this.fail409.get(chatId) ?? 0;
        if (left > 0) {
          this.fail409.set(chatId, left - 1);
          throw new CoderApiError({
            status: 409,
            method: "PATCH",
            path: `/chats/${chatId}`,
            message: "chat is still settling",
          });
        }
        await super.archiveChat(chatId);
      }
    }
    const fake = new SettlingClient([], 2);
    const agent = new CoderAgent({
      client: fake as unknown as CoderChatClient,
      organizationId: "org-1",
      settleDeadlineMs: 400,
      settleRetryDelayMs: 100,
    });
    for (let i = 0; i < 2; i++) {
      await agent.generate({ prompt: "hi" }).then(
        () => undefined,
        () => undefined,
      );
    }
    expect(agent.strandedChatIds).toEqual(["chat-1", "chat-2"]);
    // chat-1 needs three 409 rounds (~3/4 of the shared window) to settle;
    // chat-2 never settles. Sharing the window means chat-2 only gets the
    // remnant — an attempt or two — instead of a fresh full window, and the
    // whole call stays bounded by ~settleDeadlineMs.
    fake.fail409.set("chat-1", 3);
    fake.fail409.set("chat-2", Infinity);
    await expect(agent.archive()).rejects.toMatchObject({ name: "CoderApiError", status: 409 });
    // chat-1 settled and was cleared; chat-2's failure left it targetable.
    expect(fake.archived).toEqual(["chat-1"]);
    expect(agent.strandedChatIds).toEqual(["chat-2"]);
    // A fresh per-target window would fit ~4 attempts (400ms / 100ms).
    expect(fake.archiveAttempts.filter((id) => id === "chat-2").length).toBeLessThanOrEqual(2);
    // The leftover is retired by a later call.
    fake.fail409.clear();
    await expect(agent.archive()).resolves.toEqual({
      archived: true,
      chatId: "chat-2",
      archivedChatIds: ["chat-2"],
    });
    expect(agent.strandedChatIds).toEqual([]);
  });

  it("interrupt() targets the last-known chat after a discard", async () => {
    const { fake, agent } = await strandedAgent();
    await expect(agent.interrupt()).resolves.toEqual({ interrupted: true, chatId: "chat-1" });
    // The turn's own teardown already interrupted the dying run (existing
    // behavior); the EXPLICIT call must reach the same stranded chat.
    expect(fake.interrupted.at(-1)).toBe("chat-1");
    // Interrupting is not terminal cleanup: the chat still needs archiving.
    expect(agent.lastKnownChatId).toBe("chat-1");
  });

  it("generate() after a discard still creates a fresh chat, superseding the cleanup target", async () => {
    const { fake, agent } = await strandedAgent(1, [settledTurn]);
    const result = await agent.generate({ prompt: "again" });
    expect(result.text).toBe("ok");
    // A NEW chat — the retry did not resurrect the stranded session …
    expect(fake.createdChats).toHaveLength(2);
    expect(agent.chatId).toBe("chat-2");
    // … and the new chat supersedes the stranded one as the PRIMARY cleanup
    // target, while the stranded id stays on the ledger until archived.
    expect(agent.lastKnownChatId).toBe("chat-2");
    expect(agent.strandedChatIds).toEqual(["chat-1"]);
    await expect(agent.archive()).resolves.toEqual({
      archived: true,
      chatId: "chat-2",
      archivedChatIds: ["chat-1", "chat-2"],
    });
  });

  it("archive()/interrupt() with no chat at all report the no-op instead of silently succeeding", async () => {
    const fake = new StrandingClient([], 0);
    const agent = makeAgent(fake);
    await expect(agent.archive()).resolves.toEqual({ archived: false });
    await expect(agent.interrupt()).resolves.toEqual({ interrupted: false });
    expect(fake.archived).toEqual([]);
    expect(fake.interrupted).toEqual([]);
  });

  it("disposal archives a stranded chat instead of leaking it", async () => {
    const { fake, agent } = await strandedAgent();
    await agent[Symbol.asyncDispose]();
    expect(fake.archived).toEqual(["chat-1"]);
  });
});

// --- queued submissions (#114) ---------------------------------------------------

/**
 * A `queue_update` stream event carrying the full queue with the given ids.
 * Mirrors the wire's `omitempty` field: an empty queue omits `queued_messages`.
 */
function queueUpdate(...ids: number[]): ChatStreamEvent {
  const ev: ChatStreamEvent = { type: "queue_update", chat_id: "chat-1" };
  if (ids.length > 0) {
    ev.queued_messages = ids.map((id) => ({ id, chat_id: "chat-1", content: [], created_at: "" }));
  }
  return ev;
}

/** A fake for QUEUED submissions: busy chat, entry id 7, newest message id 40. */
class QueuedChatClient extends FakeClient {
  getMessagesCalls = 0;
  override async getMessages(): Promise<ChatMessagesResponse> {
    this.getMessagesCalls += 1;
    return {
      messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
      queued_messages: [],
      has_more: false,
    };
  }
  override async createChatMessage(): Promise<CreateChatMessageResponse> {
    return {
      queued: true,
      queued_message: {
        id: 7,
        chat_id: "chat-1",
        content: [{ type: "text", text: "hi again" }],
        created_at: "",
      },
    };
  }
}

/** The concurrent (dying) run's tail, then our entry's materialization + run. */
const queuedTurnEvents: ChatStreamEvent[] = [
  status("running"),
  textPart("old tail"),
  msg(41, "assistant", [{ type: "text", text: "old tail" }], {
    input_tokens: 999,
    output_tokens: 999,
    total_cost_micros: 999,
  }),
  // The concurrent run settles — this must NOT settle the queued turn.
  status("waiting"),
  // The queued entry materializes as this turn's user message; the queue
  // update confirming our entry left the queue follows in the same flush.
  msg(42, "user", [{ type: "text", text: "hi again" }]),
  queueUpdate(),
  status("running"),
  textPart("Fresh answer."),
  msg(43, "assistant", [{ type: "text", text: "Fresh answer." }], {
    input_tokens: 100,
    output_tokens: 10,
  }),
  status("waiting"),
];

describe("queued submissions (#114)", () => {
  it("does not absorb the concurrent run's tail: content, usage, and settle all start at the own user message", async () => {
    const fake = new QueuedChatClient([queuedTurnEvents]);
    const agent = new CoderAgent({
      client: fake as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
    });

    const result = await agent.generate({ prompt: "hi again" });

    expect(result.text).toBe("Fresh answer.");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
    // The dying run's cost must not leak into provider metadata either.
    expect(result.steps[0]?.providerMetadata).toBeUndefined();
  });

  it("withdraws the queue entry on timeout instead of interrupting the concurrent run", async () => {
    const interrupted: string[] = [];
    const deleted: Array<[string, number]> = [];
    const client = {
      resolveModelConfigId: async () => undefined,
      getMessages: async () => ({
        messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
        queued_messages: [],
        has_more: false,
      }),
      createChatMessage: async () => ({
        queued: true,
        queued_message: { id: 7, chat_id: "chat-1", content: [], created_at: "" },
      }),
      interruptChat: async (id: string) => {
        interrupted.push(id);
        return chatStub(id);
      },
      deleteQueuedMessage: async (id: string, queuedMessageId: number) => {
        deleted.push([id, queuedMessageId]);
      },
      archiveChat: async () => {},
      streamEvents: (_id: string, opts?: { signal?: AbortSignal }) =>
        (async function* () {
          // The concurrent run keeps streaming; our entry never materializes.
          yield status("running");
          await waitForAbort(opts?.signal);
        })(),
    };
    const agent = new CoderAgent({
      client: client as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
      requestTimeoutMs: 30,
    });

    await expect(agent.generate({ prompt: "hi again" })).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "timeout",
    });
    // The dead turn's prompt must not run unattended later — and the
    // OTHER submission's run must not be interrupted.
    expect(deleted).toEqual([["chat-1", 7]]);
    expect(interrupted).toEqual([]);
  });

  it("interrupts normally once the queued turn has anchored", async () => {
    const interrupted: string[] = [];
    const deleted: Array<[string, number]> = [];
    const client = {
      resolveModelConfigId: async () => undefined,
      getMessages: async () => ({
        messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
        queued_messages: [],
        has_more: false,
      }),
      createChatMessage: async () => ({
        queued: true,
        queued_message: {
          id: 7,
          chat_id: "chat-1",
          content: [{ type: "text", text: "hi again" }],
          created_at: "",
        },
      }),
      interruptChat: async (id: string) => {
        interrupted.push(id);
        return chatStub(id);
      },
      deleteQueuedMessage: async (id: string, queuedMessageId: number) => {
        deleted.push([id, queuedMessageId]);
      },
      archiveChat: async () => {},
      streamEvents: (_id: string, opts?: { signal?: AbortSignal }) =>
        (async function* () {
          // Our entry materializes and is confirmed; the run then stalls.
          yield msg(42, "user", [{ type: "text", text: "hi again" }]);
          yield queueUpdate();
          yield status("running");
          await waitForAbort(opts?.signal);
        })(),
    };
    const agent = new CoderAgent({
      client: client as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
      requestTimeoutMs: 30,
    });

    await expect(agent.generate({ prompt: "hi again" })).rejects.toMatchObject({
      kind: "timeout",
    });
    // Anchored: the active run IS this turn's — interrupt it, keep no entry.
    expect(interrupted).toEqual(["chat-1"]);
    expect(deleted).toEqual([]);
  });

  it("fails fast when the concurrent run settles in error (the queue is not auto-promoted)", async () => {
    const deleted: Array<[string, number]> = [];
    const interrupted: string[] = [];
    const client = {
      resolveModelConfigId: async () => undefined,
      getMessages: async () => ({
        messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
        queued_messages: [],
        has_more: false,
      }),
      createChatMessage: async () => ({
        queued: true,
        queued_message: { id: 7, chat_id: "chat-1", content: [], created_at: "" },
      }),
      interruptChat: async (id: string) => {
        interrupted.push(id);
        return chatStub(id);
      },
      deleteQueuedMessage: async (id: string, queuedMessageId: number) => {
        deleted.push([id, queuedMessageId]);
      },
      archiveChat: async () => {},
      streamEvents: (_id: string, opts?: { signal?: AbortSignal }) =>
        (async function* () {
          yield status("running");
          yield status("error");
          yield {
            type: "error",
            chat_id: "chat-1",
            error: { message: "boom" },
          } as ChatStreamEvent;
          await waitForAbort(opts?.signal);
        })(),
    };
    const agent = new CoderAgent({
      client: client as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
    });

    await expect(agent.generate({ prompt: "hi again" })).rejects.toMatchObject({
      name: "CoderChatError",
      kind: "queued_submission_lost",
      retryable: false,
    });
    // The stuck entry is withdrawn so it cannot run unattended after a
    // later revival of the errored chat; nothing is interrupted.
    expect(deleted).toEqual([["chat-1", 7]]);
    expect(interrupted).toEqual([]);
  });
});

// --- resume cursor (#115) --------------------------------------------------------

describe("resume cursor (#115)", () => {
  it("a supplied cursor skips the seed GET; absent, the seed GET still runs", async () => {
    class CountingClient extends FakeClient {
      getMessagesCalls = 0;
      override async getMessages(): Promise<ChatMessagesResponse> {
        this.getMessagesCalls += 1;
        return {
          messages: [{ id: 40, chat_id: "chat-1", role: "assistant", created_at: "" }],
          queued_messages: [],
          has_more: false,
        };
      }
    }
    const turn = () => [
      status("running"),
      msg(1002, "assistant", [{ type: "text", text: "Resumed." }]),
      status("waiting"),
    ];

    const withCursor = new CountingClient([turn()]);
    const agent = new CoderAgent({
      client: withCursor as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
      lastSeenMessageId: 40,
    });
    const result = await agent.generate({ prompt: "hi again" });
    expect(result.text).toBe("Resumed.");
    expect(withCursor.getMessagesCalls).toBe(0);

    const withoutCursor = new CountingClient([turn()]);
    const seeded = new CoderAgent({
      client: withoutCursor as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
    });
    await seeded.generate({ prompt: "hi again" });
    expect(withoutCursor.getMessagesCalls).toBe(1);
  });

  it("the getter round-trips: persist chatId + cursor, resume without the seed GET", async () => {
    class CountingClient extends FakeClient {
      getMessagesCalls = 0;
      override async getMessages(): Promise<ChatMessagesResponse> {
        this.getMessagesCalls += 1;
        return { messages: [], queued_messages: [], has_more: false };
      }
    }
    const first = new FakeClient([
      [
        status("running"),
        msg(2, "assistant", [{ type: "text", text: "Hello!" }]),
        status("waiting"),
      ],
    ]);
    const agent = makeAgent(first);
    // Nothing to persist before any turn has streamed.
    expect(agent.lastSeenMessageId).toBeUndefined();
    await agent.generate({ prompt: "hi" });
    expect(agent.chatId).toBe("chat-1");
    expect(agent.lastSeenMessageId).toBe(2);

    // A fresh instance resumes with the persisted pair — no seed GET.
    const second = new CountingClient([
      [
        status("running"),
        msg(1002, "assistant", [{ type: "text", text: "Still here." }]),
        status("waiting"),
      ],
    ]);
    const resumed = new CoderAgent({
      client: second as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: agent.chatId!,
      lastSeenMessageId: agent.lastSeenMessageId,
    });
    const result = await resumed.generate({ prompt: "more" });
    expect(result.text).toBe("Still here.");
    expect(second.getMessagesCalls).toBe(0);
    expect(resumed.lastSeenMessageId).toBe(1002);
  });

  it("a queued submission composes with a supplied cursor: no seed GET, no misattribution", async () => {
    const fake = new QueuedChatClient([
      [
        // Initial sync replays history at or below the supplied cursor too.
        msg(38, "assistant", [{ type: "text", text: "old answer" }], { input_tokens: 999 }),
        msg(40, "assistant", [{ type: "text", text: "older answer" }], { input_tokens: 999 }),
        ...queuedTurnEvents,
      ],
    ]);
    const agent = new CoderAgent({
      client: fake as unknown as CoderChatClient,
      organizationId: "org-1",
      chatId: "chat-1",
      lastSeenMessageId: 40,
    });

    const result = await agent.generate({ prompt: "hi again" });

    expect(fake.getMessagesCalls).toBe(0);
    expect(result.text).toBe("Fresh answer.");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
    expect(agent.lastSeenMessageId).toBe(43);
  });
});
