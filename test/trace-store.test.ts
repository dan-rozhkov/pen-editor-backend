import { describe, expect, it, vi } from "vitest";
import {
  buildPgPoolOptions,
  createTraceStore,
  writeRawTraceSafe,
  type RawTraceRow,
  type TraceQueryable,
} from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

// Finding 3: connectionTimeoutMillis must be opt-in per pool, not a blanket
// default baked into createPgPool — only the memory store's pool (the one
// sitting in /api/chat's hot path) should get it. `buildPgPoolOptions` is
// the pure options-builder factored out of `createPgPool` specifically so
// this can be asserted without spinning up a real pg.Pool/DB connection.
describe("buildPgPoolOptions", () => {
  it("omits connectionTimeoutMillis when not explicitly requested — pg's own 'wait forever' default applies", () => {
    const options = buildPgPoolOptions("postgres://example");
    expect(options.connectionTimeoutMillis).toBeUndefined();
    expect(options.max).toBe(3);
    expect(options.connectionString).toBe("postgres://example");
  });

  it("includes connectionTimeoutMillis only when the caller opts in", () => {
    const options = buildPgPoolOptions("postgres://example", { connectionTimeoutMillis: 5000 });
    expect(options.connectionTimeoutMillis).toBe(5000);
  });

  it("still allows overriding max independently of the timeout", () => {
    const options = buildPgPoolOptions("postgres://example", { max: 10 });
    expect(options.max).toBe(10);
    expect(options.connectionTimeoutMillis).toBeUndefined();
  });
});

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
    expect(pool.calls[0].params?.[1]).toBeNull(); // no userId on this fixture row
    expect(JSON.parse(pool.calls[0].params?.[4] as string)).toEqual(row.payload);
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

  it("swallows synchronous throws from writeRawTrace", () => {
    const store = {
      writeRawTrace: vi.fn((): Promise<void> => {
        throw new Error("sync boom");
      }),
      close: async () => {},
    };
    expect(() => writeRawTraceSafe(store, row)).not.toThrow();
    expect(store.writeRawTrace).toHaveBeenCalled();
  });
});
