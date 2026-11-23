import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { buildLocalApp } from "../src/local/app.js";
import { loadLocalConfig } from "../src/local/config.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import { MEMORY_LIMITS } from "../src/ai/memory/types.js";

function fakeStore(overrides: Partial<MemoryStore> = {}) {
  return {
    loadSnapshot: vi.fn(async () => ({ memory: ["m1"], user: ["u1"] })),
    getMemoryEnabled: vi.fn(async () => true),
    setMemoryEnabled: vi.fn(async () => {}),
    removeEntry: vi.fn(async () => true),
    clearUser: vi.fn(async () => ({ memory: 2, user: 1 })),
    listAuditActivity: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MemoryStore & Record<string, ReturnType<typeof vi.fn>>;
}

let app: FastifyInstance | undefined;
let url: string;
const ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(store: MemoryStore | null, memoryEnabled = true): Promise<void> {
  app = await buildApp(makeConfig({ MEMORY_ENABLED: memoryEnabled }), {
    logger: false,
    traceStore: null,
    showcaseStore: null,
    memoryStore: store,
  });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/memory", () => {
  it("400s without a userId", async () => {
    await build(fakeStore());
    expect((await call("GET", "/api/memory")).status).toBe(400);
  });

  it("returns the snapshot, switch and limits", async () => {
    const store = fakeStore({ getMemoryEnabled: vi.fn(async () => false) });
    await build(store);
    const res = await call("GET", `/api/memory?userId=${ID}`);
    expect(res).toEqual({
      status: 200,
      body: { available: true, enabled: false, memory: ["m1"], user: ["u1"], limits: MEMORY_LIMITS },
    });
  });

  it.each([
    ["flag off", false],
    ["no store", true],
  ])("reports unavailable without a DB call (%s)", async (_n, noStore) => {
    const store = fakeStore();
    await build(noStore ? null : store, noStore);
    const res = await call("GET", `/api/memory?userId=${ID}`);
    expect(res).toEqual({
      status: 200,
      body: { available: false, enabled: true, memory: [], user: [], limits: MEMORY_LIMITS },
    });
    expect(store.loadSnapshot).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/memory/entry", () => {
  it("removes an exact entry as a user action", async () => {
    const store = fakeStore();
    await build(store);
    const res = await call("DELETE", `/api/memory/entry?userId=${ID}`, { target: "user", text: "u1" });
    expect(res).toEqual({ status: 200, body: { removed: true } });
    expect(store.removeEntry).toHaveBeenCalledWith(ID, "user", "u1", "user");
  });

  it("404s when nothing matches", async () => {
    await build(fakeStore({ removeEntry: vi.fn(async () => false) }));
    const res = await call("DELETE", `/api/memory/entry?userId=${ID}`, { target: "memory", text: "nope" });
    expect(res.status).toBe(404);
  });

  it("400s on a bad body and 503s when unavailable", async () => {
    await build(fakeStore());
    expect((await call("DELETE", `/api/memory/entry?userId=${ID}`, { target: "x", text: "a" })).status).toBe(400);
    await app!.close();
    await build(null);
    expect((await call("DELETE", `/api/memory/entry?userId=${ID}`, { target: "user", text: "a" })).status).toBe(503);
  });
});

describe("DELETE /api/memory", () => {
  it("clears everything and reports counts", async () => {
    const store = fakeStore();
    await build(store);
    const res = await call("DELETE", `/api/memory?userId=${ID}`);
    expect(res).toEqual({ status: 200, body: { cleared: { memory: 2, user: 1 } } });
    expect(store.clearUser).toHaveBeenCalledWith(ID, "user");
  });

  it("503s when unavailable", async () => {
    await build(null);
    expect((await call("DELETE", `/api/memory?userId=${ID}`)).status).toBe(503);
  });
});

describe("PUT /api/memory/settings", () => {
  it("stores the switch", async () => {
    const store = fakeStore();
    await build(store);
    const res = await call("PUT", `/api/memory/settings?userId=${ID}`, { enabled: false });
    expect(res).toEqual({ status: 200, body: { enabled: false } });
    expect(store.setMemoryEnabled).toHaveBeenCalledWith(ID, false);
  });

  it("400s on a bad body and 503s when unavailable", async () => {
    await build(fakeStore());
    expect((await call("PUT", `/api/memory/settings?userId=${ID}`, { enabled: "yes" })).status).toBe(400);
    await app!.close();
    await build(null);
    expect((await call("PUT", `/api/memory/settings?userId=${ID}`, { enabled: true })).status).toBe(503);
  });
});

describe("POST /api/memory/operations", () => {
  const ops = { target: "user", operations: [{ action: "add", content: "likes tea" }] };
  const path = `/api/memory/operations?userId=${ID}`;
  const okOutcome = { ok: true, entries: ["likes tea"], usage: { current: 9, limit: 1375 } };

  // The route only exists in the local app (it skips the hosted write filter).
  it("is 404 in the hosted app", async () => {
    await build(fakeStore());
    expect((await call("POST", path, ops)).status).toBe(404);
  });

  async function buildLocal(store: MemoryStore | null): Promise<void> {
    app = await buildLocalApp(loadLocalConfig({}), { logger: false, insecureDev: true, memoryStore: store });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  }

  it("applies the batch as origin user, atomically checked for the switch, and answers from the outcome", async () => {
    const store = fakeStore({ applyOperations: vi.fn(async () => okOutcome) });
    await buildLocal(store);
    const res = await call("POST", path, ops);
    expect(res).toEqual({
      status: 200,
      body: { ok: true, memory: ["m1"], user: ["likes tea"], limits: MEMORY_LIMITS },
    });
    expect(store.applyOperations).toHaveBeenCalledWith({
      userId: ID,
      target: "user",
      operations: ops.operations,
      origin: "user",
      requireEnabled: true,
      skipNoopAudit: true,
    });
  });

  it("still answers 200 when the snapshot read after the commit fails", async () => {
    const store = fakeStore({
      applyOperations: vi.fn(async () => okOutcome),
      loadSnapshot: vi.fn(async () => { throw new Error("boom"); }),
    });
    await buildLocal(store);
    expect(await call("POST", path, ops)).toEqual({
      status: 200,
      body: { ok: true, memory: [], user: ["likes tea"], limits: MEMORY_LIMITS },
    });
  });

  it("400s with memory_rejected and the store message", async () => {
    const store = fakeStore({
      applyOperations: vi.fn(async () => ({ ok: false, kind: "ambiguous", message: "too many matches", usage: { current: 0, limit: 1 }, currentEntries: [] })),
    });
    await buildLocal(store);
    expect(await call("POST", path, ops)).toEqual({
      status: 400,
      body: { error: "too many matches", code: "memory_rejected" },
    });
  });

  it("409s when the store reports memory turned off", async () => {
    const store = fakeStore({
      applyOperations: vi.fn(async () => ({ ok: false, kind: "disabled", message: "x", usage: { current: 0, limit: 1 }, currentEntries: [] })),
    });
    await buildLocal(store);
    expect(await call("POST", path, ops)).toEqual({
      status: 409,
      body: { error: "Memory is turned off in Settings > Memory.", code: "memory_disabled" },
    });
  });

  it("400s on a bad body, a foreign body userId or a missing userId, 503s when unavailable", async () => {
    const store = fakeStore({ applyOperations: vi.fn() });
    await buildLocal(store);
    expect(await call("POST", path, { target: "x", operations: [] })).toEqual({ status: 400, body: { error: "Invalid body" } });
    expect(await call("POST", path, { target: "user", operations: [] })).toEqual({ status: 400, body: { error: "Invalid body" } });
    expect((await call("POST", "/api/memory/operations", ops)).status).toBe(400);
    expect((await call("POST", path, { ...ops, userId: "33333333-3333-4333-8333-333333333333" })).status).toBe(400);
    expect(store.applyOperations).not.toHaveBeenCalled();
    await app!.close();
    await buildLocal(null);
    expect((await call("POST", path, ops)).status).toBe(503);
  });
});
