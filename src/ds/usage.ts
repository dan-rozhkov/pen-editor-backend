// Counts-only adoption data (migration 021, plan 7.2). A report is integers
// keyed by library variable ids / component keys of the version the document
// pins; nothing else is accepted, so no name, markup, title or free text can
// be stored. Aggregation lives in SQL (usageQueries.ts); this file holds the
// report schema and the pure helpers around it.
import { z } from "zod";
import { LINT_RULE_IDS } from "../ai/lintRules.js";
import type { Snapshot } from "./snapshotSchema.js";

export const USAGE_RETENTION_DAYS = 90;
/** Rows pruned per write, per library: a bounded cost on the hot path. The daily sweep does the rest. */
export const USAGE_PRUNE_BATCH = 20;
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
  .strict()
  .superRefine((m, ctx) => {
    const bad = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (m.tokens.bound > m.tokens.bindable) bad(["tokens", "bound"], "bound cannot exceed bindable");
    if (m.tokens.boundToLibrary > m.tokens.bound) bad(["tokens", "boundToLibrary"], "boundToLibrary cannot exceed bound");
    if (m.components.detached > m.components.instances) bad(["components", "detached"], "detached cannot exceed instances");
  });

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

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export const tokenCoverage = (m: UsageMetrics): number | null => (m.tokens.bindable > 0 ? clamp01(m.tokens.bound / m.tokens.bindable) : null);
export const componentCoverage = (m: UsageMetrics): number | null =>
  m.components.instances > 0 ? clamp01((m.components.instances - m.components.detached) / m.components.instances) : null;
export const lintTotal = (m: UsageMetrics): number => Object.values(m.lint ?? {}).reduce<number>((s, n) => s + (n ?? 0), 0);

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
  };
}
