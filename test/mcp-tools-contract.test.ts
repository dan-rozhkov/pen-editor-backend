import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BRIDGED_TOOL_NAMES, SKILL_TOOL_NAMES, STATIC_TOOL_NAMES, buildMcpServer } from "../src/mcp/server.js";
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
  "read_comments",
  "reply_comment",
  "resolve_comment",
  "leave_comment",
  "read_embed_html",
  "edit_embed_html",
  "rename_layers",
  "find_empty_space_on_canvas",
];

const EXPECTED_STATIC = ["get_guidelines", "get_style_guide_tags", "get_style_guide"];

const EXPECTED_SKILL_TOOLS = ["list_skills", "load_skill"];

// registerTool stores tools on a private field of the underlying low-level
// Server; the SDK doesn't expose a public "list registered tool names"
// accessor, so reach through the same internal map the SDK itself populates
// (`_registeredTools`) rather than driving a full request/response round
// trip just to assert on names.
function registeredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

describe("MCP bridged/static tool contract", () => {
  it("bridges exactly the curated v1 tool set", () => {
    expect([...BRIDGED_TOOL_NAMES].sort()).toEqual([...EXPECTED_BRIDGED].sort());
  });

  it("static tools match the curated v1 set", () => {
    expect([...STATIC_TOOL_NAMES].sort()).toEqual([...EXPECTED_STATIC].sort());
  });

  it("skill tools match the curated set", () => {
    expect([...SKILL_TOOL_NAMES].sort()).toEqual([...EXPECTED_SKILL_TOOLS].sort());
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

  it("registers every bridged, static, and skill tool on the built server", () => {
    const server = buildMcpServer();
    const registered = registeredToolNames(server);
    for (const name of [...BRIDGED_TOOL_NAMES, ...STATIC_TOOL_NAMES, ...SKILL_TOOL_NAMES]) {
      expect(registered, name).toContain(name);
    }
  });

  it("skill tool names are not penTools entries (they have no cross-repo schema)", () => {
    for (const name of SKILL_TOOL_NAMES) {
      expect(name in penTools, name).toBe(false);
    }
  });
});
