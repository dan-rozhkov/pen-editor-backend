// The real ds_libraries / ds_versions SQL against PGlite: owner scoping,
// unique names, keyset paging, the publish transaction and immutability.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDsStore,
  encodeCursor,
  MAX_LIBRARIES_PER_OWNER,
  MAX_TOTAL_LIBRARIES_PER_OWNER,
  parseLibraryCursor,
  parseVersionCursor,
  type DsPool,
  type DsStore,
  type NewVersion,
  type PublishDecision,
} from "../src/ds/dsStore.js";
import type { Snapshot } from "../src/ds/snapshotSchema.js";
import { assert } from "./helpers.js";
import { createPgliteAuthPool } from "./pgliteAuthPool.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

const EMPTY: Snapshot = { schemaVersion: 1, collections: [], variables: [], components: [] };

function newVersion(version: string, key: string, overrides: Partial<NewVersion> = {}): NewVersion {
  return {
    version,
    bump: "minor",
    baseVersion: null,
    snapshotJson: JSON.stringify(EMPTY),
    snapshotHash: `hash-${version}`,
    changelog: {},
    summary: { added: 0, changed: 0, deprecated: 0, removed: 0 },
    migrations: [],
    notes: "",
    idempotencyKey: key,
    requestHash: `req-${key}`,
    ...overrides,
  };
}

