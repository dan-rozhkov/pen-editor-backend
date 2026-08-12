import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_skills"]);
});

afterAll(async () => {
  await harness.close();
});

describe("011_agent_skills.sql", () => {
  it("creates agent_skills with the locked column defaults", async () => {
    await harness.pool.query(
      "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
      ["reading-canvas-state", "How to read the canvas before editing", "# Body\n", "agent"],
    );
    const result = (await harness.pool.query(
      "SELECT name, state, use_count, view_count, last_used_at FROM agent_skills WHERE name = $1",
      ["reading-canvas-state"],
    )) as {
      rows: Array<{
        name: string;
        state: string;
        use_count: number;
        view_count: number;
        last_used_at: unknown;
      }>;
    };
    expect(result.rows[0]).toMatchObject({
      name: "reading-canvas-state",
      state: "active",
      use_count: 0,
      view_count: 0,
      last_used_at: null,
    });
  });

  it("enforces name as the primary key", async () => {
    await harness.pool.query(
      "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
      ["dup-name", "d", "b", "agent"],
    );
    await expect(
      harness.pool.query(
        "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
        ["dup-name", "d2", "b2", "agent"],
      ),
    ).rejects.toThrow();
  });

  it("requires description, body, and created_by (NOT NULL)", async () => {
    await expect(
      harness.pool.query(
        "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
        ["missing-body", "d", null, "agent"],
      ),
    ).rejects.toThrow();
  });

  it("has the state+name and state+last_used_at indexes", async () => {
    const res = (await harness.pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'agent_skills'`,
      [],
    )) as { rows: Array<{ indexname: string }> };
    const names = res.rows.map((r) => r.indexname);
    expect(names).toContain("agent_skills_state_name_idx");
    expect(names).toContain("agent_skills_state_last_used_idx");
  });
});
