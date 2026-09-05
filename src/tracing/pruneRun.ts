import { loadConfig } from "../config.js";
import { createPgPool } from "./traceStore.js";
import { pruneRawTraces } from "./pruneTraces.js";

// Manual one-shot prune: `npm run traces:prune`. The server prunes on its own
// (startTracePruneSchedule), so this exists for the times you want the space
// back right now — e.g. after lowering TRACE_RAW_TTL_DAYS.
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TRACE_DATABASE_URL) {
    console.error("[trace-prune] TRACE_DATABASE_URL is required");
    process.exit(1);
  }
  const pool = createPgPool(config.TRACE_DATABASE_URL, { max: 1 });
  try {
    const deleted = await pruneRawTraces(pool, config.TRACE_RAW_TTL_DAYS);
    console.log(
      `[trace-prune] deleted ${deleted} raw trace row(s) older than ${config.TRACE_RAW_TTL_DAYS} day(s)`,
    );
    // DELETE alone does not hand the space back to Postgres; on a table whose
    // bulk is TOASTed image payloads that difference is hundreds of megabytes.
    await pool.query("VACUUM (ANALYZE) raw_traces");
    console.log("[trace-prune] vacuumed raw_traces");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[trace-prune] failed:", err);
  process.exit(1);
});
