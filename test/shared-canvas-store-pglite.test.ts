// Runs the real shared_canvases SQL (createSharedCanvasStore) against
// PGlite — a real Postgres query planner/executor — rather than a
// hand-written JS interpreter, so a bug in the actual WHERE-clause token
// match (the core security property of update()/remove()) shows up here,
// not just in a model of it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSharedCanvasStore, type SharedCanvasStore } from "../src/sharing/sharedCanvasStore.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

describe("shared canvas store against a real Postgres engine (PGlite)", () => {
  let harness: PgliteHarness;
  let store: SharedCanvasStore;

  beforeAll(async () => {
    harness = await createPgliteHarness(["shared_canvases"]);
    store = createSharedCanvasStore("postgres://x", harness.pool)!;
  }, 30_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("inserts and reads a canvas back, never exposing the edit token", async () => {
    const id = randomUUID();
    await store.insert({
      id,
      ownerId: "owner-1",
      editToken: "secret-token",
      title: "My canvas",
      document: JSON.stringify({ pages: [] }),
    });

    const canvas = await store.get(id);
    expect(canvas).not.toBeNull();
    expect(canvas!.id).toBe(id);
    expect(canvas!.ownerId).toBe("owner-1");
    expect(canvas!.title).toBe("My canvas");
    expect(canvas!.document).toBe(JSON.stringify({ pages: [] }));
    expect((canvas as unknown as { editToken?: string }).editToken).toBeUndefined();
  });

  it("returns null for an unknown id", async () => {
    expect(await store.get(randomUUID())).toBeNull();
  });

  it("update with the right token changes title/document and bumps updated_at", async () => {
    const id = randomUUID();
    await store.insert({
      id,
      ownerId: "owner-1",
      editToken: "secret-token",
      title: "Original",
      document: JSON.stringify({ pages: [] }),
    });
    const before = await store.get(id);

    // Ensure a real, measurable time gap so updated_at strictly advances —
    // now() has microsecond resolution but this loop can run within a
    // single millisecond otherwise.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updatedDoc = JSON.stringify({ pages: [{ id: "p1" }] });
    const updatedAt = await store.update({
      id,
      editToken: "secret-token",
      title: "Renamed",
      document: updatedDoc,
    });
    expect(updatedAt).not.toBeNull();

    const after = await store.get(id);
    expect(after!.title).toBe("Renamed");
    expect(after!.document).toBe(updatedDoc);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    // Regression: update() must return the row's real updated_at (read off
    // the UPDATE's own RETURNING), not merely a truthy signal — the route
    // sends this value straight to the client instead of inventing its own
    // `new Date()`.
    expect(updatedAt!.getTime()).toBe(after!.updatedAt.getTime());
  });

  it("update with the wrong token returns null and leaves the row untouched", async () => {
    const id = randomUUID();
    await store.insert({
      id,
      ownerId: "owner-1",
      editToken: "secret-token",
      title: "Original",
      document: JSON.stringify({ pages: [] }),
    });

    const updatedAt = await store.update({
      id,
      editToken: "wrong-token",
      title: "Should not apply",
      document: JSON.stringify({ pages: ["hacked"] }),
    });
    expect(updatedAt).toBeNull();

    const after = await store.get(id);
    expect(after!.title).toBe("Original");
    expect(after!.document).toBe(JSON.stringify({ pages: [] }));
  });

  it("update against a nonexistent id returns null", async () => {
    const updatedAt = await store.update({
      id: randomUUID(),
      editToken: "whatever",
      title: "x",
      document: JSON.stringify({ pages: [] }),
    });
    expect(updatedAt).toBeNull();
  });

  it("remove with the wrong token then the right token", async () => {
    const id = randomUUID();
    await store.insert({
      id,
      ownerId: "owner-1",
      editToken: "secret-token",
      title: "Original",
      document: JSON.stringify({ pages: [] }),
    });

    const wrongResult = await store.remove(id, "wrong-token");
    expect(wrongResult).toBe(false);
    expect(await store.get(id)).not.toBeNull();

    const rightResult = await store.remove(id, "secret-token");
    expect(rightResult).toBe(true);
    expect(await store.get(id)).toBeNull();
  });

  it("countByOwner counts only that owner's rows", async () => {
    await store.insert({
      id: randomUUID(),
      ownerId: "owner-a",
      editToken: "t1",
      title: "A1",
      document: JSON.stringify({ pages: [] }),
    });
    await store.insert({
      id: randomUUID(),
      ownerId: "owner-a",
      editToken: "t2",
      title: "A2",
      document: JSON.stringify({ pages: [] }),
    });
    await store.insert({
      id: randomUUID(),
      ownerId: "owner-b",
      editToken: "t3",
      title: "B1",
      document: JSON.stringify({ pages: [] }),
    });

    expect(await store.countByOwner("owner-a")).toBe(2);
    expect(await store.countByOwner("owner-b")).toBe(1);
    expect(await store.countByOwner("owner-nonexistent")).toBe(0);
  });
});
