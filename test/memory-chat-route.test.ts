import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));
vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

// A client-executed tool call (no `execute` on the server side) ends the
// step — and this request's stream — with pending tool calls: the browser
// still has to run it and resend. This is the "continuation" request shape
// that must NOT count as a completed user turn (see routes/chat.ts's
// turnComplete computation).
function toolCallStreamChunks(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_editor_state",
      input: "{}",
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  ];
}

const capturedPrompts: string[] = [];

function mockModel(
  chunks: LanguageModelV3StreamPart[] = textStreamChunks("ok"),
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown }) => {
      capturedPrompts.push(JSON.stringify(options.prompt));
      return {
        stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
      };
    },
  });
}

function fakeMemoryStore(): MemoryStore & { loadSnapshot: ReturnType<typeof vi.fn> } {
  return {
    loadSnapshot: vi.fn(async () => ({ user: ["User prefers concise responses"], memory: [] })),
    applyOperations: vi.fn(),
    bumpCounters: vi.fn(async () => ({
      turnsSinceMemory: 1,
      stepsSinceSkill: 1,
      memoryReviewDue: false,
    })),
    writeAudit: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as MemoryStore & { loadSnapshot: ReturnType<typeof vi.fn> };
}

let app: FastifyInstance;
let url: string;
let store: ReturnType<typeof fakeMemoryStore>;

beforeAll(async () => {
  await loadSkills();
});

beforeEach(() => {
  holders.model = mockModel();
  capturedPrompts.length = 0;
});

async function start(memoryEnabled: boolean) {
  store = fakeMemoryStore();
  app = await buildApp(makeConfig({ MEMORY_ENABLED: memoryEnabled }), {
    logger: false,
    traceStore: null,
    showcaseStore: null,
    memoryStore: store,
  });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
}

afterAll(async () => {
  await app?.close();
});

async function postChat(body: unknown): Promise<string> {
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

describe("POST /api/chat — userId plumbing", () => {
  it("loads the caller's memory snapshot for a request carrying a userId", async () => {
    await start(true);
    await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(store.loadSnapshot).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    await app.close();
  });

  it("works unchanged without a userId and never reads memory", async () => {
    await start(true);
    const body = await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    expect(body).toContain("data: [DONE]");
    expect(store.loadSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a userId over 64 characters with 400", async () => {
    await start(true);
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        userId: "x".repeat(65),
      }),
    });
    expect(res.status).toBe(400);
    await app.close();
  });

  // Finding 5: a shape-invalid-but-length-legal userId (an older client
  // predating the UUID convention, or a malformed value) must NOT 400 — the
  // whole point is that the turn still succeeds, just without memory.
  it("silently disables memory for a non-UUID-shaped userId instead of 400ing", async () => {
    await start(true);
    const body = await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      userId: "user-abc",
    });
    expect(body).toContain("data: [DONE]");
    expect(store.loadSnapshot).not.toHaveBeenCalled();
    // Give the fire-and-forget review a tick to (not) run and confirm the
    // background review never engaged either.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.bumpCounters).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/chat — review only bumps the counter on a completed turn", () => {
  it("bumps turns_since_memory when the model's final step has no tool calls", async () => {
    holders.model = mockModel(textStreamChunks("ok"));
    await start(true);
    await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    await vi.waitFor(() => expect(store.bumpCounters).toHaveBeenCalledTimes(1));
    expect(store.bumpCounters).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", turns: 1 }),
    );
    await app.close();
  });

  it("bumps steps but NOT turns_since_memory on a continuation request (pending client tool call)", async () => {
    // A mid-turn request still calls bumpCounters — steps_since_skill must
    // accumulate every round-trip, not just the final one (see the
    // steps_since_skill fix in ai/selfimprove/review.ts) — but `turns` is 0:
    // a continuation is not a completed user turn, so turns_since_memory
    // must not move for it.
    holders.model = mockModel(toolCallStreamChunks());
    await start(true);
    await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    await vi.waitFor(() => expect(store.bumpCounters).toHaveBeenCalledTimes(1));
    expect(store.bumpCounters).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", turns: 0 }),
    );
    await app.close();
  });
});
