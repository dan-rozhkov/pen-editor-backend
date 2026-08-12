import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import {
  __resetSharedLearnedSkillStore,
  createLearnedSkillStore,
  getLearnedCatalog,
  getSharedLearnedSkillStore,
  invalidateLearnedCatalog,
  type LearnedSkillsPool,
  type LearnedSkillStore,
} from "../src/ai/skills/learnedStore.js";

let harness: PgliteHarness;
let store: LearnedSkillStore;

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_skills"]);
  const created = createLearnedSkillStore(
    makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
    harness.pool,
  );
  expect(created).not.toBeNull();
  store = created!;
});

afterEach(async () => {
  await harness.reset();
  invalidateLearnedCatalog();
});

afterAll(async () => {
  await harness.close();
});

describe("createLearnedSkillStore", () => {
  it("returns null without TRACE_DATABASE_URL and no pool", () => {
    expect(createLearnedSkillStore(makeConfig())).toBeNull();
  });
});

describe("create / get", () => {
  it("creates and reads back a skill with the row defaults", async () => {
    await store.create({ name: "a-skill", description: "does a thing", body: "# A\nbody" });
    const skill = await store.get("a-skill");
    expect(skill).toMatchObject({
      name: "a-skill",
      description: "does a thing",
      body: "# A\nbody",
      createdBy: "agent",
      state: "active",
      useCount: 0,
      viewCount: 0,
    });
  });

  it("returns null for an unknown name", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("rejects a duplicate name (no silent overwrite)", async () => {
    await store.create({ name: "dup", description: "d1", body: "b1" });
    await expect(
      store.create({ name: "dup", description: "d2", body: "b2" }),
    ).rejects.toThrow();
  });
});

describe("listActive", () => {
  it("excludes stale and archived rows and sorts by name", async () => {
    await store.create({ name: "b-skill", description: "b", body: "b" });
    await store.create({ name: "a-skill", description: "a", body: "a" });
    await store.create({ name: "z-old", description: "z", body: "z" });
    await store.create({ name: "y-stale", description: "y", body: "y" });
    await harness.pool.query("UPDATE agent_skills SET state = 'archived' WHERE name = $1", [
      "z-old",
    ]);
    await harness.pool.query("UPDATE agent_skills SET state = 'stale' WHERE name = $1", [
      "y-stale",
    ]);
    expect((await store.listActive()).map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
  });
});

describe("replaceBody", () => {
  it("rewrites the body and moves updated_at", async () => {
    await store.create({ name: "a-skill", description: "d", body: "old" });
    await harness.pool.query("UPDATE agent_skills SET updated_at = now() - interval '1 day'", []);
    await store.replaceBody("a-skill", "new");
    const rows = (await harness.pool.query(
      "SELECT body, updated_at > now() - interval '1 minute' AS fresh FROM agent_skills WHERE name = $1",
      ["a-skill"],
    )) as { rows: Array<{ body: string; fresh: boolean }> };
    expect(rows.rows[0]).toEqual({ body: "new", fresh: true });
  });

  it("aborts (throws, leaves nothing changed) when the row no longer exists", async () => {
    await expect(store.replaceBody("ghost", "new body")).rejects.toThrow(/no longer exists/);
    expect(await store.get("ghost")).toBeNull();
  });
});

describe("remove", () => {
  it("reports whether a row was actually deleted", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    expect(await store.remove("a-skill")).toBe(true);
    expect(await store.remove("a-skill")).toBe(false);
  });
});

describe("bumpUse / bumpView", () => {
  it("bumpUse increments use_count and sets last_used_at", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    await store.bumpUse("a-skill");
    await store.bumpUse("a-skill");
    const rows = (await harness.pool.query(
      "SELECT use_count, last_used_at IS NOT NULL AS used FROM agent_skills WHERE name = $1",
      ["a-skill"],
    )) as { rows: Array<{ use_count: number; used: boolean }> };
    expect(rows.rows[0]).toEqual({ use_count: 2, used: true });
  });

  it("bumpView increments view_count but never use_count", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    await store.bumpView("a-skill");
    await store.bumpView("a-skill");
    const skill = await store.get("a-skill");
    expect(skill).toMatchObject({ viewCount: 2, useCount: 0 });
  });
});

