import { describe, expect, it } from "vitest";
import { CLAIM_TARGETS } from "../src/auth/claim.js";
import { createPgliteHarness } from "./pgliteShowcaseHelpers.js";

// Anon-claim coverage guard: a table keyed by the client-supplied anon id must
// be in CLAIM_TARGETS or the user loses that data when they sign in. Any table
// with a user_id / owner_id column must therefore be either claimed or listed
// here WITH the reason it is not.
const ALLOWLIST: Record<string, string> = {
  raw_traces: "TTL analytics (14 days) stay under the anon id by design; see CLAUDE.md known limits",
  session_summaries: "TTL analytics derived from raw_traces; stay under the anon id by design",
  ds_libraries: "owned by a Better Auth account id, never an anon id; nothing to claim",
  account: "Better Auth: userId is an account id",
  apikey: "Better Auth: owner reference is an account id",
  anon_claims: "the claim ledger itself: user_id is the destination account id",
  member: "Better Auth organization: account id",
  oauthAccessToken: "Better Auth: account id",
  oauthClient: "Better Auth: account id",
  oauthConsent: "Better Auth: account id",
  oauthRefreshToken: "Better Auth: account id",
  session: "Better Auth: account id",
};

describe("anon-claim coverage", () => {
  it("every user_id / owner_id table is claimed or allowlisted with a reason", async () => {
    const h = await createPgliteHarness([]);
    try {
      const { rows } = await h.pglite.query<{ table_name: string; column_name: string }>(
        `SELECT c.table_name, c.column_name FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND lower(c.column_name) IN ('user_id', 'owner_id', 'userid', 'ownerid')
          ORDER BY 1, 2`,
      );
      const claimed = new Set(CLAIM_TARGETS.map((t) => t.table));
      const unaccounted = rows
        .filter((r) => !claimed.has(r.table_name) && !(r.table_name in ALLOWLIST))
        .map((r) => `${r.table_name}.${r.column_name}`);
      expect(unaccounted, "add the table to CLAIM_TARGETS or to ALLOWLIST with a reason").toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("every CLAIM_TARGETS entry exists, and no allowlist entry is stale or unexplained", async () => {
    const h = await createPgliteHarness([]);
    try {
      const { rows } = await h.pglite.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      for (const t of CLAIM_TARGETS) expect(have.has(`${t.table}.${t.column}`), `${t.table}.${t.column}`).toBe(true);
      const tables = new Set(rows.map((r) => r.table_name));
      for (const [table, reason] of Object.entries(ALLOWLIST)) {
        expect(reason.length, table).toBeGreaterThan(10);
        expect(CLAIM_TARGETS.some((t) => t.table === table), `${table} is claimed AND allowlisted`).toBe(false);
        // raw_traces / session_summaries need pgvector migrations PGlite skips.
        if (!["raw_traces", "session_summaries"].includes(table)) expect(tables.has(table), `stale: ${table}`).toBe(true);
      }
    } finally {
      await h.close();
    }
  });
});
