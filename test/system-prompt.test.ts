import { describe, expect, it } from "vitest";
import { AGENT_MODES, buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("AGENT_MODES", () => {
  it("declares exactly the three known modes", () => {
    expect(AGENT_MODES).toEqual(["edits", "prototype", "research"]);
  });
});

describe("buildSystemPrompt", () => {
  it("defaults to edits mode", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Agent Mode: edits");
    expect(prompt).not.toContain("Agent Mode: prototype");
  });

  it("edits mode includes the core prompt and edits instructions", () => {
    const prompt = buildSystemPrompt(undefined, "edits");
    expect(prompt).toContain("expert design agent for the Pencil editor");
    expect(prompt).toContain("Agent Mode: edits");
  });

  it("prototype mode includes the core prompt and prototype instructions", () => {
    const prompt = buildSystemPrompt(undefined, "prototype");
    expect(prompt).toContain("expert design agent for the Pencil editor");
    expect(prompt).toContain("Agent Mode: prototype");
    expect(prompt).not.toContain("Agent Mode: edits");
  });

  it("research mode uses a standalone research prompt without the core prompt", () => {
    const prompt = buildSystemPrompt(undefined, "research");
    expect(prompt).toContain("design research agent");
    expect(prompt).not.toContain("expert design agent for the Pencil editor");
    expect(prompt).not.toContain("Agent Mode: edits");
  });

  it("appends canvas context in edits/prototype modes", () => {
    for (const mode of ["edits", "prototype"] as const) {
      const prompt = buildSystemPrompt("<canvas state here>", mode);
      expect(prompt).toContain("## Current Canvas Context");
      expect(prompt).toContain("<canvas state here>");
      // Canvas context comes after the mode instructions.
      expect(prompt.indexOf("## Current Canvas Context")).toBeGreaterThan(
        prompt.indexOf(`Agent Mode: ${mode}`),
      );
    }
  });

  it("appends canvas context in research mode", () => {
    const prompt = buildSystemPrompt("research canvas ctx", "research");
    expect(prompt).toContain("## Current Canvas Context");
    expect(prompt).toContain("research canvas ctx");
  });

  it("omits the canvas context section when no context is given", () => {
    for (const mode of AGENT_MODES) {
      expect(buildSystemPrompt(undefined, mode)).not.toContain(
        "## Current Canvas Context",
      );
    }
  });
});
