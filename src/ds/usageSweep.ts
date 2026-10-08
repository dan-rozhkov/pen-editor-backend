// Retention for ds_usage (migration 021): reports older than 90 days are
// deleted for ALL libraries, at startup and once a day, the same pattern as
// the raw_traces prune (src/tracing/pruneTraces.ts). The per-write prune in
// the store is a small opportunistic extra; this is what bounds the table.
import type { Config } from "../config.js";
import { createPgPool, type TraceQueryable } from "../tracing/traceStore.js";
import { PRUNE_INTERVAL_MS } from "../tracing/pruneTraces.js";
import { USAGE_RETENTION_DAYS } from "./usage.js";

/** Deletes expired reports in bounded batches. Returns how many rows went. */
export async function pruneDsUsage(db: TraceQueryable, days = USAGE_RETENTION_DAYS, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const r = (await db.query(
      `WITH d AS (DELETE FROM ds_usage WHERE ctid IN (
         SELECT ctid FROM ds_usage WHERE reported_at < now() - make_interval(days => $1::int) LIMIT $2) RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
      [days, batch],
    )) as { rows: Array<{ n: number }> };
    const n = r.rows[0]?.n ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

export interface DsUsageSweepDeps {
  createPool: (connectionString: string) => TraceQueryable;
  setInterval: typeof setInterval;
}

const defaultDeps: DsUsageSweepDeps = {
  createPool: (connectionString) => createPgPool(connectionString, { max: 1 }),
  setInterval,
};

/** Runs one sweep now and then daily. A failing sweep is logged and retried on the next tick. Returns a stop function. */
export function startDsUsageSweep(config: Config, deps: DsUsageSweepDeps = defaultDeps): () => Promise<void> {
  if (!config.TRACE_DATABASE_URL) return async () => {};
  const db = deps.createPool(config.TRACE_DATABASE_URL);
  const runOnce = async () => {
    try {
      const deleted = await pruneDsUsage(db);
      if (deleted > 0) console.log(`[ds-usage-prune] deleted ${deleted} usage report(s) older than ${USAGE_RETENTION_DAYS} day(s)`);
    } catch (err) {
      console.error("[ds-usage-prune] prune failed, will retry on the next tick:", err);
    }
  };
  void runOnce();
  const timer = deps.setInterval(() => void runOnce(), PRUNE_INTERVAL_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await db.end();
  };
}
