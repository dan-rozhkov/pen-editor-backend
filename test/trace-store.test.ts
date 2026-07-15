import { describe, expect, it, vi } from "vitest";
import {
  createTraceStore,
  writeRawTraceSafe,
  type RawTraceRow,
  type TraceQueryable,
} from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

function fakePool(): TraceQueryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    }),
    end: vi.fn(async () => {}),
  };
}

const row: RawTraceRow = {
  sessionId: "tab-1-1",
  model: "google/gemini-2.5-flash",
  agentMode: "edits",
  payload: { messages: [{ role: "user" }], steps: [], systemPromptHash: "abc" },
  streamError: null,
  inputTokens: 10,
  outputTokens: 5,
};

describe("createTraceStore", () => {
  it("returns null when TRACE_DATABASE_URL is not set", () => {
    expect(createTraceStore(makeConfig())).toBeNull();
  });

  it("inserts a raw_traces row with jsonb payload", async () => {
    const pool = fakePool();
    const store = createTraceStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.writeRawTrace(row);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toContain("INSERT INTO raw_traces");
    expect(pool.calls[0].params?.[0]).toBe("tab-1-1");
    expect(JSON.parse(pool.calls[0].params?.[3] as string)).toEqual(row.payload);
  });
});

describe("writeRawTraceSafe", () => {
  it("swallows write errors (fire-and-forget)", async () => {
    const store = {
      writeRawTrace: vi.fn(async () => {
        throw new Error("db down");
      }),
      close: async () => {},
    };
    expect(() => writeRawTraceSafe(store, row)).not.toThrow();
    await vi.waitFor(() => expect(store.writeRawTrace).toHaveBeenCalled());
  });
});
