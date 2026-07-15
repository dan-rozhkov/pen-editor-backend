import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createModel } from "../ai/provider.js";
import { createPgPool } from "../tracing/traceStore.js";
import { migrate } from "./migrate.js";
import { assembleSession, renderSessionText, type RawTraceDbRow } from "./assemble.js";
import { summarizeWithPiiGuard } from "./summarize.js";
import { createEmbedder } from "./embeddings.js";
import { clusterSummaries } from "./cluster.js";
import { renderReport } from "./report.js";
import { scrubPii } from "./pii.js";

// Must match migrations/001_init.sql's `embedding vector(768)` column and the
// text-embedding-004 model's output dimension (see embeddings.ts).
const EMBEDDING_DIMENSIONS = 768;

export function parseWindowDays(argv: string[]): number | null {
  const arg = argv.find((a) => a.startsWith("--window-days="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface TallyRow {
  outcome: string;
  tool_errors: Array<{ tool: string; error: string }>;
}

export function tally(rows: TallyRow[]): {
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
} {
  const outcomes: Record<string, number> = {};
  const errCounts = new Map<string, { tool: string; error: string; count: number }>();
  for (const row of rows) {
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    for (const e of row.tool_errors) {
      const key = `${e.tool}:${e.error}`;
      const entry = errCounts.get(key) ?? { tool: e.tool, error: e.error, count: 0 };
      entry.count += 1;
      errCounts.set(key, entry);
    }
  }
  return {
    outcomes,
    toolErrors: [...errCounts.values()].sort((a, b) => b.count - a.count),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TRACE_DATABASE_URL) {
    console.error("[analyze] TRACE_DATABASE_URL is required");
    process.exit(1);
  }
  const windowDays = parseWindowDays(process.argv);
  const pool = createPgPool(config.TRACE_DATABASE_URL);
  try {
    // migrate() issues BEGIN/COMMIT via client.query — those must run on one
    // pinned connection, not a raw Pool (which round-robins across clients).
    const migrationClient = await pool.connect();
    let applied: string[];
    try {
      applied = await migrate(migrationClient);
    } finally {
      migrationClient.release();
    }
    if (applied.length) console.log(`[analyze] applied migrations: ${applied.join(", ")}`);
    const model = createModel(config, config.ANALYSIS_MODEL);
    const embedder = createEmbedder(config);

    // 1. Summarize completed, not-yet-summarized sessions (quiet for 30+ min).
    const { rows: pending } = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM raw_traces rt
       WHERE NOT EXISTS (
         SELECT 1 FROM session_summaries ss WHERE ss.session_id = rt.session_id
       )
       GROUP BY session_id
       HAVING max(created_at) < now() - interval '30 minutes'
       ORDER BY 1`,
    );
    console.log(`[analyze] ${pending.length} session(s) to summarize`);
    let failedSessions = 0;
    for (const { session_id } of pending) {
      try {
        const { rows } = await pool.query<RawTraceDbRow>(
          "SELECT * FROM raw_traces WHERE session_id = $1 ORDER BY created_at",
          [session_id],
        );
        const session = assembleSession(rows);
        const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
          model,
          renderSessionText(session),
        );
        let embedding: string | null = null;
        if (embedder && piiCheckPassed) {
          try {
            const values = await embedder.embed(summary.summary);
            if (values.length !== EMBEDDING_DIMENSIONS) {
              console.warn(
                `[analyze] embedding for ${session_id} has ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}; storing without embedding`,
              );
            } else {
              embedding = `[${values.join(",")}]`;
            }
          } catch (err) {
            console.warn(`[analyze] embedding failed for ${session_id}:`, err);
          }
        }
        await pool.query(
          `INSERT INTO session_summaries
             (session_id, user_goal, summary, outcome, tool_errors, frustration,
              model, agent_mode, step_count, embedding, pii_check_passed)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::vector,$11)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            session_id,
            summary.user_goal,
            summary.summary,
            summary.outcome,
            JSON.stringify(summary.tool_errors),
            summary.frustration,
            session.model,
            session.agentMode,
            session.stepCount,
            embedding,
            piiCheckPassed,
          ],
        );
        console.log(`[analyze] summarized ${session_id}: ${summary.outcome}`);
      } catch (err) {
        failedSessions += 1;
        console.error(`[analyze] session ${session_id} failed:`, err);
        continue;
      }
    }
    if (failedSessions > 0) {
      console.log(`[analyze] ${failedSessions} session(s) failed to summarize`);
    }

    // 2. Cluster the window and write a report.
    const { rows: summaries } = await pool.query<{
      id: number;
      summary: string;
      outcome: string;
      tool_errors: Array<{ tool: string; error: string }>;
    }>(
      // Gotcha: `$1::int IS NULL OR created_at > now() - ($1 || ' days')::interval`
      // fails at PREPARE time (Postgres 42883) on every run — the explicit
      // ::int cast fixes $1's type to int4, and Postgres then has no `||`
      // operator for (integer, unknown). make_interval(days => ...) takes a
      // plain int param and sidesteps the string-concat interval cast entirely.
      `SELECT id, summary, outcome, tool_errors FROM session_summaries
       WHERE pii_check_passed
         AND ($1::int IS NULL OR created_at > now() - make_interval(days => $1::int))
       ORDER BY id`,
      [windowDays],
    );
    if (summaries.length === 0) {
      console.log("[analyze] no summaries in window; skipping clustering");
    } else {
      // The clustering LLM's name/description are free text derived from
      // summaries; scrub PII before anything touches permanent storage or
      // the report (raw_traces is the only table allowed to hold raw content).
      const rawClusters = await clusterSummaries(
        model,
        summaries.map((s) => ({ id: s.id, summary: s.summary })),
      );
      const clusters = rawClusters.map((c) => ({
        ...c,
        name: scrubPii(c.name),
        description: scrubPii(c.description),
      }));
      const { rows: prevClusters } = await pool.query<{ name: string; size: number }>(
        `SELECT name, size FROM clusters
         WHERE run_id = (SELECT max(id) FROM analysis_runs)`,
      );
      const byId = new Map(summaries.map((s) => [s.id, s]));
      const date = new Date().toISOString().slice(0, 10);
      const reportMd = renderReport({
        date,
        windowDays,
        summaryCount: summaries.length,
        clusters: clusters.map((c) => ({
          name: c.name,
          description: c.description,
          size: c.summaryIds.length,
          examples: c.summaryIds.slice(0, 5).map((id) => byId.get(id)!.summary),
        })),
        previousClusters: prevClusters,
        ...tally(summaries),
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const runRes = await client.query<{ id: number }>(
          `INSERT INTO analysis_runs (window_days, summary_count, model, report_md)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [windowDays, summaries.length, config.ANALYSIS_MODEL, reportMd],
        );
        const runId = runRes.rows[0].id;
        for (const c of clusters) {
          const clusterRes = await client.query<{ id: number }>(
            `INSERT INTO clusters (run_id, name, description, size)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [runId, c.name, c.description, c.summaryIds.length],
          );
          for (const summaryId of c.summaryIds) {
            await client.query(
              "INSERT INTO summary_clusters (cluster_id, summary_id) VALUES ($1,$2)",
              [clusterRes.rows[0].id, summaryId],
            );
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await mkdir("reports", { recursive: true });
      const reportPath = join("reports", `${date}.md`);
      await writeFile(reportPath, reportMd);
      console.log(`[analyze] report written to ${reportPath} (${clusters.length} clusters)`);
    }

    // 3. TTL cleanup of raw traces.
    const del = await pool.query(
      `DELETE FROM raw_traces WHERE created_at < now() - make_interval(days => $1::int)`,
      [config.TRACE_RAW_TTL_DAYS],
    );
    console.log(`[analyze] deleted ${del.rowCount ?? 0} expired raw trace row(s)`);
  } finally {
    await pool.end();
  }
}

// Only run as a script, not on import (tests import the pure helpers).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err) => {
    console.error("[analyze] failed:", err);
    process.exit(1);
  });
}
