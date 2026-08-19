// Runs the store's SQL against a real Postgres engine (PGlite), not a JS
// fake: `IS NOT DISTINCT FROM` against a NULL bind, array literals, and
// jsonb casts are exactly the class of thing a hand-rolled interpreter would
// get subtly wrong while real Postgres enforces correctly.
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { upsertScenario } from "../src/analysis/scenarioStore.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_scenarios"]);
});
afterEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness.close();
});

const base = {
  scope: "user" as const,
  userId: "u1",
  kind: "correction" as const,
  title: "starts with questions",
  recipe: "show a draft first",
};

// Defect 3: agent_scenarios_bucket_idx (scope, user_id, state) was a strict
// column-prefix of agent_scenarios_due_idx (scope, user_id, state,
// confirmations DESC) — every query the bucket index could serve, the due
// index serves equally well as a leading-column subset, so it was pure
// write/storage overhead with no query it uniquely covered.
it("does not create the redundant bucket index alongside the due index", async () => {
  const { rows } = await harness.db.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'agent_scenarios'",
    [],
  );
  const names = rows.map((r) => (r as { indexname: string }).indexname);
  expect(names).toContain("agent_scenarios_due_idx");
  expect(names).not.toContain("agent_scenarios_bucket_idx");
});

it("inserts a new scenario with confirmations = distinct sessions", async () => {
  const outcome = await upsertScenario(harness.db, {
    ...base,
    sessionIds: ["s1", "s2", "s1"],
    embedding: [1, 0],
  });
  expect(outcome).toBe("inserted");
  const { rows: raw } = await harness.db.query("SELECT confirmations, state FROM agent_scenarios", []);
  expect(raw).toHaveLength(1);
  expect(raw[0]).toMatchObject({ confirmations: 2, state: "open" });
});

it("merges a near-duplicate instead of inserting a second row", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  const outcome = await upsertScenario(harness.db, {
    ...base,
    title: "keeps asking questions",
    sessionIds: ["s2", "s3"],
    embedding: [0.99, 0.02],
  });
  expect(outcome).toBe("merged");
  const { rows } = await harness.db.query("SELECT confirmations, session_ids FROM agent_scenarios", []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ confirmations: 3 });
});

it("does not merge across buckets (different user, or user vs global)", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await upsertScenario(harness.db, {
    scope: "global",
    userId: null,
    kind: "correction",
    title: "same",
    recipe: "r",
    sessionIds: ["s4", "s5"],
    embedding: [1, 0],
  });
  const { rows } = await harness.db.query("SELECT id FROM agent_scenarios", []);
  expect(rows).toHaveLength(2);
});

it("does not merge into a different user's bucket even with the same title vector", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await upsertScenario(harness.db, { ...base, userId: "u2", sessionIds: ["s3", "s4"], embedding: [1, 0] });
  const { rows } = await harness.db.query("SELECT id, user_id FROM agent_scenarios", []);
  expect(rows).toHaveLength(2);
});

// Defect 1: the old dedup read only ever saw state IN ('open','offered'), so
// a rejected/distilled row was invisible to upsertScenario and a
// re-extracted duplicate went straight to INSERT — resurrecting a pattern
// the user already declined (or that already became a memory/skill) as a
// brand-new 'open' row on the very next analysis run.
it("skips (does not resurrect) a duplicate whose only match is rejected", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await harness.db.query("UPDATE agent_scenarios SET state = 'rejected'", []);
  const outcome = await upsertScenario(harness.db, { ...base, sessionIds: ["s3", "s4"], embedding: [1, 0] });
  expect(outcome).toBe("skipped");
  const { rows } = await harness.db.query("SELECT id, state, session_ids FROM agent_scenarios", []);
  // No second row, and the rejected row is untouched (not re-merged either).
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "rejected", session_ids: ["s1", "s2"] });
});

it("skips (does not resurrect) a duplicate whose only match is distilled", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await harness.db.query("UPDATE agent_scenarios SET state = 'distilled'", []);
  const outcome = await upsertScenario(harness.db, { ...base, sessionIds: ["s3", "s4"], embedding: [1, 0] });
  expect(outcome).toBe("skipped");
  const { rows } = await harness.db.query("SELECT id FROM agent_scenarios", []);
  expect(rows).toHaveLength(1);
});

