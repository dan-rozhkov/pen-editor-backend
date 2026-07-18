import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("buildSystemPrompt — image tools", () => {
  it("documents the image generation tools in the core prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("generate_image");
    expect(prompt).toContain("generate_frame_image");
  });
});
