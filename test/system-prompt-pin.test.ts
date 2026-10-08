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
    expect(sha(buildSystemPrompt())).toBe("7003b7a48fd778f2e649155fc4601dafded925fc8d9e95e265cdc104f4131afd");
  });
  it("with skill catalog (curated)", () => {
    expect(sha(buildSystemPrompt([SKILLS[0]]))).toBe("1edccee9e79eb3e4e5675ca1fcc154a66572a1eb86f224ce14bc3bbd65a701df");
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
    ).toBe("2ebffe35280828202001efb4e4b2792d91d66e01f86717ca77f4ccdea9a87127");
  });
});
