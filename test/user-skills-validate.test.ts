import { describe, expect, it } from "vitest";
import {
  checkUserSkillCap,
  checkUserSkillNameCollision,
  MAX_BODY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILLS_PER_USER,
  parseUserSkillMarkdown,
  validateUserSkillBody,
  validateUserSkillDescription,
  validateUserSkillName,
} from "../src/ai/skills/validateUserSkill.js";

describe("validateUserSkillName", () => {
  it("accepts lowercase letters, digits and hyphens starting with a letter", () => {
    expect(validateUserSkillName("my-skill")).toBeNull();
    expect(validateUserSkillName("skill2")).toBeNull();
    expect(validateUserSkillName("ab")).toBeNull();
  });

  it("rejects empty, uppercase, leading digit/hyphen, and underscores", () => {
    for (const bad of ["", "My-Skill", "1st-thing", "-leading", "with_underscore", "with space", "a"]) {
      expect(validateUserSkillName(bad), `expected "${bad}" to be rejected`).not.toBeNull();
    }
  });

  it("rejects a name over 50 characters", () => {
    const tooLong = "a" + "b".repeat(49); // 50 chars total, one over the {1,48} tail budget
    expect(validateUserSkillName(tooLong)).not.toBeNull();
  });
});

describe("validateUserSkillDescription", () => {
  it("allows an empty description", () => {
    expect(validateUserSkillDescription("")).toBeNull();
  });

  it("accepts a description of exactly MAX_DESCRIPTION_CHARS chars", () => {
    expect(validateUserSkillDescription("x".repeat(MAX_DESCRIPTION_CHARS))).toBeNull();
  });

  it("rejects a description one char over the limit", () => {
    const err = validateUserSkillDescription("x".repeat(MAX_DESCRIPTION_CHARS + 1));
    expect(err).not.toBeNull();
    expect(err).toContain(String(MAX_DESCRIPTION_CHARS));
  });

  it("rejects a multi-line description", () => {
    expect(validateUserSkillDescription("line one\nline two")).not.toBeNull();
  });
});

describe("validateUserSkillBody", () => {
  it("rejects empty body", () => {
    expect(validateUserSkillBody("")).not.toBeNull();
  });

  it("accepts a normal body", () => {
    expect(validateUserSkillBody("# Title\nDo the thing.")).toBeNull();
  });

  it("accepts a body of exactly MAX_BODY_CHARS chars", () => {
    expect(validateUserSkillBody("a".repeat(MAX_BODY_CHARS))).toBeNull();
  });

  it("rejects a body one char over the limit", () => {
    const err = validateUserSkillBody("a".repeat(MAX_BODY_CHARS + 1));
    expect(err).not.toBeNull();
    expect(err).toContain(String(MAX_BODY_CHARS));
  });
});

describe("checkUserSkillNameCollision", () => {
  const known = { curatedNames: ["prototype", "slides"], toolNames: ["batch_design", "ask_user"] };

  it("rejects a curated name (git-owned message)", () => {
    expect(checkUserSkillNameCollision("prototype", known)).toContain("git-owned");
  });

  it("rejects a penTools name", () => {
    expect(checkUserSkillNameCollision("batch_design", known)).toContain("tool");
  });

  it("allows a free name", () => {
    expect(checkUserSkillNameCollision("my-own-skill", known)).toBeNull();
  });
});

describe("checkUserSkillCap", () => {
  it("allows creation under the cap", () => {
    expect(checkUserSkillCap(MAX_SKILLS_PER_USER - 1)).toBeNull();
  });

  it("blocks creation at or over the cap", () => {
    expect(checkUserSkillCap(MAX_SKILLS_PER_USER)).not.toBeNull();
    expect(checkUserSkillCap(MAX_SKILLS_PER_USER + 1)).not.toBeNull();
  });
});

describe("parseUserSkillMarkdown", () => {
  it("extracts name/description/body from frontmatter", () => {
    const raw = "---\nname: my-skill\ndescription: does a thing\n---\n# Body\nInstructions here.";
    const parsed = parseUserSkillMarkdown(raw);
    expect(parsed).toEqual({
      name: "my-skill",
      description: "does a thing",
      body: "# Body\nInstructions here.",
    });
  });

  it("treats the whole input as body with no name/description when frontmatter is absent", () => {
    const raw = "# Just a body\nNo frontmatter here.";
    const parsed = parseUserSkillMarkdown(raw);
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe(raw);
  });
});
