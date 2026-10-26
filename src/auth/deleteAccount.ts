import { CLAIM_TARGETS, type ClaimPool } from "./claim.js";

// Hard-deletes everything keyed by one Better Auth account, in ONE transaction.
//
// App tables: every CLAIM_TARGETS table (so a table added there is deleted
// too), by the account id and every claimed anon id plus `anon_claims` (the anon-id -> account link). The analytics rows
// claim deliberately leaves alone (`raw_traces`, `session_summaries`,
// migration 013) are deleted AFTER the commit, best-effort, by the returned
// `cleanupTraces` the route starts in the background: raw_traces has no
// user_id index and is huge, so a scan must sit neither inside the account
// transaction nor inside the HTTP request. They go by the account id AND every anon id it claimed
// (collected in the transaction, before anon_claims is deleted).
// Left alone on purpose: `agent_skills` (global), `showcase_app_likes`
// (per-app, no user key), `audit_log` / ds_* (dropped by migration 022).
// Not covered: S3 objects (uploads, showcase images, shared-canvas assets).
//
// Auth tables: `apikey` and `verification` have no FK to "user", so they are
// deleted by hand; "user" last, whose ON DELETE CASCADE removes session,
// account, oauthClient, oauthConsent, oauthRefreshToken, oauthAccessToken
// (and `member` when the organization tables still exist).

const EXTRA_USER_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: "anon_claims", column: "user_id" },
];

const TRACE_TABLES = ["raw_traces", "session_summaries"] as const;

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }> };

// A deployment may lack a table (never migrated, or dropped since); that must
// not fail the deletion. to_regclass answers without raising, so a
// transaction is never aborted by a 42P01.
async function deleteFrom(
  client: Queryable,
  table: string,
  where: string,
  params: unknown[],
  deleted: Record<string, number>,
): Promise<void> {
  const exists = await client.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${JSON.stringify(table)}`]);
  if (!(exists.rows[0] as { ok: boolean } | undefined)?.ok) return;
  const res = await client.query(`DELETE FROM "${table}" WHERE ${where}`, params);
  deleted[table] = res.rowCount ?? 0;
}

// Which verification rows belong to this account. Exact matches only: the
// address is the identifier (email verification / reset), or sits in a JSON
// `value` as the field `email` (Better Auth magic-link: {type, email, name})
// or the id as `userId` (our desktop-ott: {userId, challenge}). A substring
// match would also hit `ba@x.com` for `a@x.com`. The SQL strpos is only a
// cheap prefilter; the decision is made on the parsed value.
async function verificationIdsOf(client: Queryable, user: { id: string; email: string }): Promise<string[]> {
  const res = await client.query(
    `SELECT "id", "identifier", "value" FROM "verification"
     WHERE lower("identifier") = lower($2) OR strpos("value", $1) > 0 OR strpos(lower("value"), lower($2)) > 0`,
    [user.id, user.email],
  );
  const email = user.email.toLowerCase();
  const ids: string[] = [];
  for (const row of res.rows as Array<{ id: string; identifier: string; value: string }>) {
    let hit = row.identifier.toLowerCase() === email;
    if (!hit) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          hit =
            (typeof rec.email === "string" && rec.email.toLowerCase() === email) || rec.userId === user.id;
        }
      } catch {
        // Not JSON (e.g. a bare token): not ours by value.
      }
    }
    if (hit) ids.push(row.id);
  }
  return ids;
}

async function deleteTraces(pool: ClaimPool, ownerIds: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    const sink: Record<string, number> = {};
    for (const table of TRACE_TABLES) {
      try {
        await deleteFrom(client, table, `"user_id" = ANY($1::text[])`, [ownerIds], sink);
      } catch (err) {
        console.error(`[account-delete] best-effort delete from ${table} failed:`, err);
      }
    }
  } finally {
    client.release();
  }
}

export interface DeleteAccountResult {
  counts: Record<string, number>;
  /**
   * Best-effort trace cleanup (raw_traces, session_summaries). NOT run by
   * deleteAccount: the caller starts it after responding, never awaiting it
   * inside the request. Never rejects; failures are logged.
   */
  cleanupTraces: () => Promise<void>;
}

export async function deleteAccount(
  pool: ClaimPool,
  user: { id: string; email: string },
): Promise<DeleteAccountResult> {
  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  const ownerIds = [user.id];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const claimed = await client.query("SELECT anon_id FROM anon_claims WHERE user_id = $1", [user.id]);
    for (const row of (claimed.rows as Array<{ anon_id: string }>)) ownerIds.push(row.anon_id);
    // App tables go by the account id AND every claimed anon id: a user who
    // signed out and kept using the same browser wrote new rows under the
    // anon id after the claim.
    for (const { table, column } of CLAIM_TARGETS) {
      await deleteFrom(client, table, `"${column}" = ANY($1::text[])`, [ownerIds], deleted);
    }
    for (const { table, column } of EXTRA_USER_TABLES) {
      await deleteFrom(client, table, `"${column}" = $1`, [user.id], deleted);
    }
    await deleteFrom(client, "apikey", `"referenceId" = $1`, [user.id], deleted);
    const verificationIds = await verificationIdsOf(client, user);
    if (verificationIds.length > 0) {
      await deleteFrom(client, "verification", `"id" = ANY($1::text[])`, [verificationIds], deleted);
    }
    await deleteFrom(client, "user", `"id" = $1`, [user.id], deleted);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The transaction is already dead; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
  const cleanupTraces = async (): Promise<void> => {
    try {
      await deleteTraces(pool, ownerIds);
    } catch (err) {
      console.error("[account-delete] best-effort trace cleanup failed:", err);
    }
  };
  return { counts: deleted, cleanupTraces };
}
