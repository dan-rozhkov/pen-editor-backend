import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sharedCanvasRoutes } from "../src/routes/sharedCanvas.js";
import { makeConfig } from "./helpers.js";
import type { SharedCanvas, SharedCanvasStore } from "../src/sharing/sharedCanvasStore.js";

const VALID_USER_ID = "8f14e45f-ceea-4b23-9e4a-1f7e3a2b9c0d";
const VALID_DOCUMENT = JSON.stringify({ pages: [{ id: "p1", children: [] }] });

function fakeStore(): SharedCanvasStore & { __rows: Map<string, SharedCanvas & { editToken: string }> } {
  const rows = new Map<string, SharedCanvas & { editToken: string }>();
  return {
    __rows: rows,
    async insert({ id, ownerId, editToken, title, document }) {
      rows.set(id, {
        id,
        ownerId,
        editToken,
        title,
        document,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    },
    async get(id) {
      const row = rows.get(id);
      if (!row) return null;
      const { editToken: _editToken, ...pub } = row;
      return pub;
    },
    async countByOwner(ownerId) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.ownerId === ownerId) count += 1;
      }
      return count;
    },
    async update({ id, editToken, title, document }) {
      const row = rows.get(id);
      if (!row || row.editToken !== editToken) return null;
      row.title = title;
      row.document = document;
      row.updatedAt = new Date();
      return row.updatedAt;
    },
    async remove(id, editToken) {
      const row = rows.get(id);
      if (!row || row.editToken !== editToken) return false;
      rows.delete(id);
      return true;
    },
    async close() {},
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.restoreAllMocks();
});

async function build(store: SharedCanvasStore | null): Promise<FastifyInstance> {
  app = Fastify();
  await sharedCanvasRoutes(app, makeConfig(), store);
  await app.ready();
  return app;
}

function shareBody(overrides: Record<string, unknown> = {}) {
  return {
    userId: VALID_USER_ID,
    title: "My canvas",
    document: VALID_DOCUMENT,
    ...overrides,
  };
}

describe("POST /api/canvas/share", () => {
  it("creates a share and returns an id + editToken", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(typeof body.editToken).toBe("string");
    expect(body.editToken.length).toBeGreaterThan(0);
    expect(body.createdAt).toBeDefined();
  });

  it("updates an existing share when shareId + editToken match", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const updatedDoc = JSON.stringify({ pages: [{ id: "p2", children: [] }] });
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({
        title: "Renamed",
        document: updatedDoc,
        shareId: created.id,
        editToken: created.editToken,
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(created.id);
    expect(body.editToken).toBe(created.editToken);

    const stored = store.__rows.get(created.id)!;
    expect(stored.title).toBe("Renamed");
    expect(stored.document).toBe(updatedDoc);
    // Regression: the response's updatedAt must be the value the store
    // actually wrote (from its own RETURNING), not a `new Date()` invented
    // in the route — otherwise it can drift from what Postgres recorded.
    expect(body.updatedAt).toBe(stored.updatedAt.toISOString());
  });

  it("404s an update with the wrong edit token", async () => {
    const app = await build(fakeStore());
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ shareId: created.id, editToken: "wrong-token" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s an update against a shareId that never existed", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ shareId: "nonexistent", editToken: "whatever" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when only shareId is present (no silent create)", async () => {
    const store = fakeStore();
    const app = await build(store);
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ shareId: "some-id" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/shareId and editToken must be provided together/);
    // Must not have created an orphan row.
    expect(store.__rows.size).toBe(0);
  });

  it("400s when only editToken is present (no silent create)", async () => {
    const store = fakeStore();
    const app = await build(store);
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ editToken: "some-token" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/shareId and editToken must be provided together/);
    expect(store.__rows.size).toBe(0);
  });

  it("400s on a missing/invalid userId", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ userId: "not-a-uuid" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when the document is not valid JSON", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ document: "{not json" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pages array/);
  });

  it("400s when the document JSON has no pages array", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ document: JSON.stringify({ notPages: [] }) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/pages array/);
  });

  it("400s when the document exceeds the max size, with a readable message", async () => {
    const app = await build(fakeStore());
    const huge = JSON.stringify({ pages: [], padding: "x".repeat(8_000_010) });
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ document: huge }),
    });
    expect(res.statusCode).toBe(400);
    // Must match the frontend's size-error mapper (pen-editor/src/lib/shareCanvas.ts,
    // which tests /large|size|too big/i) instead of zod's default
    // "String must contain at most 8000000 character(s)".
    expect(res.json().error).toMatch(/too large/i);
  });

  it("503s when the store is not configured", async () => {
    const app = await build(null);
    const res = await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() });
    expect(res.statusCode).toBe(503);
  });

  it("500s with a generic message when insert fails, not the raw driver error", async () => {
    const store = fakeStore();
    store.insert = async () => {
      throw new Error("connection terminated unexpectedly: pg internals leaked");
    };
    const app = await build(store);
    const res = await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/pg internals/);
  });

  it("500s with a generic message when update fails, not the raw driver error", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();
    store.update = async () => {
      throw new Error("connection terminated unexpectedly: pg internals leaked");
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ shareId: created.id, editToken: created.editToken }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/pg internals/);
  });

  it("400s when the owner is already at the per-owner share cap", async () => {
    const store = fakeStore();
    store.countByOwner = async () => 50;
    const app = await build(store);
    const res = await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/stop sharing an old canvas/i);
    expect(store.__rows.size).toBe(0);
  });

  it("does not check the cap when updating an existing share", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    let countByOwnerCalls = 0;
    const originalCountByOwner = store.countByOwner.bind(store);
    store.countByOwner = async (ownerId) => {
      countByOwnerCalls += 1;
      return originalCountByOwner(ownerId);
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/canvas/share",
      payload: shareBody({ shareId: created.id, editToken: created.editToken, title: "Renamed" }),
    });
    expect(res.statusCode).toBe(200);
    expect(countByOwnerCalls).toBe(0);
  });
});

