import { describe, expect, it, beforeAll } from "vitest";
import {
  detectSkillCommand,
  getAllSkills,
  getSkill,
  loadSkills,
} from "../src/ai/skills.js";

describe("detectSkillCommand", () => {
  it("detects a valid skill command and extracts the user text", () => {
    const result = detectSkillCommand("/polish make the header tighter");
    expect(result).toEqual({
      skillName: "polish",
      userText: "make the header tighter",
    });
  });

  it("detects a command with no trailing text (empty userText)", () => {
    const result = detectSkillCommand("/audit");
    expect(result).toEqual({ skillName: "audit", userText: "" });
  });

  it("supports dashes and digits in skill names", () => {
    const result = detectSkillCommand("/teach-impeccable do it");
    expect(result).toEqual({
      skillName: "teach-impeccable",
      userText: "do it",
    });
  });

  it("still matches unknown command names (resolution happens later via getSkill)", () => {
    const result = detectSkillCommand("/no-such-skill hello");
    expect(result).toEqual({ skillName: "no-such-skill", userText: "hello" });
    expect(getSkill("no-such-skill")).toBeUndefined();
  });

  it("returns null for plain text without a slash", () => {
    expect(detectSkillCommand("make it pop")).toBeNull();
  });

  it("returns null for a slash followed by non-latin text (e.g. '/привет')", () => {
    expect(detectSkillCommand("/привет")).toBeNull();
  });

  it("returns null for a slash in the middle of the text", () => {
    expect(detectSkillCommand("see src/skills for details")).toBeNull();
  });

  it("returns null for a bare slash or a path-like string", () => {
    expect(detectSkillCommand("/")).toBeNull();
    expect(detectSkillCommand("/123abc")).toBeNull();
  });

  it("preserves multi-line user text after the command", () => {
    const result = detectSkillCommand("/polish line one\nline two");
    expect(result?.skillName).toBe("polish");
    expect(result?.userText).toBe("line one\nline two");
  });
});

describe("loadSkills / getSkill", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("loads the real skills from src/skills", () => {
    const skills = getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    const names = skills.map((s) => s.name);
    expect(names).toContain("polish");
  });

  it("parses frontmatter name/description/args", () => {
    const polish = getSkill("polish");
    expect(polish).toBeDefined();
    expect(polish!.name).toBe("polish");
    expect(polish!.description).toMatch(/quality pass/i);
    expect(polish!.args).toEqual([
      {
        name: "target",
        description: "The feature or area to polish (optional)",
        required: false,
      },
    ]);
  });

  it("strips frontmatter from content and keeps the body", () => {
    const polish = getSkill("polish")!;
    expect(polish.content).not.toContain("user-invokable");
    expect(polish.content).not.toContain("description:");
    expect(polish.content).toContain("final pass");
  });

  it("replaces {{ask_instruction}} placeholders in content", () => {
    for (const skill of getAllSkills()) {
      expect(skill.content).not.toContain("{{ask_instruction}}");
    }
  });

  it("returns undefined for unknown skills", () => {
    expect(getSkill("definitely-not-a-skill")).toBeUndefined();
  });
});
