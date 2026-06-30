import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("system prompt image guidance", () => {
  it("documents both image tools in the default (edits) prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("generate_image");
    expect(prompt).toContain("generate_frame_image");
  });

  it("documents the image tools in prototype mode too", () => {
    const prompt = buildSystemPrompt(undefined, "prototype");
    expect(prompt).toContain("generate_frame_image");
  });
});
