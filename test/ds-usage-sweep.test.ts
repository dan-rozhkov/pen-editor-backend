import { describe, expect, it, vi } from "vitest";
import { dsUsagePruneJob } from "../src/ds/usageSweep.js";
import { startTracePruneSchedule } from "../src/tracing/pruneTraces.js";
import { makeConfig } from "./helpers.js";

describe("ds usage prune job on the shared prune schedule", () => {
  const deps = (query: ReturnType<typeof vi.fn>) => {
    const pool = { query, end: vi.fn(async () => {}) };
    return {
      pool,
      deps: {
        createPool: vi.fn(() => pool as never),
        setInterval: vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
      },
    };
  };
  const cfg = makeConfig({ TRACE_DATABASE_URL: "postgres://x" });

  it("runs on the same single pool and schedule as the trace prune", async () => {
    const query = vi.fn(async () => ({ rows: [{ n: 0 }] }));
    const d = deps(query);
    const stop = startTracePruneSchedule(cfg, d.deps, [dsUsagePruneJob]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(d.deps.createPool).toHaveBeenCalledTimes(1);
    expect(d.deps.setInterval).toHaveBeenCalledTimes(1);
    await stop();
    expect(d.pool.end).toHaveBeenCalled();
  });

  it("a failing job does not stop the other one", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("raw_traces")) throw new Error("db down");
      return { rows: [{ n: 0 }] };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startTracePruneSchedule(cfg, deps(query).deps, [dsUsagePruneJob]);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("ds_usage"))).toBe(true);
    await stop();
    spy.mockRestore();
  });
});
