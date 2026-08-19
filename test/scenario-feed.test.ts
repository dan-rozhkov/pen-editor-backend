import { describe, expect, it } from "vitest";
import { nextScenarioState, renderScenarioBlock, MAX_SCENARIOS_PER_REVIEW } from "../src/ai/selfimprove/scenarioFeed.js";

describe("nextScenarioState", () => {
  it("distills whenever the run wrote something", () => {
    expect(nextScenarioState(1, true)).toBe("distilled");
    expect(nextScenarioState(2, true)).toBe("distilled");
  });
  it("keeps a first silent offer alive", () => {
    expect(nextScenarioState(1, false)).toBe("offered");
  });
  it("rejects for good on the second silent offer", () => {
    expect(nextScenarioState(2, false)).toBe("rejected");
    expect(nextScenarioState(3, false)).toBe("rejected");
  });
});

describe("renderScenarioBlock", () => {
  it("is empty for no scenarios", () => {
    expect(renderScenarioBlock([])).toBe("");
  });
  it("names the id, kind and confirmation count", () => {
    const block = renderScenarioBlock([
      { id: 12, kind: "correction", title: "starts with questions", recipe: "show a draft first", confirmations: 4, offerCount: 0 },
    ]);
    expect(block).toContain("S-12");
    expect(block).toContain("4 separate sessions");
    expect(block).toContain("show a draft first");
  });
  it("caps at two", () => {
    expect(MAX_SCENARIOS_PER_REVIEW).toBe(2);
  });
});
