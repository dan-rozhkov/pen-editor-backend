import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness([]);
});
afterAll(async () => {
  await harness.close();
});

describe("014_agent_scenarios", () => {
  it("accepts a user-scoped row and rejects a scope/user_id mismatch", async () => {
    await harness.db.query(
      `INSERT INTO agent_scenarios (scope, user_id, kind, title, recipe, session_ids, embedding)
       VALUES ('user', 'u1', 'correction', 't', 'r', ARRAY['s1'], '[0.1,0.2]'::jsonb)`,
      [],
    );
    await expect(
      harness.db.query(
        `INSERT INTO agent_scenarios (scope, user_id, kind, title, recipe, session_ids)
         VALUES ('user', NULL, 'correction', 't', 'r', ARRAY['s1'])`,
        [],
      ),
    ).rejects.toThrow();
  });

  it("defaults a fresh row to open with one confirmation and no offers", async () => {
    const { rows } = await harness.db.query(
      `INSERT INTO agent_scenarios (scope, kind, title, recipe, session_ids)
       VALUES ('global', 'workflow', 't2', 'r2', ARRAY['s2'])
       RETURNING state, confirmations, offer_count`,
      [],
    );
    expect(rows[0]).toMatchObject({ state: "open", confirmations: 1, offer_count: 0 });
  });
});
