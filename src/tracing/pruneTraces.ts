import type { Config } from "../config.js";
import { createPgPool, type TraceQueryable } from "./traceStore.js";

// `raw_traces` has always declared a TTL (TRACE_RAW_TTL_DAYS, 14 days), but
// the only code that ever enforced it lived at the tail of the trace-analysis
// job (`npm run analyze`) — and that job was never scheduled anywhere. The
// result, found in 2026-09: 25 days of traces on a 512 MB Neon database,
// 626 expired rows holding 314 MB. Retention that depends on someone
// remembering to run a CLI is not retention, so the deletion now lives in its
// own module with two triggers that need no external scheduler: the server
// prunes at startup and once a day while it runs (see index.ts). The analysis
// job still calls the same function, so there is exactly one copy of the SQL.
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Deletes raw traces older than the TTL. Returns how many rows went. */
export async function pruneRawTraces(
  db: TraceQueryable,
  ttlDays: number,
): Promise<number> {
  const result = (await db.query(
    `DELETE FROM raw_traces WHERE created_at < now() - make_interval(days => $1::int)`,
    [ttlDays],
  )) as { rowCount?: number | null };
  return result.rowCount ?? 0;
}

export interface TracePruneScheduleDeps {
  createPool: (connectionString: string) => TraceQueryable;
  setInterval: typeof setInterval;
}

const defaultDeps: TracePruneScheduleDeps = {
  createPool: (connectionString) => createPgPool(connectionString, { max: 1 }),
  setInterval,
};

/**
 * Starts the periodic prune and runs one pass immediately. Returns a stop
 * function; a no-op when Postgres is not configured.
 *
 * Like startup migrations, this must never take the server down: a failing
 * prune is logged and the next tick tries again. The pool is deliberately
 * tiny (max: 1) — one DELETE a day does not need a connection pool, and Neon
 * charges for idle connections in compute time.
 */
export function startTracePruneSchedule(
  config: Config,
  deps: TracePruneScheduleDeps = defaultDeps,
): () => Promise<void> {
  if (!config.TRACE_DATABASE_URL) return async () => {};

  const db = deps.createPool(config.TRACE_DATABASE_URL);
  const runOnce = async () => {
    try {
      const deleted = await pruneRawTraces(db, config.TRACE_RAW_TTL_DAYS);
      if (deleted > 0) {
        console.log(
          `[trace-prune] deleted ${deleted} raw trace row(s) older than ${config.TRACE_RAW_TTL_DAYS} day(s)`,
        );
      }
    } catch (err) {
      console.error("[trace-prune] prune failed — will retry on the next tick:", err);
    }
  };

  void runOnce();
  const timer = deps.setInterval(() => void runOnce(), PRUNE_INTERVAL_MS);
  // The prune must not be the reason the process stays alive on shutdown.
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    await db.end();
  };
}
