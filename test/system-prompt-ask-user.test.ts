import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("system prompt: ask_user guidance", () => {
  it("instructs the agent to ask_user before creating new content", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("ask_user");
    expect(prompt.toLowerCase()).toContain("before you create");
  });
});
