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
    expect(sha(buildSystemPrompt())).toBe("1ecd281424c4808cb9650e1c2463c42bb0a93c656cbb6e5f24bbd177192ca8d8");
  });
  it("with skill catalog (curated)", () => {
    expect(sha(buildSystemPrompt([SKILLS[0]]))).toBe("e441cae43f743cbe7eebf8c6e5abc61dd6284fa50fc00f7658498b1cc1261138");
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
    ).toBe("51766cda21cfc0bb50086c1b6589eb85d1b90af8550248b618ceb3a391988457");
  });
});
