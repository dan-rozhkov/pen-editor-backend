// Retention for ds_usage (migration 021): reports older than 90 days are
// deleted for ALL libraries. It rides the existing daily prune schedule
// (startTracePruneSchedule in src/tracing/pruneTraces.ts, one pool, startup +
// daily) as an extra job passed from index.ts. The per-write prune in the
// store is a small opportunistic extra; this is what bounds the table.
import type { PruneJob } from "../tracing/pruneTraces.js";
import type { TraceQueryable } from "../tracing/traceStore.js";
import { USAGE_RETENTION_DAYS } from "./usage.js";

/** Deletes expired reports in bounded, index-ordered batches (ds_usage_reported_idx). Returns how many rows went. */
export async function pruneDsUsage(db: TraceQueryable, days = USAGE_RETENTION_DAYS, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = (await db.query(
      `WITH d AS (DELETE FROM ds_usage WHERE ctid = ANY(ARRAY(
         SELECT ctid FROM ds_usage WHERE reported_at < now() - make_interval(days => $1::int) ORDER BY reported_at LIMIT $2)) RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [days, batch],
    )) as { rows: Array<{ n: number }> };
    const n = r.rows[0]?.n ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

export const dsUsagePruneJob: PruneJob = {
  name: "ds-usage-prune",
  run: (db) => pruneDsUsage(db),
  describe: (n) => `deleted ${n} usage report(s) older than ${USAGE_RETENTION_DAYS} day(s)`,
};
