import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { MEMORY_GUIDANCE } from "../src/ai/memory/prompts.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import type { MemorySnapshot } from "../src/ai/memory/types.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

function storeWith(snapshot: MemorySnapshot): MemoryStore {
  return {
    loadSnapshot: vi.fn(async () => snapshot),
    applyOperations: vi.fn(),
    bumpCounters: vi.fn(),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("prepareChatTurn — memory injection", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("injects the snapshot and the memory tool when enabled with a userId", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("make the header bigger")],
      userId: "u1",
      memoryStore: storeWith({ user: ["User prefers concise responses"], memory: [] }),
      canvasContext: "{}",
    });

    expect(turn.memoryInjected).toBe(true);
    expect(turn.tools.memory).toBeDefined();
    expect(turn.system).toContain(MEMORY_GUIDANCE);
    expect(turn.system).toContain("USER PROFILE (who the user is)");
    expect(turn.system).toContain("User prefers concise responses");
    // Order: guidance → skills catalog → snapshot → canvas context.
    expect(turn.system.indexOf(MEMORY_GUIDANCE)).toBeLessThan(
      turn.system.indexOf("## Available Skills"),
    );
    expect(turn.system.indexOf("## Available Skills")).toBeLessThan(
      turn.system.indexOf("USER PROFILE (who the user is)"),
    );
    expect(turn.system.indexOf("USER PROFILE (who the user is)")).toBeLessThan(
      turn.system.indexOf("## Current Canvas Context"),
    );
  });

  it("still injects the tool and guidance when the user has no entries yet", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: storeWith({ user: [], memory: [] }),
    });
    expect(turn.memoryInjected).toBe(true);
    expect(turn.tools.memory).toBeDefined();
    expect(turn.system).toContain(MEMORY_GUIDANCE);
    expect(turn.system).not.toContain("USER PROFILE (who the user is)");
  });

  it("stays off without a userId (the showcase runner path)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = storeWith({ user: ["x"], memory: [] });
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      memoryStore: store,
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
    expect(turn.system).not.toContain(MEMORY_GUIDANCE);
    expect(store.loadSnapshot).not.toHaveBeenCalled();
  });

  it("stays off when MEMORY_ENABLED is false", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig(),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: storeWith({ user: ["x"], memory: [] }),
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
  });

  it("degrades to a normal turn when the snapshot read hangs forever (e.g. Postgres unreachable)", async () => {
    vi.useFakeTimers();
    try {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      // A pool with no connectionTimeoutMillis effect (or a query hung after
      // connecting) never rejects — the classic "unreachable but not
      // refusing" failure mode. A plain try/catch around this never fires;
      // only the explicit race in chatTurn.ts can degrade it.
      const store = {
        loadSnapshot: vi.fn(() => new Promise(() => {})),
      } as unknown as MemoryStore;

      const pending = prepareChatTurn({
        config: makeConfig({ MEMORY_ENABLED: true }),
        messages: [userMessage("hi")],
        userId: "u1",
        memoryStore: store,
      });

      await vi.advanceTimersByTimeAsync(2_001);
      const turn = await pending;

      expect(turn.memoryInjected).toBe(false);
      expect(turn.tools.memory).toBeUndefined();
      expect(turn.system.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades to a normal turn when the snapshot read throws", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = {
      loadSnapshot: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as MemoryStore;
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: store,
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
    expect(turn.system.length).toBeGreaterThan(0);
  });
});
