import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  buildInsightsForSession,
  insightInsertValues,
  parseWindowDays,
  tally,
  tallyInsights,
} from "../src/analysis/run.js";
import type { SessionInsights } from "../src/analysis/insights.js";
import type { RawTraceDbRow } from "../src/analysis/assemble.js";

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

describe("insightInsertValues", () => {
  const insights: SessionInsights = {
    errors: [{ tool: "batch_design", error: "unknown node id", recovered: true, what_agent_did_next: "retried" }],
    corrections: [{ what_agent_did: "a", what_user_wanted: "b", user_quote: "no", agent_complied: false }],
    memory_requests: [{ quote: "remember X", honored: true }],
    agent_claims: [{ quote: "I cannot read the canvas", kind: "limitation" }],
  };

  it("returns bind values in column order with the four arrays as jsonb strings", () => {
    const values = insightInsertValues("tab-1-1", insights, "google/gemini-2.5-flash");
    expect(values).toEqual([
      "tab-1-1",
      JSON.stringify(insights.errors),
      JSON.stringify(insights.corrections),
      JSON.stringify(insights.memory_requests),
      JSON.stringify(insights.agent_claims),
      "google/gemini-2.5-flash",
    ]);
    // The jsonb columns must be strings (node-postgres serializes them as-is).
    expect(typeof values[1]).toBe("string");
    expect(JSON.parse(values[2] as string)[0].agent_complied).toBe(false);
  });

  it("serializes empty insight arrays to '[]'", () => {
    const empty: SessionInsights = { errors: [], corrections: [], memory_requests: [], agent_claims: [] };
    const values = insightInsertValues("tab-2-1", empty, "m");
    expect(values.slice(1, 5)).toEqual(["[]", "[]", "[]", "[]"]);
  });
});

describe("buildInsightsForSession", () => {
  const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const extracted = {
    errors: [{ tool: "batch_design", error: "unknown node id", recovered: true, what_agent_did_next: "retried" }],
    corrections: [],
    memory_requests: [],
    agent_claims: [],
  };
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(extracted) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
  const row: RawTraceDbRow = {
    id: 1,
    session_id: "tab-1-1",
    created_at: new Date("2026-07-17T10:00:00Z"),
    model: "m",
    agent_mode: "edits",
    payload: { messages: [{ role: "user", parts: [{ type: "text", text: "make a card" }] }], steps: [] },
    stream_error: null,
    input_tokens: 10,
    output_tokens: 5,
  };

  it("returns null when the session's raw traces have expired", async () => {
    expect(await buildInsightsForSession(model, [])).toBeNull();
  });

  it("assembles the session and returns extracted insights", async () => {
    const result = await buildInsightsForSession(model, [row]);
    expect(result?.errors[0].error).toBe("unknown node id");
    expect(result?.errors[0].recovered).toBe(true);
  });
});
