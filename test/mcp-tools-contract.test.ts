import { describe, expect, it } from "vitest";
import { BRIDGED_TOOL_NAMES, STATIC_TOOL_NAMES } from "../src/mcp/server.js";
import { penTools } from "../src/ai/tools.js";

// Contract: the curated MCP tool set is locked here (mirrors
// test/tools-contract.test.ts's convention of a hardcoded name list). The
// frontend's toolContract.test.ts pins the same bridged names on its side —
// update both together when the MCP surface changes.
const EXPECTED_BRIDGED = [
  "get_editor_state",
  "batch_get",
  "snapshot_layout",
  "get_variables",
  "get_screenshot",
  "batch_design",
  "set_variables",
];

const EXPECTED_STATIC = ["get_guidelines", "get_style_guide_tags", "get_style_guide"];

describe("MCP bridged/static tool contract", () => {
  it("bridges exactly the curated v1 tool set", () => {
    expect([...BRIDGED_TOOL_NAMES].sort()).toEqual([...EXPECTED_BRIDGED].sort());
  });

  it("static tools match the curated v1 set", () => {
    expect([...STATIC_TOOL_NAMES].sort()).toEqual([...EXPECTED_STATIC].sort());
  });

  it("every static MCP tool is server-executed in penTools", () => {
    for (const name of STATIC_TOOL_NAMES) {
      const tool = (penTools as Record<string, { execute?: unknown }>)[name];
      expect(typeof tool?.execute, name).toBe("function");
    }
  });

  it("every bridged MCP tool has a matching penTools schema", () => {
    for (const name of BRIDGED_TOOL_NAMES) {
      expect(name in penTools, name).toBe(true);
    }
  });
});
