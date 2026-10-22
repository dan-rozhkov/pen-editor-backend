import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { createMemoryToolContext, getMemoryTools, memoryFilterContext } from "../src/ai/memory/tool.js";
import { MEMORY_FILTER_ALL_SKIPPED } from "../src/ai/memory/prompts.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import type { SystemOneAnswers, SystemOneClient } from "../src/services/systemone.js";

interface ToolResult {
  ok: boolean;
  saved?: boolean;
  message?: string;
  skipped?: { content: string; reason: string }[];
}

function setup(opts: {
  mode: "off" | "shadow" | "enforce";
  answers?: Record<string, number>;
  client?: SystemOneClient | null;
  snapshot?: () => Promise<{ memory: string[]; user: string[] }>;
}) {
  const applyOperations = vi.fn(async () => ({ ok: true as const, entries: [], usage: { current: 1, limit: 1375 } }));
  const loadSnapshot = vi.fn(opts.snapshot ?? (async () => ({ memory: [], user: ["User is a designer"] })));
  const store = { loadSnapshot, applyOperations } as unknown as MemoryStore;
  const evaluate = vi.fn(async () => ({
    model: "m",
    answers: Object.fromEntries(
      Object.entries(opts.answers ?? {}).map(([k, v]) => [k, { type: "noul", noul: v }]),
    ) as SystemOneAnswers,
    usage: { input_tokens: 0, output_tokens: 0 },
  }));
  const client = opts.client !== undefined ? opts.client : ({ evaluate } as unknown as SystemOneClient);
  const config = makeConfig({ MEMORY_FILTER_MODE: opts.mode });
  const ctx = createMemoryToolContext(store, "u1", "foreground", undefined, memoryFilterContext(config, client));
  const memory = getMemoryTools(ctx).memory as unknown as { execute: (i: unknown, o?: { abortSignal?: AbortSignal }) => Promise<ToolResult> };
  return { memory, ctx, store, applyOperations, loadSnapshot, evaluate };
}

const ops = [
  { action: "add", content: "keep me" },
  { action: "add", content: "one-off task detail" },
  { action: "add", content: "dup of designer" },
];

afterEach(() => vi.restoreAllMocks());

