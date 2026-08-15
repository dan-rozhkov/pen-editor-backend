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

  // Found by the first live smoke (2026-08-12): asked "запомни обо мне: …",
  // deepseek answered "Запомнил." and called nothing — its own reasoning trace
  // said the request "doesn't require any tools". Nothing was stored while the
  // user was told it was. Both texts must name an explicit ask as a call.
  it("treats an explicit ask to remember as a required call, in both texts", () => {
    for (const text of [MEMORY_GUIDANCE, MEMORY_TOOL_DESCRIPTION]) {
      expect(text).toContain("запомни");
      expect(text.toLowerCase()).toContain("remember");
    }
    expect(MEMORY_GUIDANCE).toContain("call the memory tool in THIS turn");
    expect(MEMORY_TOOL_DESCRIPTION).toContain("REQUIRES this call in the same turn");
  });

  it("keeps the HOW/WHEN/IF FULL/TARGETS/SKIP blocks in the tool description", () => {
    for (const marker of ["HOW:", "WHEN:", "IF FULL:", "TARGETS:", "SKIP:"]) {
      expect(MEMORY_TOOL_DESCRIPTION).toContain(marker);
    }
    expect(MEMORY_TOOL_DESCRIPTION).toContain("one batch call finishes the update, so don't repeat it");
  });

  // Every stored row in production was target='user'; target='memory' — the
  // agent's own notes — had never once been written. Both of the review
  // prompt's original focus points ask about the USER, so the half of memory
  // that compounds across sessions was never solicited at all.
  it("asks the review about the agent's own operating knowledge, not just the user", () => {
    expect(MEMORY_REVIEW_PROMPT).toContain("Did YOU learn something durable about operating here");
    expect(MEMORY_REVIEW_PROMPT).toContain("target 'memory'");
    expect(MEMORY_REVIEW_PROMPT).toContain("target 'user'");
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
