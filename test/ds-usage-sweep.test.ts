import { describe, expect, it, vi } from "vitest";
import { startDsUsageSweep } from "../src/ds/usageSweep.js";
import { makeConfig } from "./helpers.js";

describe("startDsUsageSweep", () => {
  const pool = () => ({ query: vi.fn(async () => ({ rows: [{ n: 0 }] })), end: vi.fn(async () => {}) });
  const deps = (p: ReturnType<typeof pool>) => ({
    createPool: () => p as never,
    setInterval: vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
  });

  it("does nothing without a database URL", async () => {
    const p = pool();
    await startDsUsageSweep(makeConfig(), deps(p))();
    expect(p.query).not.toHaveBeenCalled();
  });

  it("sweeps at startup, schedules daily, and survives a failing sweep", async () => {
    const p = pool();
    const d = deps(p);
    const stop = startDsUsageSweep(makeConfig({ TRACE_DATABASE_URL: "postgres://x" }), d);
    await vi.waitFor(() => expect(p.query).toHaveBeenCalledTimes(1));
    expect(d.setInterval).toHaveBeenCalledTimes(1);
    await stop();
    expect(p.end).toHaveBeenCalled();

    const failing = { query: vi.fn(async () => { throw new Error("db down"); }), end: vi.fn(async () => {}) };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop2 = startDsUsageSweep(makeConfig({ TRACE_DATABASE_URL: "postgres://x" }), deps(failing as never));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await stop2();
    spy.mockRestore();
  });
});
