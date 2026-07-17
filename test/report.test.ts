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
});
