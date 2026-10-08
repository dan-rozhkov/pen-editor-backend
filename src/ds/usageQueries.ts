// SQL for the usage summary and the documents list (migration 021). Everything
// aggregates in the database over all live rows (no row cap); coverage and the
// lint total are columns written with the report, so lists never read JSONB.
// A document reported by several accounts counts once: its latest report.
import { LINT_RULES, USAGE_RETENTION_DAYS } from "./usage.js";
import { compareVersions, parseVersion } from "./semver.js";
import type { Snapshot } from "./snapshotSchema.js";

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const LIVE = `live AS MATERIALIZED (
  SELECT DISTINCT ON (document_key) * FROM ds_usage
   WHERE library_id = $1 AND reported_at >= now() - make_interval(days => $2)
   ORDER BY document_key, reported_at DESC)`;
const live = (sql: string) => `WITH ${LIVE} ${sql}`;
export const lintOf = (col: string) => `CASE WHEN jsonb_typeof(${col}->'lint') = 'object' THEN ${col}->'lint' ELSE '{}'::jsonb END`;
/**
 * THE definition of a lint regression, shared by the summary and by the flag
 * returned from a report: the previous report (kept in prev_metrics, NULL once
 * it expired) had a lint object, and this rule's count is higher now. `e` is a
 * jsonb_each_text row of the current lint object.
 */
export const regressedRule = (e: string, prevCol: string) =>
  `jsonb_typeof(${prevCol}->'lint') = 'object' AND ${e}.value::int > COALESCE((${prevCol}->'lint'->>${e}.key)::int, 0)`;

const MAX_UNUSED_TOKENS = 100;

export async function loadUsageSummary(
  db: Queryable,
  libraryId: string,
  latestVersion: string | null,
  latest: Snapshot | null,
  includeRegressions: boolean,
) {
  // ONE statement: one snapshot for every number, and the live set is computed once (MATERIALIZED).
  const r = (await db.query(
    live(`SELECT
      (SELECT jsonb_build_object('total', count(*), 'last', max(reported_at),
              't_avg', avg(token_coverage), 't_p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY token_coverage),
              'c_avg', avg(component_coverage), 'c_p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY component_coverage)) FROM live) AS totals,
      (SELECT COALESCE(jsonb_object_agg(version, n), '{}'::jsonb) FROM (SELECT version, count(*)::int AS n FROM live GROUP BY version) v) AS versions,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'n', n) ORDER BY n DESC, key), '[]'::jsonb) FROM (
         SELECT e.key, sum(e.value::int)::float8 AS n FROM live, jsonb_each_text(metrics->'components'->'detachedByKey') e
          GROUP BY e.key HAVING sum(e.value::int) > 0 ORDER BY n DESC, e.key LIMIT 10) d) AS detached,
      (SELECT COALESCE(jsonb_agg(key), '[]'::jsonb) FROM (
         SELECT DISTINCT e.key FROM live, jsonb_each_text(metrics->'tokens'->'use') e WHERE e.value::int > 0) u) AS used,
      (SELECT COALESCE(jsonb_object_agg(rule, n), '{}'::jsonb) FROM (
         SELECT e.key AS rule, sum(e.value::int)::float8 AS n FROM live, jsonb_each_text(${lintOf("live.metrics")}) e GROUP BY e.key) l) AS lint,
      CASE WHEN $3::boolean THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('k', k, 'rule', rule, 'delta', delta) ORDER BY delta DESC, k, rule), '[]'::jsonb) FROM (
         SELECT substr(u.document_key, 1, 8) AS k, e.key AS rule, (e.value::int - COALESCE((u.prev_metrics->'lint'->>e.key)::int, 0)) AS delta
           FROM live u, jsonb_each_text(${lintOf("u.metrics")}) e
          WHERE ${regressedRule("e", "u.prev_metrics")}
          ORDER BY delta DESC, k, rule LIMIT 20) g) END AS regressions
      `),
    [libraryId, USAGE_RETENTION_DAYS, includeRegressions],
  )) as { rows: Array<Record<string, unknown>> };
  const row = r.rows[0] ?? {};
  const totals = (row.totals ?? {}) as { total?: number; last?: string | null; t_avg?: number | null; t_p50?: number | null; c_avg?: number | null; c_p50?: number | null };
  const versions = Object.entries((row.versions ?? {}) as Record<string, number>).map(([version, n]) => ({ version, n }));
  const detached = (row.detached ?? []) as Array<{ key: string; n: number }>;
  const used = ((row.used ?? []) as string[]).map((key) => ({ key }));
  const lintRows = Object.entries((row.lint ?? {}) as Record<string, number>).map(([rule, n]) => ({ rule, n }));
  const regressions = row.regressions ? (row.regressions as Array<{ k: string; rule: string; delta: number }>) : null;

  const latestParsed = latestVersion ? parseVersion(latestVersion) : null;
  let behind = 0;
  for (const v of versions) {
    const parsed = parseVersion(v.version);
    if (latestParsed && parsed && compareVersions(parsed, latestParsed) < 0) behind += v.n;
  }
  const usedIds = new Set(used.map((u) => u.key));
  const unused = (latest?.variables ?? []).filter((v) => !usedIds.has(v.id));
  const lintByRule = new Map(lintRows.map((l) => [l.rule, Number(l.n)]));
  const stat = (avg: number | null, p50: number | null) => (avg === null || p50 === null ? null : { avg: round4(avg), p50: round4(p50) });
  return {
    documents: {
      total: totals.total ?? 0,
      byVersion: Object.fromEntries(versions.map((v) => [v.version, v.n])),
      behind,
    },
    coverage: { token: stat(totals.t_avg ?? null, totals.t_p50 ?? null), component: stat(totals.c_avg ?? null, totals.c_p50 ?? null) },
    topDetached: detached.map((d) => ({ key: d.key, count: Number(d.n) })),
    unusedTokens: unused.slice(0, MAX_UNUSED_TOKENS).map((v) => ({ id: v.id, name: v.name })),
    // True when unusedTokens was cut at its cap; every count above covers all live rows.
    truncated: unused.length > MAX_UNUSED_TOKENS,
    lint: Object.fromEntries(LINT_RULES.map((r) => [r, lintByRule.get(r) ?? 0])),
    // Editors and owners only: viewers see counts.
    ...(regressions ? { regressions: regressions.map((r) => ({ documentKey: r.k, rule: r.rule, delta: r.delta })) } : {}),
    lastReportedAt: totals.last ? new Date(totals.last) : null,
  };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export type UsageSort = "reportedAt" | "coverage";
export type UsageDocumentsCursor = { sort: UsageSort; ts?: string; coverage?: string | null; key: string };

const TS_RE = /^(?:19|20|21)\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeUsageCursor(c: UsageDocumentsCursor): string {
  const parts = c.sort === "reportedAt" ? ["r", c.ts ?? "", c.key] : ["c", c.coverage ?? "", c.key];
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

/** Null for a cursor this server did not issue, or one issued for the other sort. */
export function parseUsageCursor(cursor: string, sort: UsageSort): UsageDocumentsCursor | null {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((x) => typeof x === "string")) return null;
    const [tag, value, key] = p as string[];
    if (!KEY_RE.test(key)) return null;
    if (sort === "reportedAt") return tag === "r" && TS_RE.test(value) && !Number.isNaN(Date.parse(value)) ? { sort, ts: value, key } : null;
    if (tag !== "c") return null;
    if (value === "") return { sort, coverage: null, key };
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? { sort, coverage: value, key } : null;
  } catch {
    return null;
  }
}

