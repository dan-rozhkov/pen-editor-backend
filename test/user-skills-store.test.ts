import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import {
  __resetSharedUserSkillStore,
  createUserSkillStore,
  getSharedUserSkillStore,
  UserSkillExistsError,
  type UserSkillsPool,
  type UserSkillStore,
} from "../src/ai/skills/userStore.js";

let harness: PgliteHarness;
let store: UserSkillStore;

beforeAll(async () => {
  harness = await createPgliteHarness(["user_skills"]);
  const created = createUserSkillStore("postgres://unused", harness.pool);
  expect(created).not.toBeNull();
  store = created!;
});

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

describe("createUserSkillStore", () => {
  it("returns null without a connection string and no pool", () => {
    expect(createUserSkillStore(undefined)).toBeNull();
  });
});

describe("create / get", () => {
  it("creates and reads back a skill with the row defaults", async () => {
    await store.create({
      userId: "user-a",
      name: "my-skill",
      description: "does a thing",
      body: "# A\nbody",
      source: "manual",
    });
    const skill = await store.get("user-a", "my-skill");
    expect(skill).toMatchObject({
      userId: "user-a",
      name: "my-skill",
      description: "does a thing",
      body: "# A\nbody",
      enabled: true,
      source: "manual",
      useCount: 0,
      lastUsedAt: null,
    });
  });

  it("returns null for an unknown name", async () => {
    expect(await store.get("user-a", "nope")).toBeNull();
  });

  it("rejects a duplicate (user_id, name) with a typed error", async () => {
    await store.create({ userId: "user-a", name: "dup", description: "d1", body: "b1", source: "manual" });
    await expect(
      store.create({ userId: "user-a", name: "dup", description: "d2", body: "b2", source: "manual" }),
    ).rejects.toBeInstanceOf(UserSkillExistsError);
  });
});

describe("per-user isolation", () => {
  it("lets two different users use the same skill name", async () => {
    await store.create({ userId: "user-a", name: "shared-name", description: "a's", body: "a", source: "manual" });
    await store.create({ userId: "user-b", name: "shared-name", description: "b's", body: "b", source: "manual" });

    expect((await store.get("user-a", "shared-name"))?.description).toBe("a's");
    expect((await store.get("user-b", "shared-name"))?.description).toBe("b's");
  });

  it("list() only returns the requesting user's skills", async () => {
    await store.create({ userId: "user-a", name: "a-skill", description: "d", body: "b", source: "manual" });
    await store.create({ userId: "user-b", name: "b-skill", description: "d", body: "b", source: "manual" });

    expect((await store.list("user-a")).map((s) => s.name)).toEqual(["a-skill"]);
    expect((await store.list("user-b")).map((s) => s.name)).toEqual(["b-skill"]);
  });
});

describe("list / listEnabled ordering", () => {
  it("orders by updated_at DESC and listEnabled excludes disabled rows", async () => {
    await store.create({ userId: "user-a", name: "first", description: "d", body: "b", source: "manual" });
    await store.create({ userId: "user-a", name: "second", description: "d", body: "b", source: "manual" });
    await store.update("user-a", "first", { enabled: false });
    // Nudge "first"'s updated_at forward so ordering isn't accidentally
    // correct because of insertion order alone.
    await harness.pool.query(
      "UPDATE user_skills SET updated_at = now() + interval '1 minute' WHERE user_id = $1 AND name = $2",
      ["user-a", "first"],
    );

    expect((await store.list("user-a")).map((s) => s.name)).toEqual(["first", "second"]);
    expect((await store.listEnabled("user-a")).map((s) => s.name)).toEqual(["second"]);
  });
});