describe("GET /api/canvas/:id", () => {
  it("returns the canvas and a no-store cache header when found", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const res = await app.inject({ method: "GET", url: `/api/canvas/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.id).toBe(created.id);
    expect(body.title).toBe("My canvas");
    expect(body.document).toBe(VALID_DOCUMENT);
    expect(body.editToken).toBeUndefined();
  });

  it("404s for an unknown id", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({ method: "GET", url: "/api/canvas/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("503s when the store is not configured", async () => {
    const app = await build(null);
    const res = await app.inject({ method: "GET", url: "/api/canvas/anything" });
    expect(res.statusCode).toBe(503);
  });

  it("500s with a generic message when the store throws, not the raw driver error", async () => {
    const store = fakeStore();
    store.get = async () => {
      throw new Error("connection terminated unexpectedly: pg internals leaked");
    };
    const app = await build(store);
    const res = await app.inject({ method: "GET", url: "/api/canvas/anything" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/pg internals/);
  });
});

describe("DELETE /api/canvas/:id", () => {
  it("removes the canvas with the right edit token, sent in the body (not the URL)", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/canvas/${created.id}`,
      payload: { editToken: created.editToken },
    });
    expect(res.statusCode).toBe(204);
    expect(store.__rows.has(created.id)).toBe(false);
  });

  it("does not accept editToken via the query string any more", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/canvas/${created.id}?editToken=${created.editToken}`,
    });
    // No body was sent, so this must 400 (missing editToken) rather than
    // succeed off the query string.
    expect(res.statusCode).toBe(400);
    expect(store.__rows.has(created.id)).toBe(true);
  });

  it("404s with the wrong edit token, and the row survives", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/canvas/${created.id}`,
      payload: { editToken: "wrong" },
    });
    expect(res.statusCode).toBe(404);
    expect(store.__rows.has(created.id)).toBe(true);
  });

  it("400s when editToken is missing", async () => {
    const app = await build(fakeStore());
    const res = await app.inject({ method: "DELETE", url: "/api/canvas/some-id" });
    expect(res.statusCode).toBe(400);
  });

  it("503s when the store is not configured", async () => {
    const app = await build(null);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/canvas/some-id",
      payload: { editToken: "whatever" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("500s with a generic message when the store throws, not the raw driver error", async () => {
    const store = fakeStore();
    const app = await build(store);
    const created = (
      await app.inject({ method: "POST", url: "/api/canvas/share", payload: shareBody() })
    ).json();
    store.remove = async () => {
      throw new Error("connection terminated unexpectedly: pg internals leaked");
    };
    const res = await app.inject({
      method: "DELETE",
      url: `/api/canvas/${created.id}`,
      payload: { editToken: created.editToken },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toMatch(/pg internals/);
  });
});
