import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  summarizeWithPiiGuard,
  sessionSummarySchema,
} from "../src/analysis/summarize.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const cleanSummary = {
  user_goal: "Create a pricing page frame",
  summary:
    "User asked for a 3-column pricing layout; the agent created frames but batch_design failed once with an operation-limit error, then succeeded after splitting.",
  outcome: "partial",
  tool_errors: [{ tool: "batch_design", error: "operation limit exceeded" }],
  frustration: false,
};

function objectModel(objects: Array<Record<string, unknown>>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: "text", text: JSON.stringify(objects[Math.min(call++, objects.length - 1)]) },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("summarizeWithPiiGuard", () => {
  it("returns a validated summary when output is clean", async () => {
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([cleanSummary]),
      "user: make a pricing page",
    );
    expect(piiCheckPassed).toBe(true);
    expect(summary.outcome).toBe("partial");
    expect(summary.tool_errors[0].tool).toBe("batch_design");
  });

  it("retries when the summary contains PII, then succeeds", async () => {
    const dirty = { ...cleanSummary, summary: "User john@example.com asked for a card." };
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([dirty, cleanSummary]),
      "text",
    );
    expect(piiCheckPassed).toBe(true);
    expect(summary.summary).not.toContain("john@example.com");
  });

  it("after exhausting retries, scrubs fields and marks pii_check failed", async () => {
    const dirty = { ...cleanSummary, summary: "Email john@example.com leaked." };
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([dirty]),
      "text",
      1,
    );
    expect(piiCheckPassed).toBe(false);
    expect(summary.summary).toContain("[EMAIL]");
    expect(summary.summary).not.toContain("john@example.com");
  });

  it("schema rejects unknown outcome values", () => {
    expect(
      sessionSummarySchema.safeParse({ ...cleanSummary, outcome: "great" }).success,
    ).toBe(false);
  });
});