describe("update", () => {
  it("patches description/body/enabled and moves updated_at", async () => {
    await store.create({ userId: "user-a", name: "a-skill", description: "old", body: "old body", source: "manual" });
    await harness.pool.query("UPDATE user_skills SET updated_at = now() - interval '1 day'", []);

    const updated = await store.update("user-a", "a-skill", {
      description: "new",
      body: "new body",
      enabled: false,
    });

    expect(updated).toMatchObject({ description: "new", body: "new body", enabled: false });
    const rows = (await harness.pool.query(
      "SELECT updated_at > now() - interval '1 minute' AS fresh FROM user_skills WHERE user_id = $1 AND name = $2",
      ["user-a", "a-skill"],
    )) as { rows: Array<{ fresh: boolean }> };
    expect(rows.rows[0].fresh).toBe(true);
  });

  it("renames a skill via newName", async () => {
    await store.create({ userId: "user-a", name: "old-name", description: "d", body: "b", source: "manual" });

    const updated = await store.update("user-a", "old-name", { newName: "new-name" });

    expect(updated?.name).toBe("new-name");
    expect(await store.get("user-a", "old-name")).toBeNull();
    expect(await store.get("user-a", "new-name")).not.toBeNull();
  });

  it("rejects a rename onto an already-taken name for the same user", async () => {
    await store.create({ userId: "user-a", name: "a", description: "d", body: "b", source: "manual" });
    await store.create({ userId: "user-a", name: "b", description: "d", body: "b", source: "manual" });

    await expect(store.update("user-a", "a", { newName: "b" })).rejects.toBeInstanceOf(UserSkillExistsError);
  });

  it("returns null for a name that does not exist", async () => {
    expect(await store.update("user-a", "nope", { description: "x" })).toBeNull();
  });

  it("leaves an omitted field unchanged (partial patch)", async () => {
    await store.create({ userId: "user-a", name: "a-skill", description: "kept", body: "kept body", source: "manual" });

    const updated = await store.update("user-a", "a-skill", { enabled: false });

    expect(updated).toMatchObject({ description: "kept", body: "kept body", enabled: false });
  });
});

describe("remove", () => {
  it("reports whether a row was actually deleted, scoped to the user", async () => {
    await store.create({ userId: "user-a", name: "a-skill", description: "d", body: "b", source: "manual" });
    expect(await store.remove("user-b", "a-skill")).toBe(false);
    expect(await store.remove("user-a", "a-skill")).toBe(true);
    expect(await store.remove("user-a", "a-skill")).toBe(false);
  });
});

describe("bumpUse", () => {
  it("increments use_count and sets last_used_at", async () => {
    await store.create({ userId: "user-a", name: "a-skill", description: "d", body: "b", source: "manual" });
    await store.bumpUse("user-a", "a-skill");
    await store.bumpUse("user-a", "a-skill");

    const skill = await store.get("user-a", "a-skill");
    expect(skill?.useCount).toBe(2);
    expect(skill?.lastUsedAt).not.toBeNull();
  });
});

describe("count", () => {
  it("counts only the given user's rows", async () => {
    await store.create({ userId: "user-a", name: "a1", description: "d", body: "b", source: "manual" });
    await store.create({ userId: "user-a", name: "a2", description: "d", body: "b", source: "manual" });
    await store.create({ userId: "user-b", name: "b1", description: "d", body: "b", source: "manual" });

    expect(await store.count("user-a")).toBe(2);
    expect(await store.count("user-b")).toBe(1);
    expect(await store.count("user-c")).toBe(0);
  });
});

describe("UserSkillStore.close", () => {
  it("closes the underlying pool", async () => {
    const end = vi.fn(async () => {});
    const fakePool: UserSkillsPool = {
      query: async () => ({ rows: [] }),
      end,
    };
    const fakeStore = createUserSkillStore("postgres://unused", fakePool)!;
    await fakeStore.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("getSharedUserSkillStore", () => {
  afterEach(() => {
    __resetSharedUserSkillStore();
  });

  it("returns null without a url", () => {
    expect(getSharedUserSkillStore(undefined)).toBeNull();
  });

  it("returns the same instance on repeated calls for the same url", () => {
    const first = getSharedUserSkillStore("postgres://localhost/unused");
    const second = getSharedUserSkillStore("postgres://localhost/unused");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("builds a fresh store when the url changes", () => {
    const first = getSharedUserSkillStore("postgres://localhost/one");
    const second = getSharedUserSkillStore("postgres://localhost/two");
    expect(second).not.toBe(first);
  });

  it("closes the previous store's pool when the url changes", () => {
    const first = getSharedUserSkillStore("postgres://localhost/one")!;
    const closeSpy = vi.spyOn(first, "close");
    getSharedUserSkillStore("postgres://localhost/two");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
