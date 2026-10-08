// Counts-only adoption data (migration 021, plan 7.2). A report is integers
// keyed by library variable ids / component keys of the version the document
// pins; nothing else is accepted, so no name, markup, title or free text can
// be stored. The summary is computed here from the latest reports (pure).
import { z } from "zod";
import { LINT_RULE_IDS } from "../ai/tools.js";
import { compareVersions, parseVersion } from "./semver.js";
import type { Snapshot } from "./snapshotSchema.js";

export const USAGE_RETENTION_DAYS = 90;
/** Rows pruned per write, per library: a bounded cost on the hot path. */
export const USAGE_PRUNE_BATCH = 50;
/** Newest reports the summary reads; older ones are ignored. */
export const USAGE_SUMMARY_ROW_CAP = 5000;
export const MAX_USAGE_METRICS_BYTES = 64 * 1024;
// One list with the lint tool: the frontend report counts every rule the tool can run.
export const LINT_RULES = LINT_RULE_IDS;

const MAX_COUNT = 10_000_000;
const MAX_KEYS = 20_000;
const count = z.number().int().min(0).max(MAX_COUNT);
const countMap = z
  .record(z.string().min(1).max(200), count)
  .refine((m) => Object.keys(m).length <= MAX_KEYS, `At most ${MAX_KEYS} keys.`);

export const usageMetricsSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: count,
    tokens: z.object({ bindable: count, bound: count, boundToLibrary: count, literal: count, use: countMap }).strict(),
    components: z.object({ instances: count, detached: count, use: countMap, detachedByKey: countMap }).strict(),
    lint: z.object(Object.fromEntries(LINT_RULES.map((r) => [r, count.optional()]))).strict().nullable(),
  })
  .strict();

export type UsageMetrics = z.infer<typeof usageMetricsSchema>;

/** How many keys of the report name nothing in the pinned snapshot. Counts only: ids are never echoed. */
export function countUnknownIds(metrics: UsageMetrics, snapshot: Snapshot): number {
  const variables = new Set(snapshot.variables.map((v) => v.id));
  const components = new Set(snapshot.components.map((c) => c.key));
  const bad = (keys: string[], known: Set<string>) => keys.filter((k) => !known.has(k)).length;
  return (
    bad(Object.keys(metrics.tokens.use), variables) +
    bad(Object.keys(metrics.components.use), components) +
    bad(Object.keys(metrics.components.detachedByKey), components)
  );
}

export interface UsageRow {
  documentKey: string;
  version: string;
  metrics: UsageMetrics;
  prevMetrics: UsageMetrics | null;
  reportedAt: Date;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function stats(values: number[]): { avg: number; p50: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const p50 = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { avg: round4(values.reduce((s, v) => s + v, 0) / values.length), p50: round4(p50) };
}

export const tokenCoverage = (m: UsageMetrics): number | null => (m.tokens.bindable > 0 ? m.tokens.bound / m.tokens.bindable : null);
export const componentCoverage = (m: UsageMetrics): number | null =>
  m.components.instances > 0 ? Math.max(0, m.components.instances - m.components.detached) / m.components.instances : null;

const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

export function summarizeUsage(rows: UsageRow[], latestVersion: string | null, latest: Snapshot | null) {
  const latestParsed = latestVersion ? parseVersion(latestVersion) : null;
  const byVersion: Record<string, number> = {};
  let behind = 0;
  const detached = new Map<string, number>();
  const used = new Set<string>();
  const lint: Record<string, number> = {};
  const regressions: Array<{ documentKey: string; rule: string; delta: number }> = [];
  for (const row of rows) {
    byVersion[row.version] = (byVersion[row.version] ?? 0) + 1;
    const parsed = parseVersion(row.version);
    if (latestParsed && parsed && compareVersions(parsed, latestParsed) < 0) behind += 1;
    for (const [key, n] of Object.entries(row.metrics.components.detachedByKey)) detached.set(key, (detached.get(key) ?? 0) + n);
    for (const [id, n] of Object.entries(row.metrics.tokens.use)) if (n > 0) used.add(id);
    for (const rule of LINT_RULES) {
      const now = row.metrics.lint?.[rule] ?? 0;
      if (row.metrics.lint) lint[rule] = (lint[rule] ?? 0) + now;
      const delta = now - (row.prevMetrics?.lint?.[rule] ?? 0);
      if (row.prevMetrics?.lint && delta > 0) regressions.push({ documentKey: row.documentKey.slice(0, 8), rule, delta });
    }
  }
  regressions.sort((a, b) => b.delta - a.delta);
  return {
    documents: { total: rows.length, byVersion, behind },
    coverage: {
      token: stats(rows.map((r) => tokenCoverage(r.metrics)).filter((n): n is number => n !== null)),
      component: stats(rows.map((r) => componentCoverage(r.metrics)).filter((n): n is number => n !== null)),
    },
    topDetached: [...detached.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([key, n]) => ({ key, count: n })),
    unusedTokens: (latest?.variables ?? []).filter((v) => !used.has(v.id)).slice(0, 100).map((v) => ({ id: v.id, name: v.name })),
    lint,
    regressions: regressions.slice(0, 20),
    lastReportedAt: rows.reduce<Date | null>((max, r) => (max === null || r.reportedAt > max ? r.reportedAt : max), null),
  };
}

/** Coarse buckets for analytics: never a raw count. */
export function bucket(n: number, edges: number[]): string {
  const i = edges.findIndex((e) => n < e);
  return i === -1 ? `${edges[edges.length - 1]}+` : i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
}

export function usageAnalytics(m: UsageMetrics): Record<string, string | boolean> {
  const pct = (v: number | null) => (v === null ? "none" : bucket(Math.round(v * 100), [25, 50, 75, 100]));
  return {
    nodes_bucket: bucket(m.nodes, [100, 1000, 10000]),
    token_coverage_bucket: pct(tokenCoverage(m)),
    component_coverage_bucket: pct(componentCoverage(m)),
    has_lint: m.lint !== null,
    has_regression_signal: sum(Object.values(m.lint ?? {}).map((n) => n ?? 0)) > 0,
  };
}

export type UsageSort = "reportedAt" | "coverage";

const lintTotal = (m: UsageMetrics) => sum(Object.values(m.lint ?? {}).map((n) => n ?? 0));

/** Editor view of single reports. The key is a short prefix, the reporter is never named. */
export function listUsageDocuments(rows: UsageRow[], latestVersion: string | null, sort: UsageSort, offset: number, limit: number) {
  const latest = latestVersion ? parseVersion(latestVersion) : null;
  const items = rows.map((r) => {
    const parsed = parseVersion(r.version);
    return {
      documentKey: r.documentKey.slice(0, 8),
      version: r.version,
      behind: latest !== null && parsed !== null && compareVersions(parsed, latest) < 0,
      tokenCoverage: tokenCoverage(r.metrics),
      componentCoverage: componentCoverage(r.metrics),
      lintTotal: lintTotal(r.metrics),
      reportedAt: r.reportedAt,
    };
  });
  // Lowest coverage first (what needs attention); reports without bindable properties last.
  if (sort === "coverage") items.sort((a, b) => (a.tokenCoverage ?? 2) - (b.tokenCoverage ?? 2) || b.reportedAt.getTime() - a.reportedAt.getTime());
  const page = items.slice(offset, offset + limit);
  return { items: page, nextCursor: offset + limit < items.length ? String(offset + limit) : null };
}
