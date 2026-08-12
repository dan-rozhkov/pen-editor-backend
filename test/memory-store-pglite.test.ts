import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/ai/memory/store.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { makeConfig } from "./helpers.js";

let harness: PgliteHarness;
let store: MemoryStore;

beforeAll(async () => {
  harness = await createPgliteHarness([
    "agent_memory",
    "agent_review_state",
    "agent_selfimprove_audit",
  ]);
  const created = createMemoryStore(
    makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
    harness.pool,
  );
  expect(created).not.toBeNull();
  store = created!;
});

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

describe("createMemoryStore", () => {
  it("returns null without TRACE_DATABASE_URL", () => {
    expect(createMemoryStore(makeConfig())).toBeNull();
  });
});

describe("loadSnapshot / applyOperations", () => {
  it("returns an empty snapshot for an unknown user", async () => {
    expect(await store.loadSnapshot("nobody")).toEqual({ memory: [], user: [] });
  });

  it("persists an add and reads it back on both targets independently", async () => {
    const out = await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "User prefers concise responses" }],
      origin: "foreground",
    });
    expect(out.ok).toBe(true);

    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "Repo uses ESM with .js import extensions" }],
      origin: "foreground",
    });

    expect(await store.loadSnapshot("u1")).toEqual({
      user: ["User prefers concise responses"],
      memory: ["Repo uses ESM with .js import extensions"],
    });
  });

  it("scopes memory per user", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }],
      origin: "foreground",
    });
    expect(await store.loadSnapshot("u2")).toEqual({ memory: [], user: [] });
  });

  it("leaves the row untouched when the batch fails", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "keep" }],
      origin: "foreground",
    });
    const out = await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "remove", old_text: "missing" }],
      origin: "foreground",
    });
    expect(out.ok).toBe(false);
    expect((await store.loadSnapshot("u1")).user).toEqual(["keep"]);
  });

  it("audits every successful write and nothing else", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "note" }],
      origin: "background_review",
    });
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "remove", old_text: "nope" }],
      origin: "background_review",
    });

    const rows = (await harness.pool.query(
      "SELECT origin, subsystem, action, payload FROM agent_selfimprove_audit WHERE user_id = $1",
      ["u1"],
    )) as {
      rows: Array<{ origin: string; subsystem: string; action: string; payload: Record<string, unknown> }>;
    };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].origin).toBe("background_review");
    expect(rows.rows[0].subsystem).toBe("memory");
    expect(rows.rows[0].action).toBe("add");
    expect(rows.rows[0].payload).toMatchObject({ target: "memory", entryCount: 1 });
  });
});

describe("listAuditActivity", () => {
  it("returns latestId=null and no events for a user with no audit rows", async () => {
    expect(await store.listAuditActivity({ userId: "ghost" })).toEqual({
      events: [],
      latestId: null,
    });
  });

  it("baseline mode (no sinceId) returns no events, only the current max id", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "first" }],
      origin: "foreground",
    });
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "second" }],
      origin: "foreground",
    });

    const result = await store.listAuditActivity({ userId: "u1" });
    expect(result.events).toEqual([]);
    expect(typeof result.latestId).toBe("number");
    expect(result.latestId).not.toBeNull();
  });

  it("with sinceId, returns only rows with id > sinceId in ascending id order", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "first" }],
      origin: "foreground",
    });
    const baseline = await store.listAuditActivity({ userId: "u1" });
    const sinceId = baseline.latestId!;

    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "second" }],
      origin: "background_review",
    });
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "third" }],
      origin: "background_review",
    });

    const result = await store.listAuditActivity({ userId: "u1", sinceId });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({ subsystem: "memory", action: "add", origin: "background_review" });
    expect(result.events[1]).toMatchObject({ subsystem: "memory", action: "add", origin: "background_review" });
    expect(result.events[0].id).toBeLessThan(result.events[1].id);
    expect(typeof result.events[0].id).toBe("number");
    expect(typeof result.events[0].createdAt).toBe("string");
    // Never echoes entry contents.
    expect(result.events[0]).not.toHaveProperty("payload");
    expect(result.latestId).toBe(result.events[1].id);
  });

  it("isolates activity between users", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "u1 note" }],
      origin: "foreground",
    });
    await store.applyOperations({
      userId: "u2",
      target: "memory",
      operations: [{ action: "add", content: "u2 note" }],
      origin: "foreground",
    });

    const u1 = await store.listAuditActivity({ userId: "u1", sinceId: 0 });
    expect(u1.events).toHaveLength(1);
    const u2 = await store.listAuditActivity({ userId: "u2", sinceId: 0 });
    expect(u2.events).toHaveLength(1);
    expect(u1.latestId).not.toBe(u2.latestId);
  });

  it("caps results at the limit while latestId still reflects the true max", async () => {
    for (let i = 0; i < 3; i++) {
      await store.applyOperations({
        userId: "u1",
        target: "memory",
        operations: [{ action: "add", content: `note ${i}` }],
        origin: "foreground",
      });
    }
    const result = await store.listAuditActivity({ userId: "u1", sinceId: 0, limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.latestId).toBeGreaterThan(result.events[1].id);
  });
});

