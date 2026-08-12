import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { AuditActivityResult, MemoryStore } from "../src/ai/memory/store.js";

function fakeMemoryStore(
  overrides: Partial<MemoryStore> = {},
): MemoryStore & { listAuditActivity: ReturnType<typeof vi.fn> } {
  return {
    loadSnapshot: vi.fn(),
    applyOperations: vi.fn(),
    bumpCounters: vi.fn(),
    writeAudit: vi.fn(),
    listAuditActivity: vi.fn(async () => ({ events: [], latestId: null }) as AuditActivityResult),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MemoryStore & { listAuditActivity: ReturnType<typeof vi.fn> };
}

let app: FastifyInstance | undefined;
let url: string;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function build(
  memoryStore: MemoryStore | null,
  memoryEnabled = true,
): Promise<void> {
  app = await buildApp(makeConfig({ MEMORY_ENABLED: memoryEnabled }), {
    logger: false,
    traceStore: null,
    showcaseStore: null,
    memoryStore,
  });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
}

async function get(query: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/api/memory/activity${query}`);
  return { status: res.status, body: await res.json() };
}

describe("GET /api/memory/activity", () => {
  it("400s without a userId", async () => {
    await build(fakeMemoryStore());
    const { status, body } = await get("");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Invalid query parameters" });
  });

  it("400s on an empty userId", async () => {
    await build(fakeMemoryStore());
    const { status } = await get("?userId=");
    expect(status).toBe(400);
  });

  // Finding 5: unlike the chat route (which silently drops a shape-invalid
  // userId to "no memory"), this route reads back someone's audit trail —
  // a low-entropy id like "test" colliding across two callers IS the leak,
  // so it must be rejected outright, not degraded.
  it("400s on a userId that isn't UUID-shaped, even though it satisfies the length bound", async () => {
    await build(fakeMemoryStore());
    const { status, body } = await get("?userId=test");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Invalid query parameters" });
  });

  it("accepts the 32-char no-dash hex fallback shape (crypto.getRandomValues path)", async () => {
    const store = fakeMemoryStore({
      listAuditActivity: vi.fn(async () => ({ events: [], latestId: 1 })),
    });
    await build(store);
    const { status } = await get("?userId=abcdef0123456789abcdef0123456789");
    expect(status).toBe(200);
  });

  it("baseline mode (no sinceId) returns empty events and the store's latestId", async () => {
    const store = fakeMemoryStore({
      listAuditActivity: vi.fn(async () => ({ events: [], latestId: 42 })),
    });
    await build(store);
    const { status, body } = await get("?userId=11111111-1111-4111-8111-111111111111");
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], latestId: 42 });
    expect(store.listAuditActivity).toHaveBeenCalledWith({ userId: "11111111-1111-4111-8111-111111111111", sinceId: undefined });
  });

  it("returns events with created_at (snake_case) and no payload, when sinceId is given", async () => {
    const store = fakeMemoryStore({
      listAuditActivity: vi.fn(async () => ({
        events: [
          {
            id: 43,
            subsystem: "memory",
            action: "add",
            origin: "background_review",
            createdAt: "2026-08-12T10:00:00.000Z",
          },
        ],
        latestId: 43,
      })),
    });
    await build(store);
    const { status, body } = await get("?userId=11111111-1111-4111-8111-111111111111&sinceId=42");
    expect(status).toBe(200);
    expect(body).toEqual({
      events: [
        {
          id: 43,
          subsystem: "memory",
          action: "add",
          origin: "background_review",
          created_at: "2026-08-12T10:00:00.000Z",
        },
      ],
      latestId: 43,
    });
    expect(store.listAuditActivity).toHaveBeenCalledWith({ userId: "11111111-1111-4111-8111-111111111111", sinceId: 42 });
    expect(JSON.stringify(body)).not.toContain("payload");
  });

  it("400s on a negative or non-integer sinceId", async () => {
    await build(fakeMemoryStore());
    expect((await get("?userId=11111111-1111-4111-8111-111111111111&sinceId=-1")).status).toBe(400);
    expect((await get("?userId=11111111-1111-4111-8111-111111111111&sinceId=abc")).status).toBe(400);
  });

  it("returns 200 with empty payload (never an error) when there is no memory store", async () => {
    await build(null);
    const { status, body } = await get("?userId=11111111-1111-4111-8111-111111111111");
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], latestId: null });
  });

  it("returns 200 with empty payload when MEMORY_ENABLED is off, without querying the store", async () => {
    const store = fakeMemoryStore();
    await build(store, false);
    const { status, body } = await get("?userId=11111111-1111-4111-8111-111111111111");
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], latestId: null });
    expect(store.listAuditActivity).not.toHaveBeenCalled();
  });

  // Finding 2: this route is polled after every chat turn, so a DB hiccup
  // must degrade to the same empty-payload 200 as the disabled/missing-store
  // case, never fall through to Fastify's default error handler (which
  // echoes error.message verbatim in a 500 body).
  it("returns 200 with empty payload, not a 500, when listAuditActivity rejects", async () => {
    const store = fakeMemoryStore({
      listAuditActivity: vi.fn(async () => {
        throw new Error("connection terminated unexpectedly");
      }),
    });
    await build(store);
    const { status, body } = await get("?userId=11111111-1111-4111-8111-111111111111");
    expect(status).toBe(200);
    expect(body).toEqual({ events: [], latestId: null });
    expect(JSON.stringify(body)).not.toContain("connection terminated");
  });
});
