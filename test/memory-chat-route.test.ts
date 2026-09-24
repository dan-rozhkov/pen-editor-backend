import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import { chatMocks, mockModel, textStreamChunks, toolCallStreamChunks, userMessage } from "./chatMocks.js";
import { chatTurn, startApp, type RunningApp } from "./chatHarness.js";

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

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

let server: RunningApp;
let store: ReturnType<typeof fakeMemoryStore>;

beforeAll(async () => {
  await loadSkills();
});

beforeEach(() => {
  chatMocks.model = mockModel(textStreamChunks("ok"));
});

async function start(memoryEnabled: boolean) {
  store = fakeMemoryStore();
  server = await startApp(makeConfig({ MEMORY_ENABLED: memoryEnabled }), {
    traceStore: null,
    showcaseStore: null,
    memoryStore: store,
  });
}

afterAll(async () => {
  await server?.close();
});

async function postChat(body: unknown): Promise<string> {
  return (await chatTurn(server.url, body)).body;
}

describe("POST /api/chat — userId plumbing", () => {
  it("loads the caller's memory snapshot for a request carrying a userId", async () => {
    await start(true);
    await postChat({
      messages: [userMessage("hi")],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    expect(store.loadSnapshot).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    await server.close();
  });

  it("works unchanged without a userId and never reads memory", async () => {
    await start(true);
    const body = await postChat({ messages: [userMessage("hi")] });
    expect(body).toContain("data: [DONE]");
    expect(store.loadSnapshot).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a userId over 64 characters with 400", async () => {
    await start(true);
    const { res } = await chatTurn(server.url, {
      messages: [userMessage("hi")],
      userId: "x".repeat(65),
    });
    expect(res.status).toBe(400);
    await server.close();
  });

  // Finding 5: a shape-invalid-but-length-legal userId (an older client
  // predating the UUID convention, or a malformed value) must NOT 400 — the
  // whole point is that the turn still succeeds, just without memory.
  it("silently disables memory for a non-UUID-shaped userId instead of 400ing", async () => {
    await start(true);
    const body = await postChat({
      messages: [userMessage("hi")],
      userId: "user-abc",
    });
    expect(body).toContain("data: [DONE]");
    expect(store.loadSnapshot).not.toHaveBeenCalled();
    // Give the fire-and-forget review a tick to (not) run and confirm the
    // background review never engaged either.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.bumpCounters).not.toHaveBeenCalled();
    await server.close();
  });
});

describe("POST /api/chat — review only bumps the counter on a completed turn", () => {
  it("bumps turns_since_memory when the model's final step has no tool calls", async () => {
    chatMocks.model = mockModel(textStreamChunks("ok"));
    await start(true);
    await postChat({
      messages: [userMessage("hi")],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    await vi.waitFor(() => expect(store.bumpCounters).toHaveBeenCalledTimes(1));
    expect(store.bumpCounters).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", turns: 1 }),
    );
    await server.close();
  });

  it("bumps steps but NOT turns_since_memory on a continuation request (pending client tool call)", async () => {
    // A mid-turn request still calls bumpCounters — steps_since_skill must
    // accumulate every round-trip, not just the final one (see the
    // steps_since_skill fix in ai/selfimprove/review.ts) — but `turns` is 0:
    // a continuation is not a completed user turn, so turns_since_memory
    // must not move for it.
    chatMocks.model = mockModel(toolCallStreamChunks("get_editor_state", {}));
    await start(true);
    await postChat({
      messages: [userMessage("hi")],
      userId: "11111111-1111-4111-8111-111111111111",
    });
    await vi.waitFor(() => expect(store.bumpCounters).toHaveBeenCalledTimes(1));
    expect(store.bumpCounters).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", turns: 0 }),
    );
    await server.close();
  });
});
