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
    expect(sha(buildSystemPrompt())).toBe("463dcccf2d86d05f5415d00a0f43eaeb00db4d19bbb616af99272e637bfcd102");
  });
  it("with skill catalog (curated)", () => {
    expect(sha(buildSystemPrompt([SKILLS[0]]))).toBe("55a208e05373d653b36a5844cd1bfe67bf18885923ea0d9eed22725c3481fc70");
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
    ).toBe("c3439ada433264eb8723bb669c0317d01329c4568a570e41932c789ae91973e9");
  });
});
