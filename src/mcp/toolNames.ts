// Name lists split out of server.ts into their own module so
// skillSurface.ts (which needs the MCP surface's tool names to flag skills
// that reference tools outside it) can import them without a circular
// dependency on server.ts, which in turn imports skillSurface.ts. server.ts
// re-exports these unchanged, so `import { BRIDGED_TOOL_NAMES } from
// "./server.js"` (used by existing tests) keeps working.

// Single source of truth for which tools are bridged to the browser tab vs.
// executed directly on the server — cross-checked by
// test/mcp-tools-contract.test.ts (backend) and pen-editor's
// toolContract.test.ts (frontend).
export const BRIDGED_TOOL_NAMES = [
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
] as const;

export const STATIC_TOOL_NAMES = ["get_guidelines", "get_style_guide_tags", "get_style_guide"] as const;

// Skill tools are backend-executed like STATIC_TOOL_NAMES, but deliberately
// NOT part of it: STATIC_TOOL_NAMES is, by contract (see
// test/mcp-tools-contract.test.ts), exactly the set of penTools entries with
// a server-side `execute` — skills aren't penTools entries at all, they live
// in src/ai/skills.ts (getSkillTools) and are injected into a chat turn
// separately from the pen-tool schema. Listing them here, alongside their own
// name list, keeps that distinction visible instead of stretching
// STATIC_TOOL_NAMES's meaning to cover a second, unrelated source.
//
// Only the CURATED catalog (src/skills/*.md) is exposed here. Learned
// (agent_skills) and user (user_skills) skills both need a userId/DB-backed
// identity that an MCP session — authenticated by one shared bearer token,
// see src/mcp/auth.ts — simply doesn't have.
export const SKILL_TOOL_NAMES = ["list_skills", "load_skill"] as const;