const CURSOR_TS = `to_char(reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listUsageDocuments(
  db: Queryable,
  libraryId: string,
  latestVersion: string | null,
  opts: { limit: number; sort: UsageSort; cursor: UsageDocumentsCursor | null },
) {
  const params: unknown[] = [libraryId, USAGE_RETENTION_DAYS];
  const c = opts.cursor;
  // The route parsed the cursor for this sort; a mismatch is refused, never a silent restart.
  if (c && c.sort !== opts.sort) return { kind: "invalid_cursor" as const };
  let where = "true";
  if (c) {
    if (opts.sort === "reportedAt") {
      params.push(c.ts, c.key);
      where = `(reported_at < $3::timestamptz OR (reported_at = $3::timestamptz AND document_key > $4))`;
    } else if (c.coverage === null || c.coverage === undefined) {
      params.push(c.key);
      where = `(token_coverage IS NULL AND document_key > $3)`;
    } else {
      params.push(c.coverage, c.key);
      where = `(token_coverage > $3::float8 OR (token_coverage = $3::float8 AND document_key > $4) OR token_coverage IS NULL)`;
    }
  }
  const order = opts.sort === "reportedAt" ? "reported_at DESC, document_key" : "token_coverage ASC NULLS LAST, document_key";
  params.push(opts.limit + 1);
  const r = (await db.query(
    live(
      `SELECT id, document_key, version, token_coverage, component_coverage, lint_total, reported_at, ${CURSOR_TS} AS cursor_ts
         FROM live WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`,
    ),
    params,
  )) as {
    rows: Array<{
      id: string; document_key: string; version: string; token_coverage: number | null; component_coverage: number | null;
      lint_total: number; reported_at: string | Date; cursor_ts: string;
    }>;
  };
  const latest = latestVersion ? parseVersion(latestVersion) : null;
  const page = r.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => {
      const parsed = parseVersion(row.version);
      return {
        // Stable opaque id: the only thing an admin deletes by.
        reportId: row.id,
        documentKey: row.document_key.slice(0, 8),
        version: row.version,
        behind: latest !== null && parsed !== null && compareVersions(parsed, latest) < 0,
        tokenCoverage: row.token_coverage,
        componentCoverage: row.component_coverage,
        lintTotal: row.lint_total,
        reportedAt: new Date(row.reported_at),
      };
    }),
    nextCursor:
      r.rows.length > opts.limit && last
        ? encodeUsageCursor(
            opts.sort === "reportedAt"
              ? { sort: "reportedAt", ts: last.cursor_ts, key: last.document_key }
              : { sort: "coverage", coverage: last.token_coverage === null ? null : String(last.token_coverage), key: last.document_key },
          )
        : null,
  };
}
export type UsageDocuments = Exclude<Awaited<ReturnType<typeof listUsageDocuments>>, { kind: "invalid_cursor" }>;
export type UsageSummary = Awaited<ReturnType<typeof loadUsageSummary>>;
