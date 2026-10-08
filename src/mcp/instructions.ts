import { EMBED_RULES_COMPACT } from "../ai/promptBlocks.js";

// Server-level `instructions` sent in the MCP initialize result (remote /mcp
// and legacy /api/mcp share buildMcpServer). Mirrors what the in-app chat
// agent is told (src/ai/promptBlocks.ts) minus the tools this server lacks.
export function buildMcpInstructions(opts: { hasCanvasWidget: boolean; appOrigin?: string }): string {
  const editorNote =
    `Design tools act on the user's open, signed-in Sideform editor tab${opts.appOrigin ? ` (${opts.appOrigin}/app)` : ""}; ` +
    "if a tool reports no editor is open, ask the user to open it.";
  return [
  "You are designing in Sideform, a canvas design editor.",
  "For any NEW screen, page, landing page or app flow, call load_skill(\"prototype\") FIRST and follow it (decks: load_skill(\"slides\")).",
  opts.hasCanvasWidget ? `On clients that display apps, call open_canvas first. ${editorNote}` : editorNote,
  ...EMBED_RULES_COMPACT,
  "Before you design or edit, call get_design_system. It returns the tokens and components of the document. Use its tokens and components instead of raw values.",
  "Use native nodes only to edit existing native designs: call get_editor_state, get_variables and batch_get first, then insert into existing frames.",
  "Skills may mention tools this server lacks (ask_user, generate_image, web or design research). They are unavailable: ask the user in plain conversation if your client allows, otherwise choose sensible defaults yourself; use picsum for photos; skip research steps.",
  ].join("\n\n");
}
