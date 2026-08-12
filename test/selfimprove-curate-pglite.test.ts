// The curator's SQL runs against a real Postgres engine here (PGlite), not a
// hand-written fake: `SELECT … FOR UPDATE`, `= ANY($1::text[])` and a jsonb
// snapshot insert are all things a JS interpreter of the query would happily
// accept while real Postgres rejects (or silently misbehaves on).
//
// Reuses the generic harness from test/pgliteShowcaseHelpers.ts
// (createPgliteHarness(truncateTables)) rather than a selfimprove-specific
// copy — it already boots PGlite, applies the real migrations once, and
// truncates only the tables this suite names. This IS the "reusable PGlite
// harness" task: the showcase suite generalized it first, so there is
// exactly one copy of the PGlite adapter in the repo.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { curateSkills, type CuratorClient } from "../src/ai/selfimprove/curate.js";
import { createLearnedSkillStore, type LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { Config } from "../src/config.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

let harness: PgliteHarness;
let client: CuratorClient;
let learnedStore: LearnedSkillStore;

interface SeedSkill {
  name: string;
  state?: string;
  useCount?: number;
  lastUsedAt?: string | null;
  createdAt?: string;
}

async function seed(skill: SeedSkill): Promise<void> {
  await client.query(
    `INSERT INTO agent_skills
       (name, description, body, created_by, state, use_count, last_used_at, created_at)
     VALUES ($1, $2, $3, 'agent', $4, $5, $6, $7)`,
    [
      skill.name,
      `desc for ${skill.name}`,
      `# ${skill.name}\n\nbody`,
      skill.state ?? "active",
      skill.useCount ?? 0,
      skill.lastUsedAt ?? null,
      skill.createdAt ?? daysAgo(365),
    ],
  );
}

async function statesByName(): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT name, state FROM agent_skills", []);
  const out: Record<string, string> = {};
  for (const row of rows as { name: string; state: string }[]) {
    out[row.name] = row.state;
  }
  return out;
}

async function auditRows(): Promise<
  { origin: string; subsystem: string; action: string; user_id: string; payload: unknown }[]
> {
  const { rows } = await client.query(
    "SELECT user_id, origin, subsystem, action, payload FROM agent_selfimprove_audit ORDER BY id",
    [],
  );
  return rows as {
    origin: string;
    subsystem: string;
    action: string;
    user_id: string;
    payload: unknown;
  }[];
}

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_skills", "agent_selfimprove_audit"]);
  client = harness.db as unknown as CuratorClient;
  // fake TRACE_DATABASE_URL: createLearnedSkillStore only checks it's set
  // when no pool is injected; here we always inject the PGlite-backed pool.
  learnedStore = createLearnedSkillStore({} as Config, harness.pool)!;
});

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