// Defect 2: without EMBEDDINGS_API_KEY (or a failed embed call this run)
// every embedding is null, so the old rule never merged anything and the
// table grew every run instead of converging.
it("dedups on embedding-less runs via exact normalized title, still respecting terminal state", async () => {
  const outcomeA = await upsertScenario(harness.db, {
    ...base,
    title: "Starts With Questions",
    sessionIds: ["s1", "s2"],
    embedding: null,
  });
  expect(outcomeA).toBe("inserted");
  const outcomeB = await upsertScenario(harness.db, {
    ...base,
    title: "  starts with questions ",
    sessionIds: ["s2", "s3"],
    embedding: null,
  });
  expect(outcomeB).toBe("merged");
  const { rows } = await harness.db.query("SELECT confirmations FROM agent_scenarios", []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ confirmations: 3 });

  await harness.db.query("UPDATE agent_scenarios SET state = 'rejected'", []);
  const outcomeC = await upsertScenario(harness.db, {
    ...base,
    title: "starts with questions",
    sessionIds: ["s4"],
    embedding: null,
  });
  expect(outcomeC).toBe("skipped");
  const { rows: after } = await harness.db.query("SELECT id FROM agent_scenarios", []);
  expect(after).toHaveLength(1);
});

// Defect 1: the merge branch only ever wrote session_ids/confirmations, never
// embedding. A row first inserted with embedding = NULL (no
// EMBEDDINGS_API_KEY, or a failed embed call that run) stayed NULL forever,
// even once embeddings became available again on later runs — so it could
// only ever be found again by exact title match, and any rephrase of the
// same pattern would insert a fresh row instead of merging into it.
it("backfills a missing embedding on merge, but never overwrites one already on file", async () => {
  // Inserted with no embedding (simulates a run with no EMBEDDINGS_API_KEY).
  const first = await upsertScenario(harness.db, {
    ...base,
    sessionIds: ["s1", "s2"],
    embedding: null,
  });
  expect(first).toBe("inserted");

  // A later run re-extracts the identical pattern, this time WITH an
  // embedding available. It must merge (exact title match) AND backfill.
  const second = await upsertScenario(harness.db, {
    ...base,
    sessionIds: ["s2", "s3"],
    embedding: [1, 0],
  });
  expect(second).toBe("merged");
  const { rows: afterBackfill } = await harness.db.query(
    "SELECT embedding, confirmations FROM agent_scenarios",
    [],
  );
  expect(afterBackfill).toHaveLength(1);
  expect(afterBackfill[0]).toMatchObject({ embedding: [1, 0], confirmations: 3 });

  // A third run carries a DIFFERENT embedding for the same title. The
  // already-stored vector must win — COALESCE only fills a NULL, it never
  // clobbers an existing one.
  const third = await upsertScenario(harness.db, {
    ...base,
    sessionIds: ["s4"],
    embedding: [0, 1],
  });
  expect(third).toBe("merged");
  const { rows: afterThird } = await harness.db.query("SELECT embedding FROM agent_scenarios", []);
  expect(afterThird[0]).toMatchObject({ embedding: [1, 0] });
});

it("matches the global bucket through IS NOT DISTINCT FROM, so a distilled global row is skipped rather than resurrected", async () => {
  const globalScenario = {
    scope: "global" as const,
    userId: null,
    kind: "error" as const,
    title: "hits a rate limit",
    recipe: "back off",
    embedding: [0, 1],
  };
  expect(await upsertScenario(harness.db, { ...globalScenario, sessionIds: ["s1", "s2"] })).toBe(
    "inserted",
  );
  // `user_id = NULL` is never true in SQL, so a bucket read written with `=`
  // instead of `IS NOT DISTINCT FROM` would find no duplicate here and
  // silently insert a second row on every analysis run.
  await harness.db.query("UPDATE agent_scenarios SET state = 'distilled'", []);
  expect(await upsertScenario(harness.db, { ...globalScenario, sessionIds: ["s3", "s4"] })).toBe(
    "skipped",
  );
  const { rows } = await harness.db.query("SELECT id FROM agent_scenarios", []);
  expect(rows).toHaveLength(1);
});
