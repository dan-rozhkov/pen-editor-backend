import {
  confirmationsOf,
  findDuplicate,
  mergeSessionIds,
  type ExistingScenario,
  type ScenarioKind,
  type ScenarioState,
} from "./scenarios.js";

export interface ScenarioStoreClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface UpsertScenarioInput {
  scope: "user" | "global";
  userId: string | null;
  kind: ScenarioKind;
  title: string;
  recipe: string;
  sessionIds: string[];
  embedding: number[] | null;
}

/** Every row in a scope+user bucket, REGARDLESS of state. This is what
 * upsertScenario dedups against: a pattern already 'distilled' into memory
 * or 'rejected' twice must still be recognized as the nearest duplicate, so
 * the next analysis run (which re-reads the same session_insights history
 * and re-extracts the same pattern) can be told "skipped" instead of
 * silently re-inserting it as a fresh 'open' row: without this, a scenario
 * the user declined twice would come back on the very next analysis run. */
async function loadScenarioBucket(
  db: ScenarioStoreClient,
  scope: "user" | "global",
  userId: string | null,
): Promise<ExistingScenario[]> {
  const { rows } = await db.query(
    `SELECT id, title, embedding, session_ids, state FROM agent_scenarios
      WHERE scope = $1 AND user_id IS NOT DISTINCT FROM $2`,
    [scope, userId],
  );
  return mapScenarioRows(rows);
}

function mapScenarioRows(rows: unknown[]): ExistingScenario[] {
  return (
    rows as Array<{
      id: number | string;
      title: string;
      embedding: number[] | null;
      session_ids: string[];
      state: ScenarioState;
    }>
  ).map((r) => ({
    id: Number(r.id),
    title: r.title,
    embedding: r.embedding,
    session_ids: r.session_ids,
    state: r.state,
  }));
}

/** Inserts a fresh scenario, merges into the nearest LIVE duplicate (same
 * scope+user bucket, title match under the threshold — embedding cosine
 * distance, or an exact normalized title when an embedding is missing on
 * either side, see findDuplicate), or — when the nearest duplicate is
 * 'distilled'/'rejected' — skips entirely rather than reviving a decision
 * the loop already made. A merge unions session_ids and recomputes
 * confirmations from the union — never adds the incoming count, which would
 * double-count a session already on file. */
export async function upsertScenario(
  db: ScenarioStoreClient,
  input: UpsertScenarioInput,
): Promise<"inserted" | "merged" | "skipped"> {
  const bucket = await loadScenarioBucket(db, input.scope, input.userId);
  const duplicate = findDuplicate(input.title, input.embedding, bucket);
  if (duplicate) {
    if (duplicate.state === "distilled" || duplicate.state === "rejected") {
      return "skipped";
    }
    const sessionIds = mergeSessionIds(duplicate.session_ids, input.sessionIds);
    // COALESCE(embedding, ...): a row that was inserted without an embedding
    // (no EMBEDDINGS_API_KEY, or a failed embed call that run) would
    // otherwise stay NULL forever — every later merge only ever touched
    // session_ids/confirmations, never embedding. Once embeddings ARE
    // available again, findDuplicate could only ever find that row by exact
    // title match, so any rephrasing of the same pattern would insert a new
    // row instead of merging: the unbounded growth the title fallback exists
    // to prevent, just deferred. Backfill it opportunistically from whichever
    // incoming call happens to carry one, but never overwrite a vector
    // that's already on file with a possibly-null incoming one.
    await db.query(
      `UPDATE agent_scenarios
          SET session_ids = $2, confirmations = $3, last_seen_at = now(),
              embedding = COALESCE(embedding, $4::jsonb)
        WHERE id = $1`,
      [
        duplicate.id,
        sessionIds,
        confirmationsOf(sessionIds),
        input.embedding ? JSON.stringify(input.embedding) : null,
      ],
    );
    return "merged";
  }
  const sessionIds = [...new Set(input.sessionIds)];
  await db.query(
    `INSERT INTO agent_scenarios
       (scope, user_id, kind, title, recipe, confirmations, session_ids, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.scope,
      input.userId,
      input.kind,
      input.title,
      input.recipe,
      confirmationsOf(sessionIds),
      sessionIds,
      input.embedding ? JSON.stringify(input.embedding) : null,
    ],
  );
  return "inserted";
}
