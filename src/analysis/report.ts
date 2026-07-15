export interface ReportCluster {
  name: string;
  description: string;
  size: number;
  examples: string[];
}

export interface ReportInput {
  date: string;
  windowDays: number | null;
  summaryCount: number;
  clusters: ReportCluster[];
  previousClusters: Array<{ name: string; size: number }>;
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
}

/** Collapse newlines so LLM-derived text cannot start a new markdown line (e.g. a fake `#` heading). */
function inline(text: string): string {
  return text.replace(/\r?\n/g, " ");
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
  }
  return lines.join("\n") + "\n";
}
