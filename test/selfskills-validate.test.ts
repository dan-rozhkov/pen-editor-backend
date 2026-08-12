import { describe, expect, it } from "vitest";
import {
  applyPatch,
  checkNameCollision,
  MAX_BODY_LINES,
  MAX_DESCRIPTION_CHARS,
  validateBody,
  validateDescription,
  validateSkillName,
} from "../src/ai/skills/validate.js";

describe("validateSkillName", () => {
  it("accepts kebab-case", () => {
    expect(validateSkillName("reading-canvas-state")).toBeNull();
    expect(validateSkillName("layout")).toBeNull();
    expect(validateSkillName("fix-v2-embeds")).toBeNull();
  });

  it("rejects non-kebab-case forms", () => {
    for (const bad of [
      "Reading-Canvas",
      "reading_canvas",
      "-leading",
      "trailing-",
      "double--dash",
      "1st-thing",
      "with space",
      "",
    ]) {
      expect(validateSkillName(bad), `expected "${bad}" to be rejected`).not.toBeNull();
    }
  });

  // Boundary table: MAX_NAME_CHARS is 64, so 64 must pass and 65 must fail —
  // this is the exact off-by-one the spec locks, not an approximation.
  it.each([
    { chars: 64, shouldPass: true },
    { chars: 65, shouldPass: false },
  ])("name of $chars chars: shouldPass=$shouldPass", ({ chars, shouldPass }) => {
    // Build a valid kebab-case name of exactly `chars` length so the only
    // variable under test is length, not kebab-case shape.
    const name = "a".repeat(chars);
    const err = validateSkillName(name);
    if (shouldPass) {
      expect(err).toBeNull();
    } else {
      expect(err).not.toBeNull();
      expect(err).toContain("1-64");
    }
  });
});

describe("validateDescription", () => {
  // Boundary table for MAX_DESCRIPTION_CHARS (60): exactly at the limit must
  // pass (create-time enforcement is "<=", not "<"), one over must fail and
  // the error must report both the limit and the actual length so the model
  // can fix it without guessing.
  it.each([
    { chars: MAX_DESCRIPTION_CHARS, shouldPass: true },
    { chars: MAX_DESCRIPTION_CHARS + 1, shouldPass: false },
  ])("description of $chars chars: shouldPass=$shouldPass", ({ chars, shouldPass }) => {
    const description = "x".repeat(chars);
    const err = validateDescription(description);
    if (shouldPass) {
      expect(err).toBeNull();
    } else {
      expect(err).not.toBeNull();
      expect(err).toContain(String(MAX_DESCRIPTION_CHARS));
      expect(err).toContain(String(chars));
    }
  });

  it("rejects empty/whitespace", () => {
    expect(validateDescription("")).not.toBeNull();
    expect(validateDescription("   ")).not.toBeNull();
  });
});

describe("validateBody", () => {
  // Boundary table for MAX_BODY_LINES (200), enforced both on create and on
  // the post-patch result per the locked contract — this validator is the
  // single check both call sites share, so the table is the contract test.
  it.each([
    { lines: MAX_BODY_LINES, shouldPass: true },
    { lines: MAX_BODY_LINES + 1, shouldPass: false },
  ])("body of $lines lines: shouldPass=$shouldPass", ({ lines, shouldPass }) => {
    const body = Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");
    const err = validateBody(body);
    if (shouldPass) {
      expect(err).toBeNull();
    } else {
      expect(err).not.toBeNull();
      expect(err).toContain(String(MAX_BODY_LINES));
      expect(err).toContain(String(lines));
    }
  });

  it("rejects empty/whitespace", () => {
    expect(validateBody("")).not.toBeNull();
    expect(validateBody("\n\n")).not.toBeNull();
  });
});

describe("checkNameCollision", () => {
  const known = { curatedNames: ["prototype", "slides"], toolNames: ["batch_design", "ask_user"] };

  it("rejects a curated name and says the file is git-owned", () => {
    const err = checkNameCollision("prototype", known);
    expect(err).toContain("git-owned");
    expect(err).toContain("src/skills/prototype.md");
  });

  it("rejects a penTools name", () => {
    expect(checkNameCollision("batch_design", known)).toContain("tool");
  });

  it("allows a free name", () => {
    expect(checkNameCollision("reading-canvas-state", known)).toBeNull();
  });
});

describe("applyPatch", () => {
  it("replaces a unique occurrence", () => {
    expect(applyPatch("alpha\nbeta\ngamma", "beta", "BETA")).toEqual({ body: "alpha\nBETA\ngamma" });
  });

  it("errors when old_string is absent", () => {
    const result = applyPatch("alpha", "delta", "x") as { error: string };
    expect(result.error).toContain("not found");
  });

  it("errors when old_string occurs twice", () => {
    const result = applyPatch("a\na", "a", "b") as { error: string };
    expect(result.error).toContain("more than once");
  });

  // Finding 9: the second search used to start at `first + oldString.length`,
  // which skips past any OVERLAPPING second occurrence — for body "aaa" and
  // oldString "aa", the second "aa" starts at index 1, inside the first
  // match, and the old scan (starting at index 2) would never see it. That
  // let an ambiguous patch through as if old_string were unique.
  it("errors on an overlapping second occurrence ('aaa' / 'aa')", () => {
    const result = applyPatch("aaa", "aa", "X") as { error: string };
    expect(result.error).toContain("more than once");
  });

  it("errors on an overlapping second occurrence ('----' / '--')", () => {
    const result = applyPatch("----", "--", "X") as { error: string };
    expect(result.error).toContain("more than once");
  });

  it("errors on an overlapping second occurrence ('\\n\\n\\n' / '\\n\\n')", () => {
    const result = applyPatch("\n\n\n", "\n\n", "X") as { error: string };
    expect(result.error).toContain("more than once");
  });

  it("errors on an empty old_string", () => {
    const result = applyPatch("a", "", "b") as { error: string };
    expect(result.error).toContain("must not be empty");
  });
});
