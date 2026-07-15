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
});
