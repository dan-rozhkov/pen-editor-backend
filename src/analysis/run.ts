import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { loadConfig } from "../config.js";
import { createModel } from "../ai/provider.js";
import { createPgPool } from "../tracing/traceStore.js";
import { migrate } from "./migrate.js";
import { assembleSession, renderSessionText, type RawTraceDbRow } from "./assemble.js";
import { summarizeWithPiiGuard } from "./summarize.js";
import { createEmbedder } from "./embeddings.js";
import { clusterSummaries } from "./cluster.js";
import { renderReport, type ReportInsights } from "./report.js";
import { scrubPii } from "./pii.js";
import { extractInsights, type SessionInsights } from "./insights.js";
import { bucketAtoms, extractScenarios, type InsightRowForScenarios } from "./scenarios.js";
import { upsertScenario } from "./scenarioStore.js";

// Must match migrations/001_init.sql's `embedding vector(768)` column and the
// text-embedding-004 model's output dimension (see embeddings.ts).
const EMBEDDING_DIMENSIONS = 768;

// One LLM call per bucket: bound a single run's cost on a deployment with
// many users. Skipped buckets are logged, never silently dropped.
// KNOWN LIMITATION: there is no rotation across runs. bucketAtoms places the
// global bucket first specifically so it always survives this cap; but
// per-user buckets past index MAX_SCENARIO_BUCKETS_PER_RUN are decided by
// Map insertion order, not by priority or recency, and a bucket that lands
// there is skipped on EVERY run, not just this one. Fine for today's
// de-facto single-user deployment; a real fix needs actual rotation
// (e.g. round-robin by userId across runs) once this stops being true.
const MAX_SCENARIO_BUCKETS_PER_RUN = 20;

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

export interface InsightRow {
  errors: Array<{ tool: string; error: string; recovered: boolean }>;
  corrections: Array<{
    what_agent_did: string;
    what_user_wanted: string;
    agent_complied: boolean;
  }>;
  memory_requests: Array<{ quote: string; honored: boolean }>;
}

// The report lists what the agent got WRONG — a complied-with correction needs no
// action, an ignored one is a prompt bug.
export function tallyInsights(rows: InsightRow[]): ReportInsights {
  return {
    corrections: rows.reduce((n, r) => n + r.corrections.length, 0),
    correctionsNotComplied: rows.flatMap((r) =>
      r.corrections
        .filter((c) => !c.agent_complied)
        .map((c) => ({
          what_agent_did: c.what_agent_did,
          what_user_wanted: c.what_user_wanted,
        })),
    ),
    memoryRequests: rows.reduce((n, r) => n + r.memory_requests.length, 0),
    memoryRequestsNotHonored: rows.flatMap((r) =>
      r.memory_requests.filter((m) => !m.honored).map((m) => m.quote),
    ),
    unrecoveredErrors: rows.flatMap((r) =>
      r.errors
        .filter((e) => !e.recovered)
        .map((e) => ({ tool: e.tool, error: e.error })),
    ),
  };
}

// Per-session insight building: the pure seam of the extraction loop, isolated
// so it can be unit-tested with a mock model. Returns null when the session's
// raw traces have expired (nothing to assemble), which the loop treats as skip.
export async function buildInsightsForSession(
  model: LanguageModel,
  rows: RawTraceDbRow[],
): Promise<SessionInsights | null> {
  if (rows.length === 0) return null;
  return extractInsights(model, renderSessionText(assembleSession(rows)));
}

