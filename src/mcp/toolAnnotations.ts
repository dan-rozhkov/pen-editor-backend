import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { BRIDGED_TOOL_NAMES, SKILL_TOOL_NAMES, STATIC_TOOL_NAMES } from "./toolNames.js";

// One table for every tool the MCP servers register (OpenAI app review needs
// correct annotations). Typed as an exhaustive Record, so a new tool name added
// to toolNames.ts without an entry here fails the build; the tests also check
// the live tools/list. Every tool acts only on the user's own canvas or on
// static guides, hence openWorldHint false throughout.

export const WIDGET_TOOL_NAMES = ["open_canvas", "sideform_bridge_ticket"] as const;

export type McpToolName =
  | (typeof BRIDGED_TOOL_NAMES)[number]
  | (typeof STATIC_TOOL_NAMES)[number]
  | (typeof SKILL_TOOL_NAMES)[number]
  | (typeof WIDGET_TOOL_NAMES)[number];

interface ToolMeta {
  title: string;
  annotations: ToolAnnotations;
}

const read = (title: string): ToolMeta => ({ title, annotations: { readOnlyHint: true, openWorldHint: false } });
const write = (title: string, destructiveHint: boolean): ToolMeta => ({
  title,
  annotations: { readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint: false },
});

export const TOOL_META: Record<McpToolName, ToolMeta> = {
  get_editor_state: read("Get editor state"),
  batch_get: read("Read nodes"),
  snapshot_layout: read("Snapshot layout"),
  get_variables: read("Get design variables"),
  get_screenshot: read("Take screenshot"),
  read_comments: read("Read comments"),
  read_embed_html: read("Read embed HTML"),
  find_empty_space_on_canvas: read("Find empty canvas space"),
  get_guidelines: read("Get design guidelines"),
  get_style_guide_tags: read("List style guide tags"),
  get_style_guide: read("Get style guide"),
  list_skills: read("List skills"),
  load_skill: read("Load skill"),
  open_canvas: read("Open Sideform canvas"),
  sideform_bridge_ticket: read("Refresh canvas connection"),
  batch_design: write("Edit design", true),
  set_variables: write("Set design variables", true),
  edit_embed_html: write("Edit embed HTML", false),
  rename_layers: write("Rename layers", false),
  reply_comment: write("Reply to comment", false),
  resolve_comment: write("Resolve comment", false),
  leave_comment: write("Leave comments", false),
};

/** `title` + `annotations` to spread into a tool's registration config. */
export const toolMeta = (name: McpToolName): ToolMeta => TOOL_META[name];
