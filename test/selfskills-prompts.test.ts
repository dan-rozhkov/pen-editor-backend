import { describe, expect, it } from "vitest";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import {
  MEMORY_SKILL_BRIDGE,
  SKILL_REVIEW_PROMPT,
  buildCombinedReviewPrompt,
  buildSkillReviewPrompt,
  selectReviewPrompt,
} from "../src/ai/skills/prompts.js";

describe("skill review prompt", () => {
  it("carries the preference ladder in order", () => {
    const patchIdx = SKILL_REVIEW_PROMPT.indexOf("UPDATE A SKILL THAT WAS LOADED THIS SESSION");
    const existingIdx = SKILL_REVIEW_PROMPT.indexOf("UPDATE AN EXISTING SKILL");
    const createIdx = SKILL_REVIEW_PROMPT.indexOf("CREATE A NEW CLASS-LEVEL SKILL");
    expect(patchIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeLessThan(existingIdx);
    expect(existingIdx).toBeLessThan(createIdx);
  });

  it("carries the whole do-not-capture list", () => {
    for (const phrase of [
      "environment-dependent failures",
      "negative claims about tools",
      "transient errors that resolved",
      "one-off task narratives",
      "unresolved failures",
    ]) {
      expect(SKILL_REVIEW_PROMPT).toContain(phrase);
    }
  });

  it("keeps 'Nothing to save.' available but non-default", () => {
    expect(SKILL_REVIEW_PROMPT).toContain(
      "'Nothing to save.' is a real option but should NOT be the default.",
    );
  });
});

// Finding 1: the trailing tool-restriction sentence used to be hardcoded
// into SKILL_REVIEW_PROMPT claiming memory is ALWAYS callable — wrong for a
// SELF_SKILLS_ENABLED-only deployment (MEMORY_ENABLED off), where the review
// never gets a real `memory` tool at all. buildSkillReviewPrompt conditions
// that sentence on whether memory is actually available this run.
describe("buildSkillReviewPrompt", () => {
  it("claims skill AND memory tools when memory is available", () => {
    const prompt = buildSkillReviewPrompt(true);
    expect(prompt).toContain("You can only call skill and memory management tools.");
    expect(prompt.startsWith(SKILL_REVIEW_PROMPT)).toBe(true);
  });

  it("claims only skill tools, and does not mention memory as callable, when memory is unavailable", () => {
    const prompt = buildSkillReviewPrompt(false);
    expect(prompt).toContain("You can only call skill management tools");
    expect(prompt).not.toContain("skill and memory management tools");
  });
});

describe("combined review prompt", () => {
  it("puts the memory half first, then the bridge, then the skill half", () => {
    const combined = buildCombinedReviewPrompt();
    const memIdx = combined.indexOf(MEMORY_REVIEW_PROMPT);
    const bridgeIdx = combined.indexOf(MEMORY_SKILL_BRIDGE);
    const skillIdx = combined.indexOf(SKILL_REVIEW_PROMPT);
    expect(memIdx).toBe(0);
    expect(memIdx).toBeLessThan(bridgeIdx);
    expect(bridgeIdx).toBeLessThan(skillIdx);
  });

  it("does not duplicate the memory prompt text", () => {
    const combined = buildCombinedReviewPrompt();
    expect(combined.split(MEMORY_REVIEW_PROMPT)).toHaveLength(2);
  });
});

describe("selectReviewPrompt", () => {
  it("returns the memory prompt when only memory is due", () => {
    expect(selectReviewPrompt({ memoryDue: true, skillDue: false }, true)).toBe(
      MEMORY_REVIEW_PROMPT,
    );
  });
  it("returns the skill-only prompt (no memory tool line) when only skills are due and memory is unavailable", () => {
    expect(selectReviewPrompt({ memoryDue: false, skillDue: true }, false)).toBe(
      buildSkillReviewPrompt(false),
    );
  });
  it("returns the skill prompt WITH the memory tool line when only skills are due but memory is available (enabled, just not due yet)", () => {
    expect(selectReviewPrompt({ memoryDue: false, skillDue: true }, true)).toBe(
      buildSkillReviewPrompt(true),
    );
  });
  it("returns the combined prompt when both are due", () => {
    expect(selectReviewPrompt({ memoryDue: true, skillDue: true }, true)).toBe(
      buildCombinedReviewPrompt(),
    );
  });
  it("returns null when nothing is due", () => {
    expect(selectReviewPrompt({ memoryDue: false, skillDue: false }, false)).toBeNull();
  });
});
