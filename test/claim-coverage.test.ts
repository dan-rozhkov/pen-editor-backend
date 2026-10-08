import { describe, expect, it } from "vitest";
import { CLAIM_TARGETS } from "../src/auth/claim.js";
import { createPgliteHarness } from "./pgliteShowcaseHelpers.js";

// Anon-claim coverage guard: a table keyed by the client-supplied anon id must
// be in CLAIM_TARGETS or the user loses that data when they sign in. Any table
// with an identity-looking column (matched below, snake or camel case) must
// therefore be either claimed or listed here WITH the column and the reason.
const IDENTITY_COLUMNS = ["userid", "ownerid", "authorid", "createdby", "anonid", "actorid"];

const ALLOWLIST: Record<string, { columns: string[]; reason: string }> = {
  raw_traces: { columns: ["user_id"], reason: "TTL analytics (14 days) stay under the anon id by design; see CLAUDE.md known limits" },
  session_summaries: { columns: ["user_id"], reason: "TTL analytics derived from raw_traces; stay under the anon id by design" },
  ds_libraries: { columns: ["owner_id"], reason: "owned by a Better Auth account id, never an anon id; nothing to claim" },
  agent_skills: { columns: ["created_by"], reason: "agent-authored, global skill library; created_by is provenance, not an owner" },
  anon_claims: { columns: ["anon_id", "user_id"], reason: "the claim ledger itself: anon_id is the source, user_id the destination account" },
  account: { columns: ["userId"], reason: "Better Auth: account id" },
  member: { columns: ["userId"], reason: "Better Auth organization: account id" },
  oauthAccessToken: { columns: ["userId"], reason: "Better Auth: account id" },
  oauthClient: { columns: ["userId"], reason: "Better Auth: account id" },
  oauthConsent: { columns: ["userId"], reason: "Better Auth: account id" },
  oauthRefreshToken: { columns: ["userId"], reason: "Better Auth: account id" },
  session: { columns: ["userId"], reason: "Better Auth: account id" },
};

// raw_traces / session_summaries come from migrations PGlite skips (pgvector).
const NOT_ON_PGLITE = new Set(["raw_traces", "session_summaries"]);

async function allColumns() {
  const h = await createPgliteHarness([]);
  try {
    const { rows } = await h.pglite.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
    );
    return rows;
  } finally {
    await h.close();
  }
}

describe("anon-claim coverage", () => {
  it("every identity column is on a claimed table or allowlisted with a reason", async () => {
    const claimed = new Set(CLAIM_TARGETS.map((t) => `${t.table}.${t.column}`));
    const unaccounted = (await allColumns())
      .filter((r) => IDENTITY_COLUMNS.includes(r.column_name.replace(/_/g, "").toLowerCase()))
      .filter((r) => !claimed.has(`${r.table_name}.${r.column_name}`) && !ALLOWLIST[r.table_name]?.columns.includes(r.column_name))
      .map((r) => `${r.table_name}.${r.column_name}`);
    expect(unaccounted, "add the table to CLAIM_TARGETS or to ALLOWLIST with a reason").toEqual([]);
  });

  it("no dead entries: claimed and allowlisted columns exist, with a reason, never both", async () => {
    const have = new Set((await allColumns()).map((r) => `${r.table_name}.${r.column_name}`));
    for (const t of CLAIM_TARGETS) expect(have.has(`${t.table}.${t.column}`), `${t.table}.${t.column}`).toBe(true);
    for (const [table, { columns, reason }] of Object.entries(ALLOWLIST)) {
      expect(reason.length, table).toBeGreaterThan(10);
      for (const column of columns) {
        if (!NOT_ON_PGLITE.has(table)) expect(have.has(`${table}.${column}`), `dead allowlist entry ${table}.${column}`).toBe(true);
        expect(CLAIM_TARGETS.some((t) => t.table === table && t.column === column), `${table}.${column} is claimed AND allowlisted`).toBe(false);
      }
    }
  });
});
