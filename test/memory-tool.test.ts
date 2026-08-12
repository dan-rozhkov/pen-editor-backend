import { describe, expect, it, vi } from "vitest";
import { createMemoryToolContext, getMemoryTools } from "../src/ai/memory/tool.js";
import { MEMORY_CIRCUIT_BREAKER, MEMORY_TOOL_DESCRIPTION, MEMORY_WRITE_SAVED } from "../src/ai/memory/prompts.js";
import type { MemoryApplyOutcome } from "../src/ai/memory/apply.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

function fakeStore(outcomes: MemoryApplyOutcome[]): {
  store: MemoryStore;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const store = {
    loadSnapshot: vi.fn(async () => ({ memory: [], user: [] })),
    applyOperations: vi.fn(async (input: unknown) => {
      calls.push(input);
      return outcomes.shift() ?? { ok: true, entries: [], usage: { current: 0, limit: 1375 } };
    }),
    bumpCounters: vi.fn(),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
  return { store, calls };
}

interface MemoryTool {
  description: string;
  execute: (input: unknown) => Promise<Record<string, unknown>>;
}

function toolOf(store: MemoryStore) {
  const ctx = createMemoryToolContext(store, "u1", "foreground");
  return { ctx, memory: getMemoryTools(ctx).memory as unknown as MemoryTool };
}

describe("memory tool", () => {
  it("carries the Hermes tool description", () => {
    const { memory } = toolOf(fakeStore([]).store);
    expect(memory.description).toBe(MEMORY_TOOL_DESCRIPTION);
  });

  it("returns the terminal success line without echoing entries", async () => {
    const { store } = fakeStore([
      { ok: true, entries: ["a"], usage: { current: 1, limit: 1375 } },
    ]);
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "User prefers concise responses" }],
    });
    expect(result).toEqual({
      ok: true,
      message: MEMORY_WRITE_SAVED,
      usage: { current: 1, limit: 1375 },
    });
    expect(JSON.stringify(result)).not.toContain("\"a\"");
  });

  it("passes the target, operations and origin to the store", async () => {
    const { store, calls } = fakeStore([]);
    const { memory } = toolOf(store);
    await memory.execute({
      target: "memory",
      operations: [{ action: "remove", old_text: "old" }],
    });
    expect(calls[0]).toEqual({
      userId: "u1",
      target: "memory",
      operations: [{ action: "remove", old_text: "old" }],
      origin: "foreground",
    });
  });

  it("returns current_entries and the consolidate instruction when over capacity", async () => {
    const { store } = fakeStore([
      {
        ok: false,
        kind: "over_capacity",
        message: "Memory at 1370/1375 chars. Adding this entry (50 chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), then retry this add — all in this turn.",
        usage: { current: 1370, limit: 1375 },
        currentEntries: ["one", "two"],
      },
    ]);
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Consolidate now");
    expect(result.current_entries).toEqual(["one", "two"]);
    expect(result.usage).toEqual({ current: 1370, limit: 1375 });
  });

  it("trips the circuit breaker after 3 failed calls in one request", async () => {
    const failure: MemoryApplyOutcome = {
      ok: false,
      kind: "no_match",
      message: "No memory entry contains \"zzz\". Nothing was changed.",
      usage: { current: 0, limit: 1375 },
      currentEntries: [],
    };
    const { store } = fakeStore([failure, failure, failure]);
    const { memory } = toolOf(store);
    const call = () =>
      memory.execute({ target: "user", operations: [{ action: "remove", old_text: "zzz" }] });

    await call();
    await call();
    await call();
    const fourth = await call();

    expect(fourth).toEqual({ ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER });
  });

  it("turns a store throw into a model-readable error instead of failing the turn", async () => {
    const store = {
      applyOperations: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    } as unknown as MemoryStore;
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Memory is temporarily unavailable");
  });
});
