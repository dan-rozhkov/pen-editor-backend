import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness([
    "agent_memory",
    "agent_review_state",
    "agent_selfimprove_audit",
  ]);
});

afterAll(async () => {
  await harness.close();
});

describe("009_agent_memory.sql", () => {
  it("creates the three phase-1 tables with their defaults", async () => {
    await harness.pool.query(
      "INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)",
      ["u1", "memory"],
    );
    const memory = (await harness.pool.query(
      "SELECT entries, updated_at FROM agent_memory WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ entries: unknown; updated_at: unknown }> };
    expect(memory.rows[0].entries).toEqual([]);
    expect(memory.rows[0].updated_at).toBeTruthy();

    await harness.pool.query(
      "INSERT INTO agent_review_state (user_id) VALUES ($1)",
      ["u1"],
    );
    const state = (await harness.pool.query(
      "SELECT turns_since_memory, steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ turns_since_memory: number; steps_since_skill: number }> };
    expect(state.rows[0].turns_since_memory).toBe(0);
    expect(state.rows[0].steps_since_skill).toBe(0);

    await harness.pool.query(
      `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      ["u1", "foreground", "memory", "add", JSON.stringify({ n: 1 })],
    );
    const audit = (await harness.pool.query(
      "SELECT id, payload FROM agent_selfimprove_audit WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ id: string; payload: unknown }> };
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload).toEqual({ n: 1 });
  });

  it("rejects a target outside ('memory','user')", async () => {
    await expect(
      harness.pool.query(
        "INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)",
        ["u2", "skills"],
      ),
    ).rejects.toThrow();
  });

  // agent_skills now ships in migration 011 (see agent-skills-migration.test.ts) —
  // this suite only asserts phase-1's own three tables, so no assertion about
  // agent_skills belongs here anymore.
});
