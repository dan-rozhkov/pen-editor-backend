export interface ReportCluster {
  name: string;
  description: string;
  size: number;
  examples: string[];
}

export interface ReportInsights {
  corrections: number;
  correctionsNotComplied: Array<{ what_agent_did: string; what_user_wanted: string }>;
  memoryRequests: number;
  memoryRequestsNotHonored: string[];
  unrecoveredErrors: Array<{ tool: string; error: string }>;
}

/** Runs, and among them saved-runs, split by whether the background review
 * carried scenario evidence (a non-empty `payload.scenario_ids`). This is
 * the number the whole L2 layer exists to be judged by: if `withScenarios`
 * doesn't save at a higher rate than `without`, the evidence isn't earning
 * its LLM calls. */
export interface ReportScenarioMetric {
  withScenarios: { runs: number; saved: number };
  without: { runs: number; saved: number };
}

export interface ReportInput {
  date: string;
  windowDays: number | null;
  summaryCount: number;
  clusters: ReportCluster[];
  previousClusters: Array<{ name: string; size: number }>;
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
  insights?: ReportInsights;
  scenarioMetric?: ReportScenarioMetric;
}

/** Collapse newlines so LLM-derived text cannot start a new markdown line (e.g. a fake `#` heading). */
function inline(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** Escape LLM-derived text for a markdown table cell: no pipes, no newlines. */
function cell(text: string): string {
  return inline(text).replace(/\|/g, "\\|");
}

function delta(cluster: ReportCluster, prev: Map<string, number>): string {
  if (!prev.size) return "";
  const before = prev.get(cluster.name);
  if (before === undefined) return " (new)";
  const d = cluster.size - before;
  if (d === 0) return " (unchanged)";
  return ` (${d > 0 ? "+" : ""}${d} vs previous run)`;
}

const MAX_INSIGHT_LINES = 10;

// Lists only what the agent got wrong: those are the entries a prompt fix acts on.
function insightLines(i: ReportInsights): string[] {
  const entries = [
    ...i.correctionsNotComplied.map(
      (c) =>
        `- correction (not complied): ${inline(c.what_agent_did)} → ${inline(c.what_user_wanted)}`,
    ),
    ...i.memoryRequestsNotHonored.map((q) => `- memory request (not honored): ${inline(q)}`),
    ...i.unrecoveredErrors.map(
      (e) => `- unrecovered error: ${inline(e.tool)} — ${inline(e.error)}`,
    ),
  ];
  if (entries.length === 0) return [];
  const shown = entries.slice(0, MAX_INSIGHT_LINES);
  const lines = [
    "",
    "## Corrections & memory requests",
    "",
    `**Corrections: ${i.corrections}** (${i.correctionsNotComplied.length} not complied) · ` +
      `**Memory requests: ${i.memoryRequests}** (${i.memoryRequestsNotHonored.length} not honored) · ` +
      `**Unrecovered tool errors: ${i.unrecoveredErrors.length}**`,
    "",
    ...shown,
  ];
  if (entries.length > shown.length) {
    lines.push("", `_Showing ${shown.length} of ${entries.length}._`);
  }
  return lines;
}

// A run "had evidence" iff its audit payload's scenario_ids was non-empty;
// both populations must be non-zero-guarded here — rate() does no division,
// but without the p.runs === 0 check it would still render "0/0 saved",
// which reads as a real (empty) population rather than "no runs yet".
function scenarioLines(m: ReportScenarioMetric): string[] {
  const rate = (p: { runs: number; saved: number }): string =>
    p.runs === 0 ? "n/a" : `${p.saved}/${p.runs} saved`;
  return [
    "",
    "## Self-improvement reviews",
    "",
    `- with scenario evidence: ${rate(m.withScenarios)}`,
    `- counters only: ${rate(m.without)}`,
  ];
}

export function renderReport(input: ReportInput): string {
  const prev = new Map(input.previousClusters.map((c) => [c.name, c.size]));
  const clusters = [...input.clusters].sort((a, b) => b.size - a.size);
  const lines: string[] = [
    `# Agent Trace Analysis — ${input.date}`,
    "",
    `Window: ${input.windowDays === null ? "all time" : `last ${input.windowDays} days`}`,
    `Sessions analyzed: ${input.summaryCount}`,
    "",
    "## Outcomes",
    "",
    "| Outcome | Count |",
    "|---|---|",
    ...Object.entries(input.outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${cell(k)} | ${v} |`),
    "",
    "## Top tool errors",
    "",
    "| Tool | Error | Count |",
    "|---|---|---|",
    ...input.toolErrors
      .sort((a, b) => b.count - a.count)
      .map((e) => `| ${cell(e.tool)} | ${cell(e.error)} | ${e.count} |`),
    ...(input.insights ? insightLines(input.insights) : []),
    ...(input.scenarioMetric ? scenarioLines(input.scenarioMetric) : []),
    "",
    "# Clusters",
  ];
  for (const c of clusters) {
    lines.push(
      "",
      `## ${inline(c.name)}`,
      "",
      `**${c.size} session(s)**${delta(c, prev)}`,
      "",
      inline(c.description),
      "",
      ...c.examples.map((e) => `- ${inline(e)}`),
    );
    if (c.examples.length < c.size) {
      lines.push("", `_Showing ${c.examples.length} of ${c.size} examples._`);
    }
  }
  return lines.join("\n") + "\n";
}
