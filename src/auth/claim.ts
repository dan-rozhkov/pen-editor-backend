// Moves everything an anonymous browser (`pen.userId`) accumulated onto the
// account that signed in on it. Table list verified against the migrations:
// every table whose key is the client-generated id. `agent_skills` and
// `showcase_app_likes` have no user key at all (global / per-app), and
// `raw_traces`/`session_summaries` stay anonymous on purpose — analytics
// rows that expire by TTL, not user data.
interface ClaimTarget {
  table: string;
  column: string;
  /**
   * Other columns of a UNIQUE/PRIMARY key that includes `column` ([] = the key
   * is `column` alone), or null when no unique key involves it.
   */
  uniqueWith: string[] | null;
}

export const CLAIM_TARGETS: readonly ClaimTarget[] = [
  { table: "agent_memory", column: "user_id", uniqueWith: ["target"] },
  { table: "agent_review_state", column: "user_id", uniqueWith: [] },
  { table: "agent_selfimprove_audit", column: "user_id", uniqueWith: null },
  { table: "agent_scenarios", column: "user_id", uniqueWith: null },
  { table: "user_skills", column: "user_id", uniqueWith: ["name"] },
  { table: "shared_canvases", column: "owner_id", uniqueWith: null },
];

export interface ClaimClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(): void;
}

export interface ClaimPool {
  connect(): Promise<ClaimClient>;
}

export type ClaimResult =
  | { claimed: true; moved: Record<string, number> }
  | { claimed: false; reason: "already_claimed" | "conflict" };

// One transaction: the anon_claims insert is the lock. Its PRIMARY KEY makes a
// claim one-shot, so a replay (or a second account trying the same anon id)
// rolls back and reports `already_claimed` without touching any data.
export async function claimAnonData(
  pool: ClaimPool,
  userId: string,
  anonId: string,
): Promise<ClaimResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializes concurrent claims for ONE account (two tabs, two anon ids):
    // the per-table merge below is delete-then-update and races otherwise.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const insert = await client.query(
      "INSERT INTO anon_claims (anon_id, user_id) VALUES ($1, $2) ON CONFLICT (anon_id) DO NOTHING RETURNING anon_id",
      [anonId, userId],
    );
    if (insert.rows.length === 0) {
      await client.query("ROLLBACK");
      return { claimed: false, reason: "already_claimed" };
    }
    const moved: Record<string, number> = {};
    for (const { table, column, uniqueWith } of CLAIM_TARGETS) {
      if (uniqueWith) {
        // The account's own row wins: delete the anon copy that would
        // collide on the key, so the UPDATE below cannot violate it.
        const sameKey = [`mine.${column} = $2`, ...uniqueWith.map((c) => `mine.${c} = anon.${c}`)].join(" AND ");
        await client.query(
          `DELETE FROM ${table} anon WHERE anon.${column} = $1 AND EXISTS (SELECT 1 FROM ${table} mine WHERE ${sameKey})`,
          [anonId, userId],
        );
      }
      const update = await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [anonId, userId]);
      moved[table] = update.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { claimed: true, moved };
  } catch (err) {
    await client.query("ROLLBACK");
    // A unique violation that still slips through (a key the merge does not
    // model) is a conflict the caller can see, not a 500; nothing was moved.
    if ((err as { code?: string } | null)?.code === "23505") return { claimed: false, reason: "conflict" };
    throw err;
  } finally {
    client.release();
  }
}
