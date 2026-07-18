import { describe, it, expect } from "vitest";
import { AGENT_MODES, buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("AGENT_MODES", () => {
  it("remains exported for legacy request-body validation", () => {
    expect(AGENT_MODES).toEqual(["edits", "prototype", "research"]);
  });
});

describe("buildSystemPrompt", () => {
  it("always returns the core prompt (no mode branching)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("expert design agent for the Pencil editor");
    // Mode-specific prompt blocks no longer live in the system prompt.
    expect(prompt).not.toContain("## Agent Mode: prototype");
    expect(prompt).not.toContain("You are in PROTOTYPE mode");
  });

  it("carries the edits-flow rules that used to live in EDITS_MODE_PROMPT", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("get_variables");
    // Default behaviour still forbids inserting embeds unless a skill directs it.
    expect(prompt.toLowerCase()).toContain("embed");
  });

  it("renders a skill catalog when skills are provided", () => {
    const prompt = buildSystemPrompt(undefined, [
      { name: "prototype", description: "Build a mockup." },
      { name: "polish", description: "Final visual pass." },
    ]);
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("prototype");
    expect(prompt).toContain("Build a mockup.");
    expect(prompt).toContain("polish");
  });

  it("includes the prototype routing rule", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('type: "embed"');
    expect(prompt.toLowerCase()).toContain("create");
  });

  it("omits the catalog section when no skills are provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Available Skills");
  });

  it("appends canvas context after the core prompt", () => {
    const prompt = buildSystemPrompt("<canvas state here>");
    expect(prompt).toContain("## Current Canvas Context");
    expect(prompt).toContain("<canvas state here>");
  });
});