describe("curateSkills", () => {
  it("reports transitions but writes nothing without --apply", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    const result = await curateSkills(client, { apply: false, now: NOW });

    expect(result.scanned).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.transitions.map((t) => [t.name, t.to])).toEqual([
      ["dead", "archived"],
      ["rusty", "stale"],
    ]);
    expect(await statesByName()).toEqual({ fresh: "active", rusty: "active", dead: "stale" });
    expect(await auditRows()).toEqual([]);
  });

  it("applies the transitions and leaves everything else alone with --apply", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });
    await seed({ name: "in-use", createdAt: daysAgo(200), lastUsedAt: daysAgo(1) });

    const result = await curateSkills(client, { apply: true, now: NOW });

    expect(result.applied).toBe(true);
    expect(await statesByName()).toEqual({
      fresh: "active",
      rusty: "stale",
      dead: "archived",
      "in-use": "active",
    });
  });

  it("writes exactly one pre-mutation snapshot row before touching any state", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    await curateSkills(client, { apply: true, now: NOW });

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].origin).toBe("curator");
    expect(audit[0].subsystem).toBe("skill");
    expect(audit[0].action).toBe("snapshot");
    expect(audit[0].user_id).toBe("system");

    // The snapshot must show the world BEFORE the update — that is the whole
    // point of taking it first. Post-mutation states here would mean the
    // snapshot is useless for recovery.
    const payload = audit[0].payload as { name: string; state: string }[];
    expect(payload).toHaveLength(2);
    const snapshotStates = Object.fromEntries(payload.map((r) => [r.name, r.state]));
    expect(snapshotStates).toEqual({ rusty: "active", dead: "stale" });
  });

  it("snapshots the full row, not just the classified columns", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });

    await curateSkills(client, { apply: true, now: NOW });

    const payload = (await auditRows())[0].payload as Record<string, unknown>[];
    expect(payload[0]).toMatchObject({
      name: "rusty",
      description: "desc for rusty",
      created_by: "agent",
    });
    expect(payload[0].body).toContain("# rusty");
  });

  it("writes no audit row when there is nothing to change", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });

    const result = await curateSkills(client, { apply: true, now: NOW });

    expect(result.transitions).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("never deletes a row — archived skills stay in the table", async () => {
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    await curateSkills(client, { apply: true, now: NOW });

    const { rows } = await client.query("SELECT count(*)::int AS n FROM agent_skills", []);
    expect((rows as { n: number }[])[0].n).toBe(1);
    expect(await statesByName()).toEqual({ dead: "archived" });
  });

  it("takes one step per run: active → stale now, archived only on a later run", async () => {
    await seed({ name: "ancient", createdAt: daysAgo(500), lastUsedAt: daysAgo(300) });

    await curateSkills(client, { apply: true, now: NOW });
    expect(await statesByName()).toEqual({ ancient: "stale" });

    await curateSkills(client, { apply: true, now: NOW });
    expect(await statesByName()).toEqual({ ancient: "archived" });

    // Third run has nothing left to do, and does not touch the audit log again.
    const third = await curateSkills(client, { apply: true, now: NOW });
    expect(third.transitions).toEqual([]);
    expect(await auditRows()).toHaveLength(2);
  });

  // Finding 1: the UPDATE used to guard only by name, so a row that changed
  // state (or last_used_at) after this run's own snapshot read would still
  // get overwritten with the transition computed from the stale snapshot.
  // PGlite is a single connection (see pgliteShowcaseHelpers.ts), so a query
  // issued "concurrently" through a second handle to the same instance
  // actually interleaves with the one open transaction rather than truly
  // racing it — which is exactly what's needed here: it lets a plain UPDATE
  // land, uninterrupted by any lock, right in the gap between curateSkills's
  // own snapshot read and its guarded UPDATE, standing in for a writer that
  // (under real Postgres) would otherwise have been serialized behind the
  // FOR UPDATE lock and applied only after this transaction committed.
  it("does not apply a transition when the row changed after this run's own snapshot", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });

    let sawSelect = false;
    const racyClient: CuratorClient = {
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (!sawSelect && sql.includes("FOR UPDATE") && sql.includes("SELECT")) {
          sawSelect = true;
          // Simulate a foreground load_skill()'s bumpUse landing in the gap
          // between the snapshot read above and curateSkills's own UPDATE —
          // the skill was used again right as it was about to be staled.
          await harness.pool.query(
            "UPDATE agent_skills SET last_used_at = now() WHERE name = 'rusty'",
          );
        }
        return result;
      },
    };

    const result = await curateSkills(racyClient, { apply: true, now: NOW });

    // The transition is dropped from the report — it did not actually land.
    expect(result.transitions).toEqual([]);
    // And the row itself is still active: the guard blocked the UPDATE.
    expect(await statesByName()).toEqual({ rusty: "active" });
  });

  it("applies every other transition in the same run even when one is skipped by the race guard", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "also-rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(50) });

    let sawSelect = false;
    const racyClient: CuratorClient = {
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (!sawSelect && sql.includes("FOR UPDATE") && sql.includes("SELECT")) {
          sawSelect = true;
          await harness.pool.query(
            "UPDATE agent_skills SET last_used_at = now() WHERE name = 'rusty'",
          );
        }
        return result;
      },
    };

    const result = await curateSkills(racyClient, { apply: true, now: NOW });

    expect(result.transitions.map((t) => t.name)).toEqual(["also-rusty"]);
    expect(await statesByName()).toEqual({ rusty: "active", "also-rusty": "stale" });
  });

  it("bumps updated_at only on the rows it transitions", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await client.query("UPDATE agent_skills SET updated_at = $1", [daysAgo(200)]);

    await curateSkills(client, { apply: true, now: NOW });

    const { rows } = await client.query(
      "SELECT name, updated_at FROM agent_skills ORDER BY name",
      [],
    );
    const byName = Object.fromEntries(
      (rows as { name: string; updated_at: Date | string }[]).map((r) => [
        r.name,
        new Date(r.updated_at).getTime(),
      ]),
    );
    const oldMark = new Date(daysAgo(200)).getTime();
    expect(byName.fresh).toBe(oldMark);
    expect(byName.rusty).toBeGreaterThan(oldMark);
  });
});

