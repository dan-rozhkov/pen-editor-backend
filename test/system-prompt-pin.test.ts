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
    expect(sha(buildSystemPrompt())).toBe("cb4f794372e81ea5adf2f20797b8811d3e1c3093da4707f028bf4cb0586fcc4e");
  });
  it("with skill catalog (curated)", () => {
    expect(sha(buildSystemPrompt([SKILLS[0]]))).toBe("650e0aa9e9e5af8e1162b723438f54622bd50458bb43492c813a8ccaf96d845b");
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
    ).toBe("ead0dbcb1f38d7d5eb9ff4293f318f99b9af96bb163087d0473fbd57fabf6a75");
  });
});
