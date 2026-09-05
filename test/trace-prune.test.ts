import { describe, expect, it, vi } from "vitest";
import {
  PRUNE_INTERVAL_MS,
  pruneRawTraces,
  startTracePruneSchedule,
  type TracePruneScheduleDeps,
} from "../src/tracing/pruneTraces.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

function fakePool(overrides: Partial<TraceQueryable> = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rowCount: 3 };
    }),
    end: vi.fn(async () => {}),
    ...overrides,
  };
  return pool as typeof pool & TraceQueryable;
}

describe("pruneRawTraces", () => {
  it("deletes rows older than the TTL and reports the count", async () => {
    const pool = fakePool();
    await expect(pruneRawTraces(pool, 14)).resolves.toBe(3);
    expect(pool.calls[0].sql).toContain("DELETE FROM raw_traces");
    expect(pool.calls[0].params).toEqual([14]);
  });

  it("reports 0 when the driver gives no rowCount", async () => {
    const pool = fakePool({ query: vi.fn(async () => ({})) });
    await expect(pruneRawTraces(pool, 7)).resolves.toBe(0);
  });
});

describe("startTracePruneSchedule", () => {
  function deps(pool: TraceQueryable) {
    const timers: Array<() => void> = [];
    const fake: TracePruneScheduleDeps = {
      createPool: () => pool,
      setInterval: vi.fn((fn: () => void, ms: number) => {
        timers.push(fn);
        expect(ms).toBe(PRUNE_INTERVAL_MS);
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
    };
    return { fake, timers };
  }

  it("does nothing without a database URL", async () => {
    const pool = fakePool();
    const { fake } = deps(pool);
    await startTracePruneSchedule(makeConfig(), fake)();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("prunes once immediately and again on every tick", async () => {
    const pool = fakePool();
    const { fake, timers } = deps(pool);
    const stop = startTracePruneSchedule(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x", TRACE_RAW_TTL_DAYS: 9 }),
      fake,
    );
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(1));
    expect(pool.calls[0].params).toEqual([9]);
    timers[0]();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(2));
    await stop();
    expect(pool.end).toHaveBeenCalled();
  });

  // A failing prune must never take the server down, and must not stop the
  // schedule — the next tick has to try again.
  it("swallows prune failures and keeps the schedule alive", async () => {
    const pool = fakePool({
      query: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const { fake, timers } = deps(pool);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startTracePruneSchedule(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      fake,
    );
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(timers).toHaveLength(1);
    timers[0]();
    await vi.waitFor(() => expect(pool.query).toHaveBeenCalledTimes(2));
    await stop();
    errorSpy.mockRestore();
  });
});
