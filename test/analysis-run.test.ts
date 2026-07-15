import { describe, expect, it } from "vitest";
import { parseWindowDays, tally } from "../src/analysis/run.js";

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
