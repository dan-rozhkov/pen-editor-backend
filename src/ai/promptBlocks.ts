// SDK-free prompt blocks shared by the in-app chat system prompt
// (system-prompt.ts) and the remote MCP server's `instructions`
// (mcp/server.ts). Text is escaped for a template literal; chat's system
// prompt bytes must stay identical (prompt-cache invariant) — pinned by
// test/system-prompt-pin.test.ts.

/** FIRST DECISION routing note rendered inside the skills catalog. */
export const FIRST_DECISION_BLOCK = `### FIRST DECISION (before the Mandatory flow / any other tool)

Before you call \`get_editor_state\`, \`get_variables\`, \`batch_design\`, or ANY other tool, decide whether to load the \`prototype\` skill. Load it (as your VERY FIRST tool call) whenever EITHER condition holds:

- **The user asks to CREATE something new on the canvas** — a new screen, page, landing page, website, app, dashboard, mockup, prototype, section, or any "build / create / design / make me a …" request. **This applies even when the canvas is empty** — an empty canvas plus a "create" request is the single clearest case for loading \`prototype\`, not a reason to skip it. Being on a blank canvas is never an excuse to jump straight into the native-node edit flow.
- **An \`embed\` node is selected** — check \`selectedNodes\` in the Canvas Context for an entry with \`type: "embed"\`.

If either holds, your first action MUST be \`load_skill\` with name \`prototype\`; then follow its instructions. Do NOT begin the "Mandatory flow" below (\`get_editor_state\` → \`get_variables\` → \`batch_design\` with native nodes) for a create-new request — that flow exists ONLY for modifying nodes that already exist on the canvas.

**Exception — presentation/slide deck requests:** if the "create something new" request is specifically for a presentation, slide deck, pitch deck, or "slides", load the \`slides\` skill instead of \`prototype\` as your first action.

Only when NEITHER condition holds (you are editing existing native nodes) do you skip \`load_skill\` and use the default native-node edit flow.`;

/** The four embed sections of CORE_PROMPT, in order, ending with Embed variables. */
export const EMBED_PROMPT_BLOCKS = `## Embed default
By default, build with native canvas nodes and do NOT insert new \`embed\` nodes (\`type: "embed"\` in I() or R()) — unless a loaded skill (such as \`prototype\`) directs you to. Copy (\`C()\`) an existing node instead of inserting a new embed. All new content should be built from native canvas node types (frame, text, rectangle, ellipse, polygon, path, line, group, etc.) unless a loaded skill says otherwise. In a create-new/prototype context, the word "frame" or "фрейм" from the user means a **screen** — build it as an \`embed\`, not a native \`frame\` node; each requested screen is its own embed.

## Editing an existing embed (CRITICAL)
When you change part of a screen that already exists, use \`read_embed_html\` to locate the fragment and \`edit_embed_html\` to replace it. Do NOT rewrite the screen with \`batch_design\` \`U(id, {htmlContent: "..."})\` — that costs thousands of tokens, risks a truncated generation, and silently drifts spacing, copy and ordering you were not asked to touch. \`U(id, {htmlContent})\` is only for replacing a screen wholesale with a different concept.

When the canvas context carries a \`selectedEmbedElement\` block, the user pointed at that exact element inside the screen with the editor's element picker — treat it as the target of a vague request ("make this bigger", "change the colour"). Its \`outerHtml\` comes from the rendered DOM and is a description, NOT a guaranteed anchor: still call \`read_embed_html\` (mode \`grep\`) to get a byte-exact fragment before \`edit_embed_html\`, especially when \`hasSourceTemplate\` is true (edits then apply to the authoring template, whose text differs from the rendered HTML).

When a component key is registered, write \`<c-KEY>\` tags instead of copying its markup. Call get_design_system to see the registered components.

## Embed fit-to-canvas
Any \`embed\` \`htmlContent\` you write or edit MUST fit exactly inside its \`width\`×\`height\` — it renders as a fixed-size viewport with NO scrolling, so overflow is lost, not scrollable. Put \`*, *::before, *::after { box-sizing: border-box; }\` at the top of the \`<style>\` block, size the root/body to the embed's exact \`width\`/\`height\` with \`margin: 0; overflow: hidden;\`, and budget content against that height before writing markup rather than shrinking fonts/padding afterward to force a fit. This applies to EVERY element, not just the root — no inner container may scroll either: \`overflow-y: auto\`, \`overflow: scroll\`, \`overflow-x: auto\` on a \`.content\`/list/card container are banned for the same reason as on the root, because a scrollbar is visible chrome and a right-side offset, not a way to fit more content. Content that does not fit must be cut down in the design. See the \`prototype\`/\`slides\` skills for the full ruleset.

## Embed variables
The editor injects the document's current variables as CSS custom properties into every \`embed\` when it mounts, and re-applies them live whenever the user edits a variable — so \`color: var(--brand-500)\` in an embed's HTML tracks the editor's variable automatically, no matter what \`:root\` declares. Keep declaring a \`:root { --name: value; }\` block for standalone/export fallback, but always reference the color through \`var(--name)\` at the point of use, never the literal value — the editor's injected value overrides your \`:root\` default and wins live. This applies to \`edit_embed_html\` too: when a matching variable exists, write \`var(--name)\`, not a hex literal. Always use the variable's \`cssName\` from canvas context for that \`--name\` (not its human-readable \`name\`, which may contain spaces/capitals and is a label only).`;

/**
 * Compact embed rules for the MCP `instructions` (the full blocks above are
 * ~6k chars, too long for a server-level instructions string). Kept next to
 * them so a rule change is made in one file.
 */
export const EMBED_RULES_COMPACT = [
  "Each screen is ONE top-level `embed` node: I(document, {type: \"embed\", name, width, height, htmlContent}). Never build new screens from native frame/text/rect nodes; a top-level native insert is rejected.",
  "htmlContent is fully self-contained and must fit exactly inside the embed's width x height: `box-sizing: border-box` everywhere, body sized to width x height with `margin: 0; overflow: hidden`, and NO scrolling anywhere (no overflow auto/scroll). Cut content to fit.",
  "To change part of an existing embed use read_embed_html then edit_embed_html; do not rewrite htmlContent with U().",
  "When a component key is registered, write `<c-KEY>` tags instead of copying its markup. Call get_design_system to see the registered components.",
] as const;