describe("ds store against PGlite", () => {
  let harness: PgliteHarness;
  let store: DsStore;
  let n = 0;

  const create = async (ownerId: string, name: string) => {
    const result = await store.createLibrary({ id: `lib_${++n}`, ownerId, name, description: "" });
    assert(result.kind === "created");
    return result.library;
  };
  const publish = (libraryId: string, ownerId: string, key: string, decision: PublishDecision) =>
    store.publish({ libraryId, ownerId, publishedBy: ownerId, idempotencyKey: key }, () => decision);

  beforeAll(async () => {
    harness = await createPgliteHarness(["ds_libraries"]);
    store = createDsStore("postgres://x", { ...createPgliteAuthPool(harness.pglite), end: async () => {} })!;
  }, 30_000);
  beforeEach(() => {
    n = 0;
  });
  afterEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness.close();
  });

  it("keeps names unique per owner, case-insensitively, and frees them on archive", async () => {
    await create("u1", "Kit");
    expect(await store.createLibrary({ id: "lib_x", ownerId: "u1", name: "kit", description: "" })).toEqual({ kind: "name_taken" });
    expect((await store.createLibrary({ id: "lib_y", ownerId: "u2", name: "Kit", description: "" })).kind).toBe("created");
    expect(await store.archiveLibrary("lib_1", "u1")).toBe(true);
    expect((await store.createLibrary({ id: "lib_z", ownerId: "u1", name: "Kit", description: "" })).kind).toBe("created");
  });

  it("caps live libraries per owner and frees a live slot on archive", async () => {
    for (let i = 0; i < MAX_LIBRARIES_PER_OWNER; i++) await create("u1", `Lib ${i}`);
    expect(await store.createLibrary({ id: "lib_over", ownerId: "u1", name: "One too many", description: "" })).toEqual({
      kind: "limit",
      live: MAX_LIBRARIES_PER_OWNER,
      total: MAX_LIBRARIES_PER_OWNER,
    });
    await store.archiveLibrary("lib_1", "u1");
    expect((await store.createLibrary({ id: "lib_ok", ownerId: "u1", name: "Fits again", description: "" })).kind).toBe("created");
  });

  it("counts archived libraries toward a total cap of 40 and frees the slot on purge", async () => {
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < MAX_LIBRARIES_PER_OWNER; i++) await create("u1", `Lib ${round}-${i}`);
      for (let i = 0; i < MAX_LIBRARIES_PER_OWNER; i++) await store.archiveLibrary(`lib_${round * MAX_LIBRARIES_PER_OWNER + i + 1}`, "u1");
    }
    expect(await store.createLibrary({ id: "lib_over", ownerId: "u1", name: "Over", description: "" })).toEqual({
      kind: "limit",
      live: 0,
      total: MAX_TOTAL_LIBRARIES_PER_OWNER,
    });
    expect((await store.createLibrary({ id: "lib_u2", ownerId: "u2", name: "Other owner", description: "" })).kind).toBe("created");
    expect(await store.purgeLibrary("lib_1", "u1")).toBe("purged");
    expect((await store.createLibrary({ id: "lib_fits", ownerId: "u1", name: "Fits", description: "" })).kind).toBe("created");
  });

  it("purges only an archived library, with its versions, and only for its owner", async () => {
    const lib = await create("u1", "Kit");
    await publish(lib.id, "u1", "key-00001", { kind: "insert", version: newVersion("1.0.0", "key-00001") });
    expect(await store.purgeLibrary(lib.id, "u1")).toBe("not_archived");
    await store.archiveLibrary(lib.id, "u1");
    expect(await store.purgeLibrary(lib.id, "u2")).toBe("not_found");
    expect(await store.purgeLibrary("lib_missing", "u1")).toBe("not_found");
    expect(await store.purgeLibrary(lib.id, "u1")).toBe("purged");
    expect(await store.purgeLibrary(lib.id, "u1")).toBe("not_found");
    const rows = await harness.pglite.query("SELECT count(*)::int AS n FROM ds_versions");
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("keeps concurrent creates within the live cap", async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_LIBRARIES_PER_OWNER + 10 }, (_, i) =>
        store.createLibrary({ id: `lib_c${i}`, ownerId: "u1", name: `Lib ${i}`, description: "" }),
      ),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(MAX_LIBRARIES_PER_OWNER);
    expect(results.filter((r) => r.kind === "limit")).toHaveLength(10);
  });

  it("serializes creates per owner: advisory lock inside one transaction, before the count", async () => {
    const seen: string[] = [];
    const pool = createPgliteAuthPool(harness.pglite);
    const spy: DsPool = {
      query: pool.query,
      end: async () => {},
      connect: async () => {
        const client = await pool.connect();
        return { release: client.release, query: (sql, params) => (seen.push(sql.trim().split(/\s+/).slice(0, 3).join(" ")), client.query(sql, params)) };
      },
    };
    const spied = createDsStore("postgres://x", spy)!;
    await spied.createLibrary({ id: "lib_s", ownerId: "u1", name: "Spied", description: "" });
    const lock = seen.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    expect(seen[0]).toBe("BEGIN");
    expect(lock).toBeGreaterThan(0);
    expect(seen.findIndex((q) => /INSERT INTO ds_libraries/.test(q))).toBeGreaterThan(lock);
    expect(seen.at(-1)).toBe("COMMIT");
  });

  it("validates keyset cursors: bad values are rejected before they reach SQL", () => {
    const good = encodeCursor(["2026-01-01T00:00:00.000001Z", "lib_abc"]);
    expect(parseLibraryCursor(good)).toEqual({ createdAt: "2026-01-01T00:00:00.000001Z", id: "lib_abc" });
    for (const bad of [
      encodeCursor(["not-a-timestamp", "lib_abc"]),
      encodeCursor(["2026-13-01T00:00:00.000001Z", "lib_abc"]),
      encodeCursor(["2026-02-31T00:00:00.000001Z", "lib_abc"]),
      encodeCursor(["2026-01-01T00:00:00.000001Z", "x'; DROP TABLE y;--"]),
      encodeCursor(["2026-01-01T00:00:00.000001Z", ""]),
      encodeCursor(["2026-01-01T00:00:00.000001Z"]),
      "garbage",
    ]) {
      expect(parseLibraryCursor(bad)).toBeNull();
    }
    expect(parseVersionCursor(encodeCursor(["1.10.0"]))).toEqual({ major: 1, minor: 10, patch: 0 });
    for (const bad of ["x.y.z", "1.2", "99999999999.0.0", "1.0.0; x", ""]) expect(parseVersionCursor(encodeCursor([bad]))).toBeNull();
  });

  it("never shows a library to another owner", async () => {
    const lib = await create("u1", "Private");
    expect(await store.getLibrary(lib.id, "u2")).toBeNull();
    expect(await store.updateLibrary(lib.id, "u2", { name: "Mine" })).toEqual({ kind: "not_found" });
    expect(await store.archiveLibrary(lib.id, "u2")).toBe(false);
    expect(await store.getPublishContext(lib.id, "u2")).toBeNull();
    expect(await store.listVersions(lib.id, "u2", { limit: 10, cursor: null })).toBeNull();
    expect(await store.getVersion(lib.id, "u2", "latest")).toEqual({ kind: "no_library" });
    expect(await store.listUpdates(lib.id, "u2", "1.0.0", 10)).toEqual({ kind: "no_library" });
    expect(await publish(lib.id, "u2", "key-00001", { kind: "insert", version: newVersion("1.0.0", "key-00001") })).toEqual({ kind: "not_found" });
  });

  it("pages libraries newest first with a stable keyset cursor", async () => {
    for (let i = 0; i < 5; i++) await create("u1", `Lib ${i}`);
    // Same created_at to the microsecond: the id has to break the tie.
    await harness.pglite.exec("UPDATE ds_libraries SET created_at = '2026-01-01T00:00:00.000001Z' WHERE id IN ('lib_2','lib_3')");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<DsStore["listLibraries"]>> = await store.listLibraries("u1", { limit: 2, cursor });
      seen.push(...page.items.map((l) => l.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(["lib_5", "lib_4", "lib_1", "lib_3", "lib_2"]);
  });

  it("publishes in one transaction, updates latest_version and replays by key", async () => {
    const lib = await create("u1", "Kit");
    const first = await publish(lib.id, "u1", "key-00001", { kind: "insert", version: newVersion("1.0.0", "key-00001") });
    assert(first.kind === "created");
    expect((await store.getLibrary(lib.id, "u1"))?.library.latestVersion).toBe("1.0.0");

    const seen: Array<{ replay: string | null; latest: string | null }> = [];
    const again = await store.publish({ libraryId: lib.id, ownerId: "u1", publishedBy: "u1", idempotencyKey: "key-00001" }, (ctx) => {
      seen.push({ replay: ctx.replay?.requestHash ?? null, latest: ctx.latest?.version ?? null });
      return { kind: "replay", result: ctx.replay! };
    });
    expect(seen).toEqual([{ replay: "req-key-00001", latest: "1.0.0" }]);
    assert(again.kind === "replay");
    expect(again.result.version).toBe("1.0.0");
  });

  it("maps a duplicate version to version_conflict and leaves no partial state", async () => {
    const lib = await create("u1", "Kit");
    await publish(lib.id, "u1", "key-00001", { kind: "insert", version: newVersion("1.0.0", "key-00001") });
    const dup = await publish(lib.id, "u1", "key-00002", { kind: "insert", version: newVersion("1.0.0", "key-00002") });
    expect(dup).toMatchObject({ kind: "reject", status: 409, code: "version_conflict" });
    expect((await store.listVersions(lib.id, "u1", { limit: 10, cursor: null }))?.items).toHaveLength(1);
    // The failed transaction rolled back, so the next one still works.
    const next = await publish(lib.id, "u1", "key-00003", { kind: "insert", version: newVersion("1.1.0", "key-00003") });
    expect(next.kind).toBe("created");
  });

  it("refuses to UPDATE a published version", async () => {
    const lib = await create("u1", "Kit");
    await publish(lib.id, "u1", "key-00001", { kind: "insert", version: newVersion("1.0.0", "key-00001") });
    await expect(harness.pglite.exec("UPDATE ds_versions SET notes = 'edited'")).rejects.toThrow(/immutable/);
  });

  it("orders versions numerically, pages them and lists updates after a version", async () => {
    const lib = await create("u1", "Kit");
    for (const [i, v] of ["1.0.0", "1.1.0", "1.10.0", "2.0.0"].entries()) {
      await publish(lib.id, "u1", `key-0000${i}`, { kind: "insert", version: newVersion(v, `key-0000${i}`, { notes: `notes ${v}` }) });
    }
    const page1 = await store.listVersions(lib.id, "u1", { limit: 2, cursor: null });
    expect(page1?.items.map((v) => v.version)).toEqual(["2.0.0", "1.10.0"]);
    const page2 = await store.listVersions(lib.id, "u1", { limit: 2, cursor: page1?.nextCursor ?? null });
    expect(page2?.items.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(page2?.nextCursor).toBeNull();

    const updates = await store.listUpdates(lib.id, "u1", "1.0.0", 2);
    expect(updates).toMatchObject({ kind: "ok", latest: "2.0.0", hasMore: true });
    assert(updates.kind === "ok");
    expect(updates.items.map((v) => v.version)).toEqual(["1.1.0", "1.10.0"]);
    expect(await store.listUpdates(lib.id, "u1", "9.9.9", 10)).toEqual({ kind: "no_version" });
    const latest = await store.getVersion(lib.id, "u1", "latest");
    assert(latest.kind === "ok");
    expect(latest.version.version).toBe("2.0.0");
    expect(await store.getVersion(lib.id, "u1", "3.0.0")).toEqual({ kind: "no_version" });
    const empty = await create("u1", "Empty");
    expect(await store.getVersion(empty.id, "u1", "latest")).toEqual({ kind: "no_version" });
    expect((await store.listVersions(empty.id, "u1", { limit: 10, cursor: null }))?.items).toEqual([]);
  });
});