// Positional bind values for the session_insights INSERT, matching the column
// order (session_id, errors, corrections, memory_requests, agent_claims, model).
// The four insight arrays are serialized to jsonb strings.
export function insightInsertValues(
  sessionId: string,
  insights: SessionInsights,
  model: string,
): unknown[] {
  return [
    sessionId,
    JSON.stringify(insights.errors),
    JSON.stringify(insights.corrections),
    JSON.stringify(insights.memory_requests),
    JSON.stringify(insights.agent_claims),
    model,
  ];
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
             (session_id, user_id, user_goal, summary, outcome, tool_errors, frustration,
              model, agent_mode, step_count, embedding, pii_check_passed)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::vector,$12)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            session_id,
            session.userId,
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

    // 1b. Extract insights for any summarized session that lacks them. Separate
    // from summarization so it can fail, re-run and backfill independently — but
    // only while the raw traces live (TRACE_RAW_TTL_DAYS, deleted in step 3).
    const { rows: needInsights } = await pool.query<{ session_id: string }>(
      `SELECT ss.session_id FROM session_summaries ss
       WHERE NOT EXISTS (
         SELECT 1 FROM session_insights si WHERE si.session_id = ss.session_id
       )
       ORDER BY ss.id`,
    );
    console.log(`[analyze] ${needInsights.length} session(s) to extract insights from`);
    let failedInsights = 0;
    for (const { session_id } of needInsights) {
      try {
        const { rows } = await pool.query<RawTraceDbRow>(
          "SELECT * FROM raw_traces WHERE session_id = $1 ORDER BY created_at",
          [session_id],
        );
        const insights = await buildInsightsForSession(model, rows);
        if (insights === null) {
          console.log(`[analyze] ${session_id}: raw traces expired, skipping insights`);
          continue;
        }
        await pool.query(
          `INSERT INTO session_insights
             (session_id, errors, corrections, memory_requests, agent_claims, model)
           VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6)
           ON CONFLICT (session_id) DO NOTHING`,
          insightInsertValues(session_id, insights, config.ANALYSIS_MODEL),
        );
        console.log(
          `[analyze] insights for ${session_id}: ${insights.corrections.length} correction(s), ${insights.memory_requests.length} memory request(s)`,
        );
      } catch (err) {
        failedInsights += 1;
        console.error(`[analyze] insights for ${session_id} failed:`, err);
        continue;
      }
    }
    if (failedInsights > 0) {
      console.log(`[analyze] ${failedInsights} session(s) failed insight extraction`);
    }

    // 1c. Build the L2 scenario layer from the L1 atoms of the window. One
    // LLM call per bucket (a user, or the unattributed global pool), and
    // only for buckets that could possibly show repetition — see
    // bucketAtoms. Never runs in the chat path; this is the only writer.
    if (config.SCENARIOS_ENABLED) {
      // ORDER BY recency: bucketAtoms's MAX_ATOMS_PER_BUCKET cap keeps the
      // first N atoms it sees per bucket, so rows must arrive freshest-first
      // or a capped bucket would be trained on its OLDEST evidence instead.
      const { rows: insightsForScenarios } = await pool.query<InsightRowForScenarios>(
        `SELECT si.session_id, ss.user_id, si.errors, si.corrections, si.memory_requests
           FROM session_insights si
           JOIN session_summaries ss ON ss.session_id = si.session_id
          WHERE ss.pii_check_passed
            AND ($1::int IS NULL OR ss.created_at > now() - make_interval(days => $1::int))
          ORDER BY ss.created_at DESC`,
        [windowDays],
      );
      const buckets = bucketAtoms(insightsForScenarios);
      const considered = buckets.slice(0, MAX_SCENARIO_BUCKETS_PER_RUN);
      if (buckets.length > considered.length) {
        // Never truncate silently. NOTE this is not "skipped this run" as if
        // rotated in next time: bucketAtoms only guarantees the global
        // bucket survives the cap (it's placed first); which per-user
        // buckets land past the cap depends on Map insertion order, not
        // recency, and there is no rotation across runs — a bucket that
        // lands past the cap today stays past it every run until the mix of
        // users/buckets changes. See MAX_SCENARIO_BUCKETS_PER_RUN's comment.
        console.log(
          `[analyze] ${buckets.length - considered.length} scenario bucket(s) permanently skipped this and every run (cap ${MAX_SCENARIO_BUCKETS_PER_RUN}, no rotation)`,
        );
      }
      for (const bucket of considered) {
        if (bucket.truncatedAtoms > 0) {
          // Also never silent: a capped bucket was trained on a subset of
          // its evidence, not all of it (see MAX_ATOMS_PER_BUCKET).
          console.log(
            `[analyze] scenario bucket ${bucket.scope}${bucket.userId ? `:${bucket.userId}` : ""} truncated ${bucket.truncatedAtoms} atom(s) to fit MAX_ATOMS_PER_BUCKET`,
          );
        }
        try {
          const extracted = await extractScenarios(model, bucket.atoms);
          for (const scenario of extracted) {
            let embedding: number[] | null = null;
            if (embedder) {
              try {
                embedding = await embedder.embed(scenario.title);
              } catch (err) {
                console.warn("[analyze] scenario embedding failed:", err);
              }
            }
            const outcome = await upsertScenario(pool, {
              scope: bucket.scope,
              userId: bucket.userId,
              kind: scenario.kind,
              title: scenario.title,
              recipe: scenario.recipe,
              sessionIds: scenario.session_ids,
              embedding,
            });
            console.log(`[analyze] scenario ${outcome}: ${scenario.title}`);
          }
        } catch (err) {
          // One bucket's LLM/DB failure must not sink the whole run — the
          // remaining buckets, and clustering below, still matter.
          console.error(`[analyze] scenario extraction failed for ${bucket.scope}:`, err);
        }
      }
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
      const { rows: insightRows } = await pool.query<InsightRow>(
        `SELECT si.errors, si.corrections, si.memory_requests
         FROM session_insights si
         JOIN session_summaries ss ON ss.session_id = si.session_id
         WHERE ss.pii_check_passed
           AND ($1::int IS NULL OR ss.created_at > now() - make_interval(days => $1::int))`,
        [windowDays],
      );
      // Both populations from one pass over the audit log: a review "had
      // evidence" iff its payload carries a non-empty scenario_ids array.
      // This is the metric the whole L2 layer is judged by — see
      // ReportScenarioMetric.
      const { rows: reviewRuns } = await pool.query<{
        with_scenarios: boolean;
        saved: boolean;
      }>(
        `SELECT jsonb_array_length(COALESCE(payload->'scenario_ids','[]'::jsonb)) > 0 AS with_scenarios,
                action = 'saved' AS saved
           FROM agent_selfimprove_audit
          WHERE origin = 'background_review' AND subsystem = 'review'
            AND ($1::int IS NULL OR created_at > now() - make_interval(days => $1::int))`,
        [windowDays],
      );
      const scenarioMetric = {
        withScenarios: { runs: 0, saved: 0 },
        without: { runs: 0, saved: 0 },
      };
      for (const r of reviewRuns) {
        const bucket = r.with_scenarios ? scenarioMetric.withScenarios : scenarioMetric.without;
        bucket.runs += 1;
        if (r.saved) bucket.saved += 1;
      }

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
        insights: tallyInsights(insightRows),
        scenarioMetric,
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