describe("listUsers", () => {
  it("returns nothing when no user has stored memory", async () => {
    expect(await store.listUsers(20)).toEqual([]);
  });

  it("lists distinct users, most recently updated first", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }],
      origin: "foreground",
    });
    await store.applyOperations({
      userId: "u2",
      target: "memory",
      operations: [{ action: "add", content: "B" }],
      origin: "foreground",
    });
    // A second write to u1 should not duplicate it in the list.
    await store.applyOperations({
      userId: "u2",
      target: "user",
      operations: [{ action: "add", content: "C" }],
      origin: "foreground",
    });

    const users = await store.listUsers(20);
    expect(users.map((u) => u.userId).sort()).toEqual(["u1", "u2"]);
    // u2 was written to more recently.
    expect(users[0].userId).toBe("u2");
  });

  it("respects the limit", async () => {
    for (const id of ["u1", "u2", "u3"]) {
      await store.applyOperations({
        userId: id,
        target: "user",
        operations: [{ action: "add", content: "x" }],
        origin: "foreground",
      });
    }
    expect(await store.listUsers(2)).toHaveLength(2);
  });
});

describe("clearUser", () => {
  it("wipes both targets and returns the cleared counts", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }, { action: "add", content: "B" }],
      origin: "foreground",
    });
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "C" }],
      origin: "foreground",
    });

    const counts = await store.clearUser("u1", "curator");
    expect(counts).toEqual({ user: 2, memory: 1 });
    expect(await store.loadSnapshot("u1")).toEqual({ memory: [], user: [] });
  });

  it("is a no-op with zero counts for a user with nothing stored", async () => {
    expect(await store.clearUser("ghost", "curator")).toEqual({ memory: 0, user: 0 });
  });

  it("does not touch another user's memory", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }],
      origin: "foreground",
    });
    await store.applyOperations({
      userId: "u2",
      target: "user",
      operations: [{ action: "add", content: "B" }],
      origin: "foreground",
    });

    await store.clearUser("u1", "curator");
    expect(await store.loadSnapshot("u2")).toEqual({ memory: [], user: ["B"] });
  });

  it("writes a single curator-origin audit row", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }],
      origin: "foreground",
    });
    await store.clearUser("u1", "curator");

    const rows = (await harness.pool.query(
      "SELECT origin, subsystem, action FROM agent_selfimprove_audit WHERE user_id = $1 AND action = 'clear'",
      ["u1"],
    )) as { rows: Array<{ origin: string; subsystem: string; action: string }> };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ origin: "curator", subsystem: "memory", action: "clear" });
  });
});

describe("bumpCounters", () => {
  it("accumulates across requests and fires + resets exactly at the threshold", async () => {
    let last = { turnsSinceMemory: 0, stepsSinceSkill: 0, memoryReviewDue: false };
    for (let i = 0; i < 3; i++) {
      last = await store.bumpCounters({ userId: "u1", turns: 1, steps: 2, memoryInterval: 3 });
    }
    expect(last).toEqual({ turnsSinceMemory: 3, stepsSinceSkill: 6, memoryReviewDue: true });

    const after = await store.bumpCounters({ userId: "u1", turns: 1, steps: 1, memoryInterval: 3 });
    expect(after.turnsSinceMemory).toBe(1);
    expect(after.memoryReviewDue).toBe(false);
    // steps_since_skill is phase 2's counter — the memory reset must not clear it.
    expect(after.stepsSinceSkill).toBe(7);
  });

  // Phase 2: skillInterval is an optional add-on to the same call. Omitted →
  // the return object must have EXACTLY the phase-1 shape (no extra key),
  // which is what the first test in this block already pins via toEqual.
  it("omits skillReviewDue entirely when skillInterval is not passed", async () => {
    const result = await store.bumpCounters({ userId: "u2", turns: 1, steps: 5, memoryInterval: 3 });
    expect(result).not.toHaveProperty("skillReviewDue");
  });

  it("computes and resets skillReviewDue independently of the memory counter", async () => {
    let last = await store.bumpCounters({
      userId: "u3",
      turns: 1,
      steps: 2,
      memoryInterval: 100,
      skillInterval: 3,
    });
    expect(last.skillReviewDue).toBe(false);
    last = await store.bumpCounters({
      userId: "u3",
      turns: 1,
      steps: 2,
      memoryInterval: 100,
      skillInterval: 3,
    });
    expect(last).toMatchObject({ stepsSinceSkill: 4, skillReviewDue: true, memoryReviewDue: false });

    const after = await store.bumpCounters({
      userId: "u3",
      turns: 1,
      steps: 1,
      memoryInterval: 100,
      skillInterval: 3,
    });
    // The skill reset must not touch the (unrelated, not-yet-due) memory counter.
    expect(after).toMatchObject({ stepsSinceSkill: 1, skillReviewDue: false, turnsSinceMemory: 3 });
  });
});