// Task 6: archiving is only meaningful if the catalog and load_skill stop
// seeing the row. Phase 2's learnedStore.ts already filters listActive() to
// state = 'active' and load_skill (src/ai/skills.ts) checks
// `learned.state === "active"` before returning a body — both were correct
// on inspection, so nothing needed to change there; this just pins it.
describe("archived skills disappear from the agent's view", () => {
  it("is excluded from the catalog listing while active and stale are not", async () => {
    await seed({ name: "alive", state: "active" });
    await seed({ name: "resting", state: "stale" });
    await seed({ name: "gone", state: "archived" });

    const catalog = await learnedStore.listActive();

    expect(catalog.map((s) => s.name).sort()).toEqual(["alive"]);
  });

  it("is not resolvable as active by name (load_skill's gate)", async () => {
    await seed({ name: "gone", state: "archived" });
    await seed({ name: "alive", state: "active" });

    const alive = await learnedStore.get("alive");
    const gone = await learnedStore.get("gone");
    expect(alive?.state).toBe("active");
    expect(gone?.state).toBe("archived");
    // load_skill (src/ai/skills.ts) only returns a body when
    // `learned.state === "active"` — an archived row still exists (never
    // deleted) but fails that check, which is the behavior this pins.
  });

  // Finding 2: `stale` must be a real grace period, not `archived` under a
  // softer name. It's excluded from the catalog like `archived` is, but
  // stays resolvable by name — and a successful bumpUse (what load_skill
  // calls on a hit) revives it back to `active`, which is the only path back.
  it("is excluded from listActive while stale, but resolvable by name and revived by bumpUse", async () => {
    await seed({ name: "resting", state: "stale" });
    expect(await learnedStore.listActive()).toHaveLength(0);

    const before = await learnedStore.get("resting");
    expect(before?.state).toBe("stale");

    await learnedStore.bumpUse("resting");

    const after = await learnedStore.get("resting");
    expect(after?.state).toBe("active");
    expect((await learnedStore.listActive()).map((s) => s.name)).toEqual(["resting"]);
  });

  it("is what a curator run actually produces end to end", async () => {
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });
    expect(await learnedStore.listActive()).toHaveLength(0);

    await seed({ name: "alive", state: "active", createdAt: daysAgo(1) });
    expect((await learnedStore.listActive()).map((s) => s.name)).toEqual(["alive"]);

    await curateSkills(client, { apply: true, now: NOW });

    expect((await learnedStore.listActive()).map((s) => s.name)).toEqual(["alive"]);
    const dead = await learnedStore.get("dead");
    expect(dead?.state).toBe("archived");
  });
});
