import { describe, expect, it } from "vitest";
import { parseWindowDays, tally, tallyInsights } from "../src/analysis/run.js";

describe("parseWindowDays", () => {
  it("parses --window-days=30 and defaults to null", () => {
    expect(parseWindowDays(["node", "run.ts", "--window-days=30"])).toBe(30);
    expect(parseWindowDays(["node", "run.ts"])).toBeNull();
    expect(parseWindowDays(["node", "run.ts", "--window-days=abc"])).toBeNull();
  });
});

describe("tally", () => {
  it("counts outcomes and tool errors", () => {
    const rows = [
      { outcome: "failure", tool_errors: [{ tool: "batch_design", error: "limit" }] },
      { outcome: "failure", tool_errors: [{ tool: "batch_design", error: "limit" }] },
      { outcome: "success", tool_errors: [] },
    ];
    const { outcomes, toolErrors } = tally(rows);
    expect(outcomes).toEqual({ failure: 2, success: 1 });
    expect(toolErrors).toEqual([{ tool: "batch_design", error: "limit", count: 2 }]);
  });
});

describe("tallyInsights", () => {
  const rows = [
    {
      errors: [
        { tool: "batch_design", error: "unknown node id", recovered: false },
        { tool: "batch_design", error: "operation limit", recovered: true },
      ],
      corrections: [
        { what_agent_did: "placed at origin", what_user_wanted: "inside the frame", agent_complied: true },
        { what_agent_did: "used 12px gap", what_user_wanted: "8px gap", agent_complied: false },
      ],
      memory_requests: [{ quote: "always use 8px spacing", honored: false }],
    },
    { errors: [], corrections: [], memory_requests: [{ quote: "prefer dark mode", honored: true }] },
  ];

  it("counts totals and surfaces only the actionable entries", () => {
    const t = tallyInsights(rows);
    expect(t.corrections).toBe(2);
    expect(t.memoryRequests).toBe(2);
    expect(t.correctionsNotComplied).toEqual([
      { what_agent_did: "used 12px gap", what_user_wanted: "8px gap" },
    ]);
    expect(t.memoryRequestsNotHonored).toEqual(["always use 8px spacing"]);
    expect(t.unrecoveredErrors).toEqual([
      { tool: "batch_design", error: "unknown node id" },
    ]);
  });

  it("returns zeroed counts for no rows", () => {
    expect(tallyInsights([])).toEqual({
      corrections: 0,
      correctionsNotComplied: [],
      memoryRequests: 0,
      memoryRequestsNotHonored: [],
      unrecoveredErrors: [],
    });
  });
});