describe("getLearnedCatalog cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hits the cache until invalidated", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

    // A second row lands in the DB but must NOT be visible through the
    // cached read — this is what proves it's actually caching, not just
    // re-querying every time.
    await store.create({ name: "b-skill", description: "d", body: "b" });
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

    invalidateLearnedCatalog();
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
  });

  it("expires after the 30s TTL without an explicit invalidation", async () => {
    vi.useFakeTimers();
    try {
      await store.create({ name: "a-skill", description: "d", body: "b" });
      expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

      await store.create({ name: "b-skill", description: "d", body: "b" });
      vi.advanceTimersByTime(29_000);
      expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

      vi.advanceTimersByTime(2_000); // total 31s, past the 30s TTL
      expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual([
        "a-skill",
        "b-skill",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the last-known catalog instead of throwing when a refetch fails", async () => {
    vi.useFakeTimers();
    try {
      await store.create({ name: "a-skill", description: "d", body: "b" });
      // Populate the cache through a MUTABLE wrapper, not a fresh spread
      // object — the cache is now keyed by store OBJECT IDENTITY (see the
      // "cache isolation" describe block below), so a later call through a
      // *different* object would simply miss the cache rather than
      // exercising the fallback path this test is actually about. Mutating
      // `flaky.listActive` in place keeps the identity constant across both
      // calls.
      const flaky: LearnedSkillStore = { ...store, listActive: () => store.listActive() };
      expect((await getLearnedCatalog(flaky)).map((s) => s.name)).toEqual(["a-skill"]);

      flaky.listActive = async () => {
        throw new Error("db down");
      };
      // Force the TTL to expire so the next call actually attempts a refetch
      // (a live cache would never call listActive at all, and this test
      // would pass for the wrong reason).
      vi.advanceTimersByTime(31_000);
      expect(await getLearnedCatalog(flaky)).toEqual([{ name: "a-skill", description: "d", body: "b", createdBy: "agent", state: "active", useCount: 0, viewCount: 0 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns [] when there is nothing cached and the query fails on a fresh store", async () => {
    invalidateLearnedCatalog();
    const broken: LearnedSkillStore = {
      ...store,
      listActive: async () => {
        throw new Error("db down");
      },
    };
    expect(await getLearnedCatalog(broken)).toEqual([]);
  });

  // Finding 5: the cache used to be one global slot, so getLearnedCatalog(storeA)
  // could return rows that were actually read through storeB — invisible in
  // production (one store per process) but a real bug in any multi-store
  // process (tests, or two differently-configured server instances sharing
  // a module cache). Keying by store object identity fixes it.
  it("keeps two different stores' catalogs isolated from each other", async () => {
    invalidateLearnedCatalog();
    const poolA: LearnedSkillsPool = {
      connect: harness.pool.connect.bind(harness.pool),
      query: harness.pool.query.bind(harness.pool),
      end: async () => {},
    };
    const storeA = createLearnedSkillStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
      poolA,
    )!;
    await storeA.create({ name: "from-a", description: "d", body: "b" });

    const storeB: LearnedSkillStore = {
      ...store,
      listActive: async () => [],
    };

    expect((await getLearnedCatalog(storeA)).map((s) => s.name)).toEqual(["from-a"]);
    // storeB's own (empty) listActive must be consulted — not storeA's
    // cached result — proving the two stores don't share a cache slot.
    expect(await getLearnedCatalog(storeB)).toEqual([]);
  });
});

describe("LearnedSkillStore.close", () => {
  it("closes the underlying pool", async () => {
    const end = vi.fn(async () => {});
    const fakePool: LearnedSkillsPool = {
      connect: async () => {
        throw new Error("not used in this test");
      },
      query: async () => ({ rows: [] }),
      end,
    };
    const fakeStore = createLearnedSkillStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
      fakePool,
    )!;
    await fakeStore.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("getSharedLearnedSkillStore", () => {
  afterEach(() => {
    __resetSharedLearnedSkillStore();
  });

  it("returns the same instance on repeated calls for the same URL", () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/unused" });
    const first = getSharedLearnedSkillStore(config);
    const second = getSharedLearnedSkillStore(config);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("builds a fresh store when the URL changes", () => {
    const first = getSharedLearnedSkillStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/one" }),
    );
    const second = getSharedLearnedSkillStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/two" }),
    );
    expect(second).not.toBe(first);
  });

  // Finding 4: without this, the outgoing store's pool is simply
  // overwritten and never closed — a leak across every URL change (in
  // practice, every test file that rebuilds Config per case).
  it("closes the previous store's pool when the URL changes", () => {
    const first = getSharedLearnedSkillStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/one" }),
    )!;
    const closeSpy = vi.spyOn(first, "close");
    getSharedLearnedSkillStore(makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/two" }));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
