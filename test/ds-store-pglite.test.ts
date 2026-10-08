// The real ds_libraries / ds_versions SQL against PGlite: owner scoping,
// unique names, keyset paging, the publish transaction and immutability.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDsStore, MAX_LIBRARIES_PER_OWNER, type DsStore, type NewVersion, type PublishDecision } from "../src/ds/dsStore.js";
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
    snapshot: EMPTY,
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

  it("caps live libraries per owner, not archived ones", async () => {
    for (let i = 0; i < MAX_LIBRARIES_PER_OWNER; i++) await create("u1", `Lib ${i}`);
    expect(await store.createLibrary({ id: "lib_over", ownerId: "u1", name: "One too many", description: "" })).toEqual({ kind: "limit" });
    await store.archiveLibrary("lib_1", "u1");
    expect((await store.createLibrary({ id: "lib_ok", ownerId: "u1", name: "Fits again", description: "" })).kind).toBe("created");
  });

  it("never shows a library to another owner", async () => {
    const lib = await create("u1", "Private");
    expect(await store.getLibrary(lib.id, "u2")).toBeNull();
    expect(await store.updateLibrary(lib.id, "u2", { name: "Mine" })).toEqual({ kind: "not_found" });
    expect(await store.archiveLibrary(lib.id, "u2")).toBe(false);
    expect(await store.getPublishContext(lib.id, "u2")).toBeNull();
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
    expect((await store.listVersions(lib.id, { limit: 10, cursor: null })).items).toHaveLength(1);
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
    const page1 = await store.listVersions(lib.id, { limit: 2, cursor: null });
    expect(page1.items.map((v) => v.version)).toEqual(["2.0.0", "1.10.0"]);
    const page2 = await store.listVersions(lib.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(page2.nextCursor).toBeNull();

    const updates = await store.listUpdates(lib.id, "1.0.0", 2);
    expect(updates?.items.map((v) => v.version)).toEqual(["1.1.0", "1.10.0"]);
    expect(updates?.hasMore).toBe(true);
    expect(await store.listUpdates(lib.id, "9.9.9", 10)).toBeNull();
    expect((await store.getVersion(lib.id, "latest"))?.version).toBe("2.0.0");
    expect(await store.getVersion(lib.id, "3.0.0")).toBeNull();
  });
});
