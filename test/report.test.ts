import { describe, expect, it } from "vitest";
import { renderReport, type ReportInput } from "../src/analysis/report.js";

const input: ReportInput = {
  date: "2026-07-15",
  windowDays: null,
  summaryCount: 5,
  clusters: [
    { name: "Small", description: "d1", size: 1, examples: ["e1"] },
    { name: "batch_design failures", description: "d2", size: 4, examples: ["e2", "e3"] },
  ],
  previousClusters: [{ name: "batch_design failures", size: 2 }],
  outcomes: { success: 2, failure: 3 },
  toolErrors: [{ tool: "batch_design", error: "operation limit", count: 3 }],
};

describe("renderReport", () => {
  it("orders clusters by size desc and marks deltas vs previous run", () => {
    const md = renderReport(input);
    const bd = md.indexOf("batch_design failures");
    const small = md.indexOf("## Small");
    expect(bd).toBeGreaterThan(-1);
    expect(bd).toBeLessThan(small);
    expect(md).toContain("+2 vs previous run"); // 4 vs 2
    expect(md).toContain("(new)"); // "Small" absent from previous run
  });

  it("includes header, outcomes and tool errors", () => {
    const md = renderReport(input);
    expect(md).toContain("# Agent Trace Analysis — 2026-07-15");
    expect(md).toContain("Window: all time");
    expect(md).toContain("Sessions analyzed: 5");
    expect(md).toContain("| failure | 3 |");
    expect(md).toContain("| batch_design | operation limit | 3 |");
    expect(md).toContain("- e2");
  });

  it("notes when a cluster lists fewer examples than it has sessions", () => {
    const md = renderReport(input);
    expect(md).toContain("_Showing 2 of 4 examples._"); // "batch_design failures": 4 sessions, 2 examples
  });

  it("omits the note when every session is listed", () => {
    const md = renderReport(input);
    const small = md.slice(md.indexOf("## Small"));
    expect(small).not.toContain("Showing"); // "Small": 1 session, 1 example
  });

  it("escapes LLM-derived text so it cannot inject headings or break tables", () => {
    const evil: ReportInput = {
      date: "2026-07-15",
      windowDays: 7,
      summaryCount: 2,
      clusters: [
        {
          name: "Evil | name\n# Fake Section",
          description: "desc\n# Also Fake",
          size: 2,
          examples: ["ex\n# Fake Example Heading"],
        },
      ],
      previousClusters: [],
      outcomes: { "bad|outcome\n# Fake": 1 },
      toolErrors: [{ tool: "t|ool\nx", error: "err | or\n# Nope", count: 1 }],
    };
    const md = renderReport(evil);
    // No injected heading lines anywhere.
    const headings = md.split("\n").filter((l) => l.startsWith("#"));
    expect(headings).toEqual([
      "# Agent Trace Analysis — 2026-07-15",
      "## Outcomes",
      "## Top tool errors",
      "# Clusters",
      "## Evil | name # Fake Section",
    ]);
    // Table rows stay well-formed: pipes in cells are escaped, no extra columns.
    expect(md).toContain("| bad\\|outcome # Fake | 1 |");
    expect(md).toContain("| t\\|ool x | err \\| or # Nope | 1 |");
    for (const row of md.split("\n").filter((l) => l.startsWith("|"))) {
      const cols = row.split(/(?<!\\)\|/).length - 2;
      expect(cols === 2 || cols === 3).toBe(true);
    }
  });

  it("collapses a lone carriage return so it cannot split a line", () => {
    const evil = { ...input, clusters: [{ name: "a\rb", description: "d", size: 1, examples: ["e"] }] };
    const md = renderReport(evil);
    expect(md).toContain("## a b");
    expect(md).not.toMatch(/\r/);
  });
});

describe("insights section", () => {
  const withInsights: ReportInput = {
    ...input,
    insights: {
      corrections: 4,
      correctionsNotComplied: [
        { what_agent_did: "used a 12px gap", what_user_wanted: "an 8px gap" },
      ],
      memoryRequests: 3,
      memoryRequestsNotHonored: ["always use 8px spacing"],
      unrecoveredErrors: [{ tool: "batch_design", error: "unknown node id" }],
    },
  };

  it("renders counts and the actionable entries before the clusters", () => {
    const md = renderReport(withInsights);
    expect(md).toContain("## Corrections & memory requests");
    expect(md).toContain("**Corrections: 4** (1 not complied)");
    expect(md).toContain("**Memory requests: 3** (1 not honored)");
    expect(md).toContain("**Unrecovered tool errors: 1**");
    expect(md).toContain("- correction (not complied): used a 12px gap → an 8px gap");
    expect(md).toContain("- memory request (not honored): always use 8px spacing");
    expect(md).toContain("- unrecovered error: batch_design — unknown node id");
    expect(md.indexOf("## Corrections & memory requests")).toBeLessThan(
      md.indexOf("# Clusters"),
    );
  });

  it("omits the section entirely when insights are absent", () => {
    expect(renderReport(input)).not.toContain("## Corrections & memory requests");
  });

  it("omits the section when there is nothing to report", () => {
    const empty = {
      ...input,
      insights: {
        corrections: 0,
        correctionsNotComplied: [],
        memoryRequests: 0,
        memoryRequestsNotHonored: [],
        unrecoveredErrors: [],
      },
    };
    expect(renderReport(empty)).not.toContain("## Corrections & memory requests");
  });

  it("neutralises newlines in LLM-derived quotes", () => {
    const sneaky = {
      ...withInsights,
      insights: {
        ...withInsights.insights!,
        memoryRequestsNotHonored: ["line one\n# fake heading"],
      },
    };
    const md = renderReport(sneaky);
    expect(md).toContain("- memory request (not honored): line one # fake heading");
    expect(md).not.toMatch(/^# fake heading$/m);
  });

  it("caps the list at 10 entries with a footer", () => {
    const many = {
      ...withInsights,
      insights: {
        ...withInsights.insights!,
        memoryRequests: 14,
        memoryRequestsNotHonored: Array.from({ length: 14 }, (_, i) => `rule ${i}`),
      },
    };
    const md = renderReport(many);
    // 1 not-complied correction + 14 memory rules + 1 unrecovered error = 16
    expect(md).toContain("_Showing 10 of 16._");
    expect(md).not.toContain("rule 13");
  });
});

describe("scenario metric section", () => {
  it("reports the saved-rate split between scenario-backed and counter-only reviews", () => {
    const md = renderReport({
      ...input,
      scenarioMetric: { withScenarios: { runs: 4, saved: 3 }, without: { runs: 20, saved: 1 } },
    });
    expect(md).toContain("## Self-improvement reviews");
    expect(md).toContain("3/4");
    expect(md).toContain("1/20");
  });

  it("omits the section entirely when the metric is absent", () => {
    expect(renderReport(input)).not.toContain("## Self-improvement reviews");
  });

  it("avoids a NaN rate when a population has zero runs", () => {
    const md = renderReport({
      ...input,
      scenarioMetric: { withScenarios: { runs: 0, saved: 0 }, without: { runs: 5, saved: 2 } },
    });
    expect(md).toContain("n/a");
    expect(md).not.toContain("NaN");
  });
});
