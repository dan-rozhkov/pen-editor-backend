import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { extractInsights, sessionInsightsSchema } from "../src/analysis/insights.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const cleanInsights = {
  errors: [
    {
      tool: "batch_design",
      error: "unknown node id",
      recovered: false,
      what_agent_did_next: "Reported the failure to the user and stopped.",
    },
  ],
  corrections: [
    {
      what_agent_did: "Placed the card at the canvas origin",
      what_user_wanted: "The card centred in the existing frame",
      user_quote: "no, put it inside the frame, not next to it",
      agent_complied: true,
    },
  ],
  memory_requests: [{ quote: "always use 8px spacing from now on", honored: false }],
  agent_claims: [
    { quote: "I cannot read the canvas without a tool call", kind: "limitation" },
  ],
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

describe("extractInsights", () => {
  it("returns validated insights with all four categories", async () => {
    const result = await extractInsights(objectModel([cleanInsights]), "user: make a card");
    expect(result.errors[0].recovered).toBe(false);
    expect(result.corrections[0].agent_complied).toBe(true);
    expect(result.memory_requests[0].honored).toBe(false);
    expect(result.agent_claims[0].kind).toBe("limitation");
  });

  it("scrubs PII out of verbatim quote fields", async () => {
    const dirty = {
      ...cleanInsights,
      memory_requests: [{ quote: "remember my email is john@example.com", honored: true }],
      corrections: [
        {
          ...cleanInsights.corrections[0],
          user_quote: "call me on +1 555 123 4567 instead",
        },
      ],
    };
    const result = await extractInsights(objectModel([dirty]), "text");
    expect(result.memory_requests[0].quote).toContain("[EMAIL]");
    expect(result.memory_requests[0].quote).not.toContain("john@example.com");
    expect(result.corrections[0].user_quote).toContain("[PHONE]");
  });

  it("keeps empty categories as empty arrays", async () => {
    const empty = { errors: [], corrections: [], memory_requests: [], agent_claims: [] };
    const result = await extractInsights(objectModel([empty]), "user: hi");
    expect(result).toEqual(empty);
  });

  it("schema rejects an unknown agent_claim kind", () => {
    const bad = {
      ...cleanInsights,
      agent_claims: [{ quote: "q", kind: "musing" }],
    };
    expect(sessionInsightsSchema.safeParse(bad).success).toBe(false);
  });
});
