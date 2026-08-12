import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

// createMemoryStore's own contract is "config has TRACE_DATABASE_URL" (see
// test/memory-store-pglite.test.ts) — it does not know about MEMORY_ENABLED.
// The app must not call it at all when the flag is off, or a disabled
// feature still opens a second Postgres pool at the same database. Mocking
// the factory (rather than asserting on pool internals) is what lets this
// test tell "never constructed" apart from "constructed but unused".
const createMemoryStoreMock = vi.hoisted(() => vi.fn(() => null));
vi.mock("../src/ai/memory/store.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/ai/memory/store.js")>(
      "../src/ai/memory/store.js",
    );
  return { ...actual, createMemoryStore: createMemoryStoreMock };
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  createMemoryStoreMock.mockClear();
});

describe("buildApp — memory store gating", () => {
  it("does not construct a memory store when MEMORY_ENABLED is off, even with TRACE_DATABASE_URL set", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({ MEMORY_ENABLED: false, TRACE_DATABASE_URL: "postgres://unused" }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    expect(createMemoryStoreMock).not.toHaveBeenCalled();
  });

  it("constructs a memory store when MEMORY_ENABLED is on and TRACE_DATABASE_URL is set", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({ MEMORY_ENABLED: true, TRACE_DATABASE_URL: "postgres://unused" }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    expect(createMemoryStoreMock).toHaveBeenCalledTimes(1);
  });

  it("respects an explicitly injected memoryStore option regardless of the flag", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(makeConfig({ MEMORY_ENABLED: false }), {
      logger: false,
      traceStore: null,
      showcaseStore: null,
      memoryStore: null,
    });
    expect(createMemoryStoreMock).not.toHaveBeenCalled();
  });

  it("GET /api/memory/activity still returns 200 with an empty payload when the flag is off", async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp(
      makeConfig({ MEMORY_ENABLED: false, TRACE_DATABASE_URL: "postgres://unused" }),
      { logger: false, traceStore: null, showcaseStore: null },
    );
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(
      `${url}/api/memory/activity?userId=11111111-1111-4111-8111-111111111111`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], latestId: null });
  });
});
