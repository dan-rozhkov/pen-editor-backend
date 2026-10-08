import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/ai/system-prompt.js";

// Pins the full system prompt bytes (prompt-cache invariant). Any intentional
// prompt change must update these hashes deliberately.
const SKILLS = [
  { name: "prototype", description: "Build screens." },
  { name: "slides", description: "Build decks.", learned: true },
  { name: "mine", description: "Custom one.", custom: true },
];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("buildSystemPrompt byte pin", () => {
  it("core only", () => {
    expect(sha(buildSystemPrompt())).toBe("1f1485b7eadc7ba9cd3c2335e2d3b9b5dc88e12432ff083b5c3e7177123f979e");
  });
  it("with skill catalog (curated)", () => {
    expect(sha(buildSystemPrompt([SKILLS[0]]))).toBe("6bacb79e45fd777e7c675f39a8150f2b7a3c396d7f76404674c31509b18443f9");
  });
  it("with learned + custom skills and all optional blocks", () => {
    expect(
      sha(
        buildSystemPrompt(SKILLS, {
          memoryGuidance: true,
          selfSkillsGuidance: true,
          memorySnapshot: "SNAP",
          canvasContextDelivered: true,
        }),
      ),
    ).toBe("7a61d01b47df938752999f86d6962400ae1d2d30cfc2ba4436038de55e764ed1");
  });
});