describe("memory tool + write filter", () => {
  it("off: no evaluate, no snapshot read", async () => {
    const t = setup({ mode: "off" });
    expect(t.ctx.filter).toBeUndefined();
    const r = await t.memory.execute({ target: "user", operations: ops });
    expect(r.ok).toBe(true);
    expect(t.evaluate).not.toHaveBeenCalled();
    expect(t.loadSnapshot).not.toHaveBeenCalled();
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(ops);
  });

  it("enforce drops not-durable and duplicate adds, keeps the rest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({
      mode: "enforce",
      answers: { durable_0: 0.9, duplicate_0: 0.1, durable_1: 0.05, duplicate_1: 0.1, durable_2: 0.9, duplicate_2: 0.95 },
    });
    const r = await t.memory.execute({ target: "user", operations: ops });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual([ops[0]]);
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual([
      { content: "one-off task detail", reason: "not_durable" },
      { content: "dup of designer", reason: "duplicate" },
    ]);
    expect(r.message).toContain("Do not retry");
    expect(t.ctx.failures.count).toBe(0);
  });

  it("enforce: all dropped -> store not called, saved:false", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "enforce", answers: { durable_0: 0.01 } });
    const r = await t.memory.execute({ target: "user", operations: [ops[1]] });
    expect(t.applyOperations).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, saved: false, message: MEMORY_FILTER_ALL_SKIPPED });
    expect(r.skipped).toHaveLength(1);
    // Everything dropped counts toward the circuit breaker (see below).
    expect(t.ctx.failures.count).toBe(1);
  });

  it("enforce: an add referenced by a later old_text is kept", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "enforce", answers: { durable_0: 0.01 } });
    const batch = [
      { action: "add", content: "temporary draft entry" },
      { action: "replace", old_text: "draft entry", content: "final" },
    ];
    const r = await t.memory.execute({ target: "user", operations: batch });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(batch);
    expect(r.skipped).toBeUndefined();
  });

  it("enforce: snapshot throw fails open", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup({ mode: "enforce", snapshot: async () => { throw new Error("db"); } });
    const r = await t.memory.execute({ target: "user", operations: ops });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(ops);
    expect(t.evaluate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true });
    expect(r.skipped).toBeUndefined();
  });

  it("shadow: writes everything, asks, logs without contents", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "shadow", answers: { durable_0: 0.01 } });
    const r = await t.memory.execute({ target: "user", operations: [ops[1]] });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual([ops[1]]);
    expect(r.skipped).toBeUndefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(t.evaluate).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line.startsWith("[memoryFilter] ")).toBe(true);
    const entry = JSON.parse(line.slice("[memoryFilter] ".length));
    expect(entry).toMatchObject({ mode: "shadow", origin: "foreground", target: "user", adds: 1, asked: 1, wouldDrop: 1, dropped: 0, outcome: "asked" });
    expect(line).not.toContain("one-off task detail");
  });

  it("no client: writes as today and logs no-client", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "enforce", client: null });
    await t.memory.execute({ target: "user", operations: ops });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(ops);
    expect(String(log.mock.calls[0][0])).toContain('"outcome":"no-client"');
  });

  it("enforce: old_text reference is matched after trimming", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "enforce", answers: { durable_0: 0.01 } });
    const batch = [
      { action: "add", content: "temporary draft entry" },
      { action: "replace", old_text: "  draft entry \n", content: "final" },
    ];
    const r = await t.memory.execute({ target: "user", operations: batch });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(batch);
    expect(r.skipped).toBeUndefined();
  });

  it("snapshot read that hangs times out, fails open and logs failed", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const t = setup({ mode: "enforce", snapshot: () => new Promise(() => {}) });
      const p = t.memory.execute({ target: "user", operations: ops });
      await vi.advanceTimersByTimeAsync(2_001);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(t.applyOperations.mock.calls[0][0].operations).toEqual(ops);
      expect(t.evaluate).not.toHaveBeenCalled();
      expect(String(log.mock.calls[0][0])).toContain('"outcome":"failed"');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["shadow", "enforce"] as const)("%s: snapshot failure logs outcome failed and writes unfiltered", async (mode) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode, snapshot: async () => { throw new Error("db"); } });
    await t.memory.execute({ target: "user", operations: ops });
    expect(t.applyOperations.mock.calls[0][0].operations).toEqual(ops);
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(log.mock.calls[0][0]).slice("[memoryFilter] ".length));
    expect(entry).toMatchObject({ mode, outcome: "failed", asked: 0, dropped: 0 });
  });

  it("shadow: snapshot is read before the write; only the vendor call is detached", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: (v: { memory: string[]; user: string[] }) => void;
    const t = setup({ mode: "shadow", snapshot: () => new Promise((res) => { release = res; }) });
    t.evaluate.mockImplementation(() => new Promise(() => {})); // vendor never answers
    const p = t.memory.execute({ target: "user", operations: [ops[0]] });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.applyOperations).not.toHaveBeenCalled();
    release({ memory: [], user: ["x"] });
    const r = await p; // resolves although evaluate hangs
    expect(r.ok).toBe(true);
    expect(t.applyOperations).toHaveBeenCalledTimes(1);
    expect(t.evaluate).toHaveBeenCalledTimes(1);
  });

  it("shadow wouldDrop applies the referenced-by-later exemption like enforce", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "shadow", answers: { durable_0: 0.01 } });
    await t.memory.execute({
      target: "user",
      operations: [
        { action: "add", content: "temporary draft entry" },
        { action: "replace", old_text: "draft entry", content: "final" },
      ],
    });
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const entry = JSON.parse(String(log.mock.calls[0][0]).slice("[memoryFilter] ".length));
    expect(entry).toMatchObject({ wouldDrop: 0, dropped: 0 });
  });

  it("enforce: repeated all-dropped calls trip the circuit breaker; partial drops do not count", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const t = setup({ mode: "enforce", answers: { durable_0: 0.01 } });
    for (let i = 0; i < 3; i++) {
      const r = await t.memory.execute({ target: "user", operations: [ops[1]] });
      expect(r).toMatchObject({ ok: true, saved: false });
    }
    expect(t.ctx.failures.count).toBe(3);
    const stopped = await t.memory.execute({ target: "user", operations: [ops[1]] }) as unknown as { ok: boolean; done?: boolean };
    expect(stopped).toMatchObject({ ok: false, done: true });
    expect(t.evaluate).toHaveBeenCalledTimes(3);

    const p = setup({ mode: "enforce", answers: { durable_1: 0.01 } });
    await p.memory.execute({ target: "user", operations: [ops[0], ops[1]] });
    expect(p.ctx.failures.count).toBe(0);
  });

  it("abortSignal reaches the vendor call in enforce but not in shadow", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ac = new AbortController();
    ac.abort();
    const e = setup({ mode: "enforce" });
    await e.memory.execute({ target: "user", operations: [ops[0]] }, { abortSignal: ac.signal });
    expect((e.evaluate.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal.aborted).toBe(true);

    const s = setup({ mode: "shadow" });
    await s.memory.execute({ target: "user", operations: [ops[0]] }, { abortSignal: ac.signal });
    await vi.waitFor(() => expect(s.evaluate).toHaveBeenCalled());
    expect((s.evaluate.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal.aborted).toBe(false);
  });
});
