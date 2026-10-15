import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  BROWSE_AGENT_PROMPT,
  MANUAL_BROWSER_GUIDANCE,
  SUBAGENT_BROWSER_GUIDANCE,
} from "../src/ai/system-prompt.js";
import { penTools } from "../src/ai/tools.js";
import golden from "./fixtures/browse-agent-text.golden.json" with { type: "json" };

// The golden file was dumped from the code at git HEAD a077a85, BEFORE the
// browse prompt text and tool definitions moved to @sideform/browser-agent/agent.
// The package, fed Pen Editor's slots (src/ai/browseToolText.ts), must give
// those strings back byte for byte: a changed byte here is a prompt-cache break.

describe("browse prompts: byte identity with the pre-package text", () => {
  it("MANUAL_BROWSER_GUIDANCE", () => {
    expect(MANUAL_BROWSER_GUIDANCE).toBe(golden.MANUAL_BROWSER_GUIDANCE);
  });
  it("SUBAGENT_BROWSER_GUIDANCE", () => {
    expect(SUBAGENT_BROWSER_GUIDANCE).toBe(golden.SUBAGENT_BROWSER_GUIDANCE);
  });
  it("BROWSE_AGENT_PROMPT", () => {
    expect(BROWSE_AGENT_PROMPT).toBe(golden.BROWSE_AGENT_PROMPT);
  });
});

describe("browse tools: byte identity with the pre-package definitions", () => {
  const names = Object.keys(golden.tools) as (keyof typeof golden.tools)[];

  it("covers the seven tools", () => {
    expect(names).toHaveLength(7);
  });

  it.each(names)("%s description", (name) => {
    expect(penTools[name].description).toBe(golden.tools[name].description);
  });

  it.each(names)("%s JSON schema", (name) => {
    const json = asSchema(penTools[name].inputSchema).jsonSchema;
    expect(JSON.stringify(json)).toBe(JSON.stringify(golden.tools[name].jsonSchema));
  });
});
