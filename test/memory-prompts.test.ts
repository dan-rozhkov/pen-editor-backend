import { describe, expect, it } from "vitest";
import {
  MEMORY_CIRCUIT_BREAKER,
  MEMORY_GUIDANCE,
  MEMORY_REVIEW_PROMPT,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_WRITE_SAVED,
} from "../src/ai/memory/prompts.js";

describe("memory prompts", () => {
  it("keeps the anti-staleness and declarative-facts rules in the guidance", () => {
    expect(MEMORY_GUIDANCE).toContain("If a fact will be stale in a week, it does not belong in memory.");
    expect(MEMORY_GUIDANCE).toContain("Write memories as declarative facts, not instructions to yourself.");
    expect(MEMORY_GUIDANCE).toContain("Do NOT save task progress");
  });

  it("keeps the HOW/WHEN/IF FULL/TARGETS/SKIP blocks in the tool description", () => {
    for (const marker of ["HOW:", "WHEN:", "IF FULL:", "TARGETS:", "SKIP:"]) {
      expect(MEMORY_TOOL_DESCRIPTION).toContain(marker);
    }
    expect(MEMORY_TOOL_DESCRIPTION).toContain("one batch call finishes the update, so don't repeat it");
  });

  it("tells the review run it may only call the memory tool", () => {
    expect(MEMORY_REVIEW_PROMPT).toContain("You can only call the memory tool.");
    expect(MEMORY_REVIEW_PROMPT).toContain("Nothing to save.");
  });

  it("keeps the terminal success line and the circuit-breaker line", () => {
    expect(MEMORY_WRITE_SAVED).toBe("Write saved. This update is complete — do not repeat it.");
    expect(MEMORY_CIRCUIT_BREAKER).toContain("Stop retrying memory calls");
  });
});
