import { tool } from "ai";
import { z } from "zod";

const MAX_BATCH_DESIGN_OPERATIONS = 25;

// Mirrors splitOperationLines in the frontend parser
// (pen-editor/src/lib/tools/batchDesign/parser.ts): a newline ends a statement
// only at top level — outside strings and unbalanced (), {}, [] — so a
// multi-line value (e.g. htmlContent) still counts as one operation. Wrapper/fence
// noise lines (stray <operations>/<batch_design> tags or ``` code fences a model
// sometimes emits around the script) are stripped at the edges and skipped in the
// interior, matching isWrapperNoiseLine/stripWrapperNoiseLines in the frontend
// parser, so a near-limit wrapped batch isn't over-counted and wrongly rejected here.

// A line is pure wrapper/fence noise (a stray tag or Markdown code fence a model
// sometimes emits around the script). Mirrors isWrapperNoiseLine in the frontend
// parser (pen-editor/src/lib/tools/batchDesign/parser.ts). Matches only when the
// ENTIRE trimmed line is noise — never a substring inside a real operation.
function isWrapperNoiseLine(raw: string): boolean {
  if (/^(`{3,}|~{3,})[\w-]*$/.test(raw)) return true;
  if (/^<\/?\s*(operations|batch_design)\s*\/?>$/i.test(raw)) return true;
  return false;
}

// Blank out contiguous wrapper/fence noise at the top and bottom edges of the
// input before counting, so a wrapped script isn't over-counted. Mirrors
// stripWrapperNoiseLines in the frontend parser. Edge-only so a lone `<script>`
// or ``` line inside a string value (e.g. htmlContent) is never touched.
function stripWrapperNoiseLines(input: string): string {
  const lines = input.split("\n");
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && isWrapperNoiseLine(lines[start].trim())) {
    lines[start] = "";
    start++;
  }
  while (end >= start && isWrapperNoiseLine(lines[end].trim())) {
    lines[end] = "";
    end--;
  }
  return lines.join("\n");
}

function countBatchDesignOperations(operations: string): number {
  operations = stripWrapperNoiseLines(operations);
  let count = 0;
  let current = "";
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = false;
  let stringDelimiter: '"' | "'" | "`" | null = null;

  const countStatement = (text: string) => {
    const trimmed = text.trim();
    if (
      trimmed &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("#") &&
      !isWrapperNoiseLine(trimmed)
    ) {
      count++;
    }
  };

  for (const ch of operations) {
    current += ch;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (stringDelimiter) {
      if (ch === stringDelimiter) stringDelimiter = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringDelimiter = ch;
      continue;
    }

    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;

    if (
      ch === "\n" &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      countStatement(current);
      current = "";
    }
  }

  countStatement(current);
  return count;
}

const batchDesignInputSchema = z
  .object({
    operations: z.string().optional(),
    // Compatibility aliases for models that occasionally emit wrong key names.
    design: z.string().optional(),
    script: z.string().optional(),
    batch: z.string().optional(),
  })
  .transform((input, ctx) => {
    const operations = input.operations ?? input.design ?? input.script ?? input.batch;

    if (!operations || !operations.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Required string field "operations" is missing or empty.',
        path: ["operations"],
      });
      return z.NEVER;
    }

    const operationCount = countBatchDesignOperations(operations);
    if (operationCount > MAX_BATCH_DESIGN_OPERATIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Too many operations (${operationCount}). Maximum is ${MAX_BATCH_DESIGN_OPERATIONS}. ` +
          `Split the work into multiple sequential batch_design calls.`,
        path: ["operations"],
      });
      return z.NEVER;
    }

    return { operations };
  });

export const penTools = {
  // ── Reading & Navigation ──────────────────────────────────────────

  get_editor_state: tool({
    description:
      "Get the current editor state including active .pen file, user selection, top-level nodes, and available components. Reusable components are native `frame` nodes with `reusable: true` — NOT embed nodes. They are returned under `reusableComponents` (id, name, a synced HTML snapshot for readability, syncState) and `documentComponents` (tag-based reuse). Never recreate a listed component with fresh frame/rect/text nodes — instead insert a `ref` node with `componentId` pointing at it. See `batch_design`'s Component Usage section for how to declare variant/boolean/text properties on a component and switch them on instances.",
    inputSchema: z.object({
      include_schema: z
        .boolean()
        .describe(
          "Whether to include the .pen file schema in the response. Set true if you need to understand the node format.",
        ),
    }),
  }),

  batch_get: tool({
    description:
      "Retrieve nodes by searching for matching patterns or by reading specific node IDs. Supports flexible tree traversal with depth control. Use this to inspect node structure before modifying. Note: reusable components are native frame nodes — search with type: \"frame\" and check the `reusable` flag (and `properties`, if it declares variants) to find them; `type: \"ref\"` finds component instances.",
    inputSchema: z.object({
      patterns: z
        .array(
          z.object({
            type: z
              .enum([
                "frame",
                "group",
                "rectangle",
                "ellipse",
                "line",
                "polygon",
                "path",
                "text",
                "embed",
                "ref",
                "connector",
              ])
              .optional()
              .describe("Only return nodes with this type"),
            name: z
              .string()
              .optional()
              .describe(
                "Only return nodes whose name matches this regex pattern",
              ),
          }),
        )
        .optional()
        .describe("Search patterns to match nodes"),
      nodeIds: z
        .array(z.string())
        .optional()
        .describe("Specific node IDs to read"),
      parentId: z
        .string()
        .optional()
        .describe("Parent node ID to limit search scope"),
      readDepth: z
        .number()
        .optional()
        .describe(
          "How deep to read children (default 1). Nodes beyond this depth show as '...'.",
        ),
      searchDepth: z
        .number()
        .optional()
        .describe("How deep to search in the node tree. Unlimited if omitted."),
      resolveVariables: z
        .boolean()
        .optional()
        .describe(
          "If true, variable references are resolved to their current values.",
        ),
      includePathGeometry: z
        .boolean()
        .optional()
        .describe("If true, include full SVG path geometry data."),
    }),
  }),

  snapshot_layout: tool({
    description:
      "Get computed layout rectangles (positions and sizes after the layout engine runs). Use this to understand where elements actually appear on screen, check for overlapping/clipped elements, and find space for new content.",
    inputSchema: z.object({
      parentId: z
        .string()
        .optional()
        .describe(
          "Subtree root to inspect. Omit for the whole document.",
        ),
      maxDepth: z
        .number()
        .optional()
        .describe(
          "Depth limit for traversal. Default is direct children only. Be careful with large values.",
        ),
      problemsOnly: z
        .boolean()
        .optional()
        .describe(
          "If true, only return nodes with layout problems (clipping, overflow).",
        ),
    }),
  }),

  // get_screenshot is intentionally disabled: the agent has no visual-verification
  // tool. Do not re-enable without a product decision (see plans/002).
  // get_screenshot: tool({
  //   description:
  //     "Take a screenshot of a specific node for visual verification. Use this after making changes to confirm they look correct. Returns an image.",
  //   inputSchema: z.object({
  //     nodeId: z.string().describe("The ID of the node to screenshot."),
  //   }),
  // }),

  get_variables: tool({
    description:
      "Read all design variables (tokens) and themes defined in the .pen file. Variables can be colors, numbers, strings, or booleans, and may have different values per theme.",
    inputSchema: z.object({}),
  }),

  // ── Modification ──────────────────────────────────────────────────

  batch_design: tool({
    description: `Execute batch operations on the .pen node tree. Accepts a mini-script string with operations:

**Operations:**
- \`binding=I(parent, nodeData)\` — Insert new node. Works both for a freshly-created parent binding AND for adding a child to an already-existing node: pass the existing node's id/path as \`parent\` (e.g. \`I("existingFrameId", {...})\` or \`I(card+"/body", {...})\`). This is the ONLY way to add children to an existing node — \`U()\` cannot add, remove, or reorder children.
- \`binding=C(sourceId, parent, overrides)\` — Copy node (\`positionDirection\`/\`positionPadding\` for placement)
- \`U(path, updateData)\` — Update properties (cannot change id, type, or children)
- \`binding=R(path, newNodeData)\` — Replace node entirely
- \`M(nodeId, parent?, index?)\` — Move node
- \`D(nodeId)\` — Delete node
- \`G(nodeId, "ai"|"stock", prompt)\` — Generate/find image and apply as fill to frame/rectangle

**Rules:**
- Max ${MAX_BATCH_DESIGN_OPERATIONS} operations per call
- If the task needs more than ${MAX_BATCH_DESIGN_OPERATIONS} operations, split it into multiple sequential \`batch_design\` calls
- Bindings (e.g. \`card=I(...)\`) only live within one call
- Use \`+\` to build paths: \`U(card+"/title", {content: "Hello"})\`
- If using existing node IDs from previous tool results, pass them as strings (e.g. \`U("abc123", {...})\`)
- The "document" binding is predefined and references the document root
- Insert/Copy/Replace MUST have a binding name
- No "image" node type — use G() on frame/rectangle to apply image fills
- \`placeholder: true\` marks frames being actively designed
- Text has no color by default — set \`fill\` property
- **Text links (hyperlinks):** write a text node's \`content\` (or \`text\`) as a markdown link \`[label](https://...)\` — optionally \`[label](https://... "title")\` — to turn the WHOLE node into a hyperlink (Figma's Link attribute; there's no per-character sub-string link, only a whole text node). Renders with an underline and a default link-blue color, unless the node also has its own \`fill\`/\`fills\`, which takes precedence. In exported HTML it becomes a real \`<a href target="_blank" rel="noopener">\`. Example: \`I(parent, {type: "text", name: "CTA", content: "[Sign up now](https://example.com/signup)"})\`. Remove a link by re-setting \`content\`/\`text\` to plain (non-markdown) text, or clear it directly with \`U("abc", {link: null})\`.
- **Fills (single vs stack):** A single \`fill: "#hex"\` or \`fill: "$--var"\` still works for one solid/variable color. For Figma-style multiple/layered fills, pass a \`fills\` array (bottom-to-top — last entry renders on top) of paint objects:
  - Solid: \`{type: "solid", color: "#hex" | "$--var", opacity?: 0-1, visible?: bool, blendMode?: string}\`
  - Gradient: \`{type: "gradient", gradient: {type: "linear"|"radial", stops: [{color, position}], startX, startY, endX, endY}}\`
  - Image: \`{type: "image", url: "https://...", mode: "fill"|"fit"|"stretch"}\`
  - Pattern (repeating image tile, for textures/grids/decorative backgrounds; rectangle/frame/ellipse only): \`{type: "pattern", url: "https://...", scale?: number (tile scale factor, default 1), spacingX?: px, spacingY?: px (gaps between tiles), offsetX?: px, offsetY?: px (whole-pattern shift), rowOffset?: 0-1 (fraction of a cell each row shifts horizontally — 0.5 gives a brick stagger)}\`
  - Video (a playing .mp4/.webm video as the fill; rectangle/frame/ellipse only): \`{type: "video", src: "https://... or data:video/... — a YouTube URL (youtube.com/watch?v=, youtu.be/, youtube.com/shorts/) also works", mode: "fill"|"fit"|"stretch", autoplay?: bool (default true), loop?: bool (default true), muted?: bool (default true), crop?: {x, y, width, height} (0-1 normalized)}\`. Same fit/crop model as an image fill. NOTE: browsers block unmuted autoplay, so an autoplaying video is effectively muted unless the user unmutes it — keep \`muted: true\` (the default) when \`autoplay\` is on. A YouTube \`src\` renders as its static thumbnail on the canvas (YouTube can't be played inside the editor) but exports/previews as a real playing embedded player.
  Do NOT pass an \`id\` on paints — ids are generated automatically. When you set \`fills\`, it is the single source of truth and any single \`fill\` on that node is ignored. \`$--var\` references inside a solid paint's \`color\` resolve and bind exactly like a single \`fill\`. Example: \`U("abc", {fills: [{type: "solid", color: "$--background"}, {type: "image", url: "https://...", mode: "fill"}]})\`
- **Effects (shadow/blur stack):** pass an \`effects\` array (bottom-to-top, like \`fills\`) on any node (rectangle/frame/ellipse/text) to add shadows and blur:
  - Drop shadow (cast outward, behind the node): \`{type: "shadow", shadowType: "outer", color: "#hex", offset: {x, y}, blur, spread}\`
  - Inner shadow (cast inward from the edges, e.g. for pressed/inset states): \`{type: "shadow", shadowType: "inner", color: "#hex", offset: {x, y}, blur, spread}\` — renders as CSS \`box-shadow: inset ...\` on export
  - Layer blur (blurs the node itself): \`{type: "blur", radius}\`
  - Background blur (a.k.a. backdrop blur — blurs whatever is rendered BEHIND the node instead of the node itself; combine with a semi-transparent fill for a glassmorphism/iOS "frosted glass" card): \`{type: "background-blur", radius}\`
  Multiple shadows (of either kind) and multiple blurs (layer and/or background) can coexist in the same stack; each entry accepts an optional \`visible: bool\` (defaults true). Setting \`effects\` replaces the whole stack. Example: \`U("abc", {effects: [{type: "shadow", shadowType: "outer", color: "#00000040", offset: {x: 0, y: 4}, blur: 8, spread: 0}, {type: "shadow", shadowType: "inner", color: "#00000080", offset: {x: 0, y: 2}, blur: 4, spread: 0}]})\`. Glassmorphism card example: \`U("abc", {fills: [{type: "solid", color: "#ffffff", opacity: 0.4}], effects: [{type: "background-blur", radius: 16}]})\`
- **Corner radius (frame/rectangle):** \`cornerRadius\` accepts either a single number for a uniform radius (\`U("abc", {cornerRadius: 12})\`) OR an array of per-corner radii in \`[topLeft, topRight, bottomRight, bottomLeft]\` order for independent corners (\`U("abc", {cornerRadius: [12, 12, 0, 0]})\`). CSS-style shorthand lengths (1, 2, or 3 values) are also accepted. Setting one form clears the other.
- **Corner smoothing / squircle (frame/rectangle):** \`cornerSmoothing\` is a single number, 0-1 (a fraction, NOT 0-100), applied uniformly to every rounded corner of the shape — it works alongside independent per-corner radii. \`0\` (or unset) is a plain circular-arc corner (default look). Higher values morph the corner into a continuous "squircle" curve; \`~0.6\` approximates the iOS app-icon look. Has no visible effect where \`cornerRadius\`/\`cornerRadiusPerCorner\` is 0. Example: \`U("abc", {cornerRadius: 24, cornerSmoothing: 0.6})\`.
- **Star (polygon node):** a \`type: "polygon"\` node with \`innerRadiusRatio\` set (0-1, exclusive of 1) renders as a star instead of a regular polygon — \`sides\` becomes the number of rays. Only \`sides\`/\`innerRadiusRatio\` need to be given; \`points\` is auto-generated (regenerated on update too, as long as \`points\` itself isn't also passed). \`innerRadiusRatio\` close to 0 gives long thin spikes; close to 1 gives a barely-notched polygon; \`0.5\` is a typical 5-point star look. Example: \`I("abc", {type: "polygon", name: "Rating Star", width: 24, height: 24, sides: 5, innerRadiusRatio: 0.5, fill: "#f5b700"})\`. A plain regular polygon (hexagon, etc.) just omits \`innerRadiusRatio\`, same as before.
- **Ellipse arc / donut (pie charts, progress rings):** an ellipse accepts \`startAngle\` (degrees, 0 = rightmost point, clockwise, default 0), \`sweepAngle\` (degrees, clamped to [-360, 360], default 360 = full ellipse), and \`innerRadiusRatio\` (0-1, donut hole radius as a ratio of the outer radius, default 0 = solid pie/full ellipse). A 90° pie wedge: \`{startAngle: 0, sweepAngle: 90}\`. A full donut ring: \`{innerRadiusRatio: 0.6}\` (sweepAngle stays 360). A partial "thick arc" (donut + partial sweep): combine both. Example: \`I("abc", {type: "ellipse", name: "Progress Ring", width: 100, height: 100, startAngle: -90, sweepAngle: 240, innerRadiusRatio: 0.7, fill: "#3366ff"})\`.
- **Line arrowheads:** a line accepts \`startCap\`/\`endCap\`, each one of \`"none"\` (default), \`"arrow"\` (open chevron), \`"triangle"\` (filled arrowhead), \`"circle"\`, or \`"bar"\` (perpendicular stop, like a dimension line), sized relative to \`strokeWidth\`. \`startCap\` is at \`(points[0], points[1])\`, \`endCap\` at \`(points[2], points[3])\`. Example, a one-way arrow: \`U("abc", {endCap: "triangle"})\`; a dimension line: \`U("abc", {startCap: "bar", endCap: "bar"})\`.
- \`fill_container\` only valid when parent has flexbox layout
- **Wrap (card grids / tag lists):** set \`wrap: true\` on a frame with layout to let children flow onto new lines once the main axis runs out of space. Use \`rowGap\`/\`columnGap\` for independent spacing on each axis (row-gap = space between wrapped lines, column-gap = space between items in a row) — either falls back to \`gap\` when unset, so \`gap\` alone still applies to both axes. A wrapped frame typically has a fixed/fill \`width\` and \`height: "fit_content"\` so it hugs the total height of all wrapped rows. Example: \`U("cardGrid", {wrap: true, columnGap: 16, rowGap: 24})\`
- **Min/max sizing (any child in an auto-layout frame):** \`minWidth\`/\`maxWidth\`/\`minHeight\`/\`maxHeight\` (numbers, in px) clamp a child's resolved size regardless of its sizing mode (fixed/fill_container/fit_content) — e.g. a \`width: "fill_container"\` card that shouldn't grow past 320px: \`U("card", {maxWidth: 320})\`
- Variable references must use exact names from \`get_variables\` (including leading \`--\` and dashes), e.g. \`"$--ck-blue-500"\`
- **Constraints (resize behavior, Figma-style):** \`constraints: {horizontal, vertical}\` on a child controls how it repositions/resizes when its parent frame is resized. Each axis is one of \`"min"\` (pinned to left/top, fixed size — the default when unset), \`"max"\` (pinned to right/bottom, fixed size), \`"center"\` (keeps its offset from the parent's center), \`"stretch"\` (left & right / top & bottom both pinned — size grows/shrinks with the parent), or \`"scale"\` (position and size both scale with the parent). Only meaningful for a direct child of a frame WITHOUT auto-layout — auto-layout frames size children via flex rules and ignore constraints. Example: \`U("abc", {constraints: {horizontal: "stretch", vertical: "min"}})\`
- **Layer masks (Figma-style):** set \`isMask: true\` on a node inside a frame/group to turn it into a mask that clips its siblings rendered ABOVE it (later in that same parent's children — the mask must be created/moved BEFORE the content it should clip so it ends up lower in z-order) up to the next masking sibling or the end of the group. The masker itself is not drawn — only its shape clips. Works for vector shapes (rectangle/ellipse/path/polygon — clips to their outline) as well as text/image-filled nodes (clips to that node's own rendered bounds/shape; soft per-pixel transparency is not yet respected, so prefer a vector shape when you need a precise cutout). Unset with \`isMask: false\` (or omit) to restore normal rendering. Example — a photo cropped to a circle: \`g=I("abc", {type: "frame", name: "Avatar", width: 80, height: 80, children: [{type: "ellipse", name: "Mask", width: 80, height: 80, isMask: true}, {type: "rectangle", name: "Photo", width: 80, height: 80}]})\` then \`G(photoId, "stock", "portrait photo")\`.
- **Lists (bullet/numbered) on a text node:** a text node's \`text\` is \`\\n\`-joined paragraphs; give it a parallel \`paragraphs\` array (same length as the number of \`\\n\`-separated lines — pad plain paragraphs with \`{}\`) where each entry is \`{listType?: "bullet"|"number"|"none", indentLevel?: number}\`. \`indentLevel\` (0 = top level) nests the item and restarts numbered counters per nested level (a bullet/plain paragraph at the same or shallower level resets a deeper numbered run; returning to a shallower level resumes its own counter). Omit \`paragraphs\`, or use \`{}\`/\`{listType: "none"}\`, for plain (non-list) paragraphs. Example — a heading, a 3-item bullet list, another heading, then a numbered list with one nested sub-step: \`I("doc", {type: "text", name: "Notes", text: "Groceries\\nMilk\\nEggs\\nBread\\nSteps\\nMix\\nDetails\\nBake", paragraphs: [{}, {listType:"bullet"}, {listType:"bullet"}, {listType:"bullet"}, {}, {listType:"number"}, {listType:"number", indentLevel:1}, {listType:"number"}]})\` (paragraphs one-to-one with the 8 \`\\n\`-separated lines). \`U("abc", {paragraphs: [...]})\` re-tags an existing text node's paragraphs the same way (array length should match the node's current line count).
- **Paragraph spacing (text node):** \`paragraphSpacing\` (number, px, default 0) adds extra vertical gap after every \`\\n\`-separated paragraph but the last (a 3-paragraph node gets 2 gaps). Included in auto-size/hug height measurement, so a text node with \`textWidthMode: "auto"\` or \`"fixed"\` (auto-height) grows to fit it automatically. Example: \`U("abc", {paragraphSpacing: 16})\`.
- **Variable font axes (text node):** for a variable font (e.g. \`"Inter"\`, \`"Roboto Flex"\`, \`"Recursive"\`, \`"Fraunces"\`, \`"Source Sans 3"\`, \`"Source Serif 4"\`, \`"Newsreader"\`), \`fontVariations\` is an object of OpenType axis tag → numeric value, e.g. \`{wght: 530}\` for a fine-grained weight between the standard 100-900 steps, or \`{wght: 700, wdth: 87, opsz: 24}\` to combine weight/width/optical-size on a font that exposes those axes. Values are clamped by the browser to each axis's registered min/max. When \`wght\` is set it takes precedence over the static \`fontWeight\` field. Example: \`U("abc", {fontVariations: {wght: 450}})\`.

**Example:**
\`\`\`
card=I("parentId", {type: "frame", name: "Account Card", layout: "vertical", padding: 16, gap: 12, width: 300, height: "fit_content"})
U(card+"/title", {content: "Account Details"})
\`\`\``,
    inputSchema: batchDesignInputSchema.describe(
      'Tool input object. Required canonical field: {"operations":"..."}; aliases design/script/batch are accepted for robustness.',
    ),
  }),

  rename_layers: tool({
    description:
      "Rename one or more layers (nodes) to logical, human-readable names in a single undoable step. Provide the node id and the new name for each layer. Read each layer's type, text content, and hierarchy first (via get_editor_state / batch_get) so the names reflect each layer's role (e.g. a text node reading \"Sign in\" → \"Sign in button\"; a frame of inputs → \"Login form\"). Leave already-meaningful names alone.",
    inputSchema: z.object({
      renames: z
        .array(
          z.object({
            id: z.string().describe("The node id to rename."),
            name: z
              .string()
              .min(1)
              .describe("The new layer name (non-empty)."),
          }),
        )
        .min(1)
        .describe("One {id, name} entry per layer to rename."),
    }),
  }),

  boolean_operation: tool({
    description:
      "Combine 2+ selected shape nodes (rectangle/ellipse/polygon/path) into a single flattened path using a boolean operation, replacing the originals in one undoable step — useful for cutouts, icons, and complex silhouettes. `union` merges outlines, `subtract` cuts the upper shapes out of the bottom-most one, `intersect` keeps only the overlapping area, `exclude` keeps everything except the overlap (XOR), `flatten` merges outlines like union but is meant for normalizing a multi-shape selection into one editable path. Order matters for subtract/exclude — shapes are combined bottom-to-top by their current z-order (layer stacking), not by the order of nodeIds. All nodes must share the same parent.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(2)
        .describe("IDs of the shape nodes to combine (2 or more, same parent)."),
      operation: z
        .enum(["union", "subtract", "intersect", "exclude", "flatten"])
        .describe("Which boolean operation to apply."),
    }),
  }),

  set_variables: tool({
    description:
      "Add or update design variables and themes. Variables can reference theme axes for different values per theme. By default merges with existing variables (matched by id or name); set replace=true to overwrite all.",
    inputSchema: z.object({
      variables: z
        .record(z.unknown())
        .describe(
          "Variable definitions, as an object keyed by variable name. Simplest form — a plain hex string per name: " +
            '`{"--brand-primary": "#3b82f6", "--brand-bg": "#ffffff"}`. ' +
            "Full form — an object per name with `type` (\"color\" | \"number\" | \"string\", default \"color\") and `value`: " +
            '`{"--radius-lg": {"type": "number", "value": "16"}}`. ' +
            "Per-theme values use `themeValues`: " +
            '`{"--brand-bg": {"type": "color", "value": "#ffffff", "themeValues": {"dark": "#0b0b0b"}}}`. ' +
            "Names may be given with or without a leading `--`/`$`. Nested token groups (e.g. `{colors: {primary: {$type, $value}}}`) are also accepted.",
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces all existing variables. Default is merge.",
        ),
    }),
  }),

  get_text_styles: tool({
    description:
      "Read all named, reusable text styles (Figma-style 'Text styles') defined in the .pen file: fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform.",
    inputSchema: z.object({}),
  }),

  set_text_styles: tool({
    description:
      "Create or update named text styles. By default merges with existing styles by id/name (updating a style pushes the change to every text node bound to it, except locally-overridden properties); set replace=true to overwrite the whole set.",
    inputSchema: z.object({
      textStyles: z
        .union([
          z.array(z.record(z.unknown())),
          z.record(z.unknown()),
        ])
        .describe(
          "Text style definitions to add or merge. Either an array of {name, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform} objects, or an object keyed by style name.",
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces all existing text styles. Default is merge.",
        ),
    }),
  }),

  apply_text_style: tool({
    description:
      "Bind one or more text nodes to a named text style (from get_text_styles / set_text_styles), copying the style's typography onto each node. Use instead of manually setting fontFamily/fontSize/etc. for design-system consistency.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the text nodes to bind to the style."),
      textStyleId: z.string().describe("The id of the text style to apply."),
    }),
  }),

  get_styles: tool({
    description:
      "Read all named, reusable fill (color/gradient/image/pattern paint) and effect (shadow/blur stack) styles defined in the .pen file (Figma-style 'Color styles' and 'Effect styles'). Unlike a plain variable, a style can hold a full gradient, image, or shadow/blur stack, and a fill style's solid color may itself reference a variable.",
    inputSchema: z.object({}),
  }),

  set_styles: tool({
    description: `Create or update named fill styles and/or effect styles. Editing an existing style (by id or name) live-updates every node currently applying it — no separate "propagate" step needed. By default merges with existing styles; set replace=true to overwrite the whole set (fillStyles and effectStyles are replaced independently — omit one to leave it untouched even with replace=true).

- Fill style paint: either a full paint object \`{type: "solid"|"gradient"|"image"|"pattern", ...}\` (same shapes as a \`fills\` entry in \`batch_design\`, including \`"$--var"\` variable references in a solid's \`color\`), the shorthand \`{color: "#hex" | "$--var"}\` for a solid color style, or a paint object carrying just a \`gradient\`/\`image\`/\`pattern\` sub-object (the type is inferred). An ambiguous paint (no color and no gradient/image/pattern) is reported as an error rather than silently stored.
- Effect style: \`{name, effects: [...]}\` — same shadow/layer-blur/background-blur objects as a node's \`effects\` array in \`batch_design\`.

Returns the created/updated style ids and names (with a created|updated status) — pass those ids straight to \`apply_fill_style\`/\`apply_effect_style\` without a \`get_styles\` round-trip.`,
    inputSchema: z.object({
      fillStyles: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "Fill style definitions to add or merge: [{id?, name, paint?: {...}, color?: '#hex'|'$--var'}].",
        ),
      effectStyles: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "Effect style definitions to add or merge: [{id?, name, effects: [...]}].",
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces the existing set for each of fillStyles/effectStyles that was provided. Default is merge.",
        ),
    }),
  }),

  apply_fill_style: tool({
    description:
      "Bind one or more nodes' fill to a named fill style (from get_styles / set_styles) — sets the node's topmost paint layer (or adds one if it has none) to reference the style, so future edits to the style live-update the node. Use for design-system-consistent color/gradient/image fills instead of a raw fill value.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to bind to the fill style."),
      styleId: z.string().describe("The id of the fill style to apply."),
    }),
  }),

  apply_effect_style: tool({
    description:
      "Bind one or more nodes' whole shadow/blur stack to a named effect style (from get_styles / set_styles) — replaces the node's own effects with a live reference to the style. Use for design-system-consistent shadows instead of raw effects values.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to bind to the effect style."),
      styleId: z.string().describe("The id of the effect style to apply."),
    }),
  }),

  set_export_settings: tool({
    description:
      "Add (or replace) an export preset on one or more nodes — format, scale and an optional filename suffix (e.g. '@2x', '_dark'). This is how to configure or trigger an export with specific parameters: it writes to the node's `exportSettings` so the user's Export panel can run 'Export all' for those nodes. Does not itself produce a downloadable file.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to configure export settings on."),
      format: z
        .enum(["svg", "png", "jpg", "webp", "pdf"])
        .describe("Export file format."),
      scale: z
        .number()
        .positive()
        .optional()
        .describe("Export scale multiplier (e.g. 0.5, 1, 2, 3). Defaults to 1."),
      suffix: z
        .string()
        .optional()
        .describe("Filename suffix appended before the extension, e.g. '@2x' or '_dark'."),
      quality: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Encoder quality 0-1, used for lossy raster formats (jpg/webp)."),
      mode: z
        .enum(["add", "replace"])
        .optional()
        .describe("'add' appends a new export setting (default); 'replace' replaces all existing settings on the node with this one."),
    }),
  }),

  replace_all_matching_properties: tool({
    description:
      "Recursively find-and-replace property values across the node tree. Useful for bulk color/font/spacing changes (e.g. rebranding, theme adjustments).",
    inputSchema: z.object({
      parents: z
        .array(z.string())
        .describe("Node IDs to search within recursively."),
      properties: z
        .object({
          fillColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          textColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          strokeColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          strokeThickness: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          cornerRadius: z
            .array(
              z.object({
                from: z.array(z.number()),
                to: z.array(z.number()),
              }),
            )
            .optional(),
          cornerSmoothing: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          padding: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          gap: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          fontSize: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          fontFamily: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          fontWeight: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
        })
        .describe(
          "Property replacements. Each key maps to an array of {from, to} pairs.",
        ),
    }),
  }),

  // ── Utility ───────────────────────────────────────────────────────

  find_empty_space_on_canvas: tool({
    description:
      "Find available empty space on the canvas in a given direction with the specified dimensions. Use before inserting new top-level frames to avoid overlapping.",
    inputSchema: z.object({
      direction: z
        .enum(["top", "right", "bottom", "left"])
        .describe("Direction to search for empty space."),
      width: z.number().describe("Required width of empty space."),
      height: z.number().describe("Required height of empty space."),
      padding: z
        .number()
        .describe("Minimum distance from other elements."),
      nodeId: z
        .string()
        .optional()
        .describe(
          "Reference node to search around. Omit to search around entire canvas content.",
        ),
    }),
  }),

  search_all_unique_properties: tool({
    description:
      "Search for all unique values of specified properties across the node tree. Useful for auditing design consistency (e.g. finding all colors or font sizes in use).",
    inputSchema: z.object({
      parents: z
        .array(z.string())
        .describe("Node IDs to search within recursively."),
      properties: z
        .array(
          z.enum([
            "fillColor",
            "textColor",
            "strokeColor",
            "strokeThickness",
            "cornerRadius",
            "cornerSmoothing",
            "padding",
            "gap",
            "fontSize",
            "fontFamily",
            "fontWeight",
          ]),
        )
        .describe("Property names to collect unique values for."),
    }),
  }),

  get_guidelines: tool({
    description:
      "Get design guidelines and rules for a specific topic. Returns static instructional content to help you follow best practices.",
    inputSchema: z.object({
      topic: z
        .enum(["code", "table", "tailwind", "landing-page", "design-system"])
        .describe("Topic to retrieve guidelines for."),
    }),
    execute: async ({ topic }) => {
      const guidelines: Record<string, string> = {
        "design-system":
          "## Sizing & Auto-Layout Rules\n" +
          "CRITICAL: When creating frames with layout (vertical/horizontal), you MUST explicitly set width and height. " +
          "Never leave them as default — the default is a fixed pixel size which breaks auto-layout.\n" +
          "- Use `width: \"fill_container\"` for children that should stretch to parent width.\n" +
          "- Use `height: \"fill_container\"` for children that should stretch to parent height.\n" +
          "- Use `width: \"fit_content\"` or `height: \"fit_content\"` for content-sized elements.\n" +
          "- Use `height: \"fit_content(900)\"` for screens/sections that need a minimum height but grow with content.\n" +
          "- Only use fixed pixel values for elements with a known exact size (icons, avatars, fixed sidebars).\n" +
          "- Screen root frames: `width: 1440, height: \"fit_content(900)\"`.\n" +
          "- Content areas inside screens: `width: \"fill_container\", height: \"fit_content\"` or `height: \"fill_container\"`.\n" +
          "- Wrapper/container frames: ALWAYS set `height: \"fit_content\"` — they should grow with content.\n" +
          "- Card grids / tag lists: set `wrap: true` on the frame plus a fixed/fill `width` and `height: \"fit_content\"` so rows wrap and the frame hugs the total row height. Use `rowGap`/`columnGap` for independent row/column spacing (each falls back to `gap`).\n" +
          "- Use `minWidth`/`maxWidth`/`minHeight`/`maxHeight` on a child to clamp its resolved size (e.g. a `fill_container` card capped at `maxWidth: 320` so it doesn't stretch too wide in a wide row).\n\n" +
          "### Examples\n" +
          "WRONG: `I(screen, {type: \"frame\", layout: \"vertical\", gap: 16})` — no width/height, will use fixed defaults!\n" +
          "RIGHT: `I(screen, {type: \"frame\", layout: \"vertical\", gap: 16, width: \"fill_container\", height: \"fit_content\"})`\n\n" +
          "## Component Usage\n" +
          "- A reusable component is a native `frame` node with `reusable: true` — NOT an embed node. Use `get_editor_state`/`batch_get` to discover existing ones (search `type: \"frame\"`, check `reusable`).\n" +
          "- An instance is a `ref` node: `inst=I(parent, {type: \"ref\", componentId: \"<componentFrameId>\", width, height})`. Do NOT recreate a component's UI from scratch with frame/rect/text — insert a `ref` pointing at it instead.\n" +
          "- Per-instance customization goes through **overrides**, addressed by descendant path (a child's id, or `\"childId/grandchildId\"` for nested descendants): `U(inst+\"/label\", {text: \"Buy now\"})` sets a property on that instance only, leaving the component and other instances untouched.\n" +
          "- **Component properties (variants)**: a component can declare typed, named switches via `properties` on the component frame — `variant` (enum, e.g. state=default/hover/pressed), `boolean` (e.g. showIcon), or `text` (e.g. label). Each property is `{id, name, type, variantOptions?, defaultValue, bindingPath, bindingProp}`, where `bindingPath`/`bindingProp` name the descendant path and field the property controls (the same addressing as an override). `bindingProp` must be the node's INTERNAL field name, not an AI-input alias — use `\"text\"` for a text node's content (NOT `\"content\"`, which is only accepted by `U()`'s own alias mapping, not by `bindingProp`).\n" +
          "- **Important sequencing**: `componentId`, `bindingPath`, and any other id referenced *inside a nested `{...}`/`[...]` object* only resolve if written as a quoted string of a REAL, already-existing node id — same-call bindings (e.g. `comp=I(...)`) only substitute as bare top-level arguments (parent/sourceId/path), never inside nested JSON. So: create the component and its descendants in one `batch_design` call, read their real ids off the returned `createdNodes`, then in a follow-up call declare `properties` and/or create the `ref` instance using those ids as quoted strings.\n" +
          "  Call 1: `comp=I(document, {type: \"frame\", name: \"Button\", reusable: true, width: 120, height: 40})\\nlabel=I(comp, {type: \"text\", content: \"Click me\", width: 80, height: 20})` → returns e.g. `comp` id `\"n1\"`, `label` id `\"n2\"`.\n" +
          "  Call 2: `U(\"n1\", {properties: [{id: \"state\", name: \"State\", type: \"variant\", variantOptions: [\"default\",\"hover\"], defaultValue: \"default\", bindingPath: \"n2\", bindingProp: \"fill\"}]})\\ninst=I(document, {type: \"ref\", componentId: \"n1\", width: 120, height: 40})`.\n" +
          "- An instance selects a property's value via `propertyValues` (keyed by property id), NOT via `overrides`: `U(inst, {propertyValues: {state: \"hover\"}})` (`inst` here is a real id from a previous result, quoted, or a same-call top-level binding). `U()` merges `propertyValues` by key (setting one property never clobbers others already selected on the instance), and switching a property never touches the instance's `overrides` — both apply together, with an explicit override at the same path winning.\n" +
          "- When creating new designs, reuse existing components (and their declared variants) rather than building UI from scratch.\n\n" +
          "## Layout Patterns\n" +
          "- Sidebar + Content: sidebar with fixed width (240-280px), main with `width: \"fill_container\"`.\n" +
          "- Card grids: horizontal frame with `gap: 16-24`, cards with `width: \"fill_container\"`.\n" +
          "- Form fields: vertical frame with `gap: 16`, inputs with `width: \"fill_container\"`.\n\n" +
          "## Design Tokens\n" +
          "- Always use `$--variable` tokens for colors, never hardcode hex values.\n" +
          "- Colors: `$--background`, `$--foreground`, `$--muted-foreground`, `$--primary`, `$--border`, `$--card`.\n" +
          "- Typography: `$--font-primary` (headings), `$--font-secondary` (body).\n" +
          "- Border radius: `$--radius-none`, `$--radius-m`, `$--radius-pill`.\n\n" +
          "## Spacing Reference\n" +
          "- Screen sections gap: 24-32. Card grid gap: 16-24. Form fields gap: 16.\n" +
          "- Inside cards padding: 24. Page content padding: 32. Button padding: [10, 16].\n" +
          "- Maintain consistent spacing — pick from the established scale, don't use arbitrary values.",
        code:
          "When generating code from designs, use semantic HTML elements. " +
          "Map frame layouts to CSS flexbox. Map auto-layout direction to flex-direction. " +
          "Use CSS custom properties for theme variables. Export assets as needed.",
        table:
          "Build tables using nested frames with auto-layout. " +
          "Use a vertical frame for rows and horizontal frames for cells. " +
          "Keep header row as a separate component for reuse. " +
          "Apply consistent padding and borders across cells.",
        tailwind:
          "Map design tokens to Tailwind utility classes. " +
          "Use flex/grid for frame layouts. Apply gap-* for spacing. " +
          "Use p-* for padding, rounded-* for corner radius. " +
          "Map fill colors to bg-* and text colors to text-*.",
        "landing-page":
          "Structure landing pages with a hero section, features grid, testimonials, and CTA. " +
          "Use large typography for headings (48-72px). " +
          "Maintain visual hierarchy with consistent spacing (64-128px between sections). " +
          "Include responsive breakpoints for mobile and desktop.",
      };

      if (!guidelines[topic]) {
        return {
          error: `Invalid topic. Available topics: ${Object.keys(guidelines).join(", ")}`,
        };
      }
      return { topic, guidelines: guidelines[topic] };
    },
  }),

  get_style_guide_tags: tool({
    description:
      "Get all available style guide tags. Call this before get_style_guide to know which tags you can use for filtering.",
    inputSchema: z.object({}),
    execute: async () => {
      return {
        tags: {
          style: ["minimal", "bold", "elegant", "playful", "corporate", "modern", "retro", "brutalist"],
          color: ["monochrome", "vibrant", "pastel", "dark", "light", "warm", "cool", "earth-tones"],
          industry: ["saas", "ecommerce", "finance", "healthcare", "education", "creative", "technology"],
          platform: ["mobile", "website", "webapp", "dashboard"],
          layout: ["grid", "asymmetric", "centered", "full-width", "card-based", "sidebar"],
        },
      };
    },
  }),

  get_style_guide: tool({
    description:
      "Get a style guide for design inspiration. Either pass 5-10 tags to find a matching style, or pass a specific name to retrieve a known style guide.",
    inputSchema: z.object({
      tags: z
        .array(z.string())
        .optional()
        .describe("5-10 tags to search for a matching style guide."),
      name: z
        .string()
        .optional()
        .describe("Specific style guide name to retrieve."),
    }),
    execute: async ({ tags, name }) => {
      return {
        name: name ?? "Generated Style Guide",
        basedOn: tags ?? [],
        typography: {
          headingFont: "Inter",
          bodyFont: "Inter",
          sizes: { h1: 48, h2: 36, h3: 24, h4: 18, body: 16, small: 14, caption: 12 },
          weights: { heading: "700", body: "400", emphasis: "600" },
        },
        colors: {
          primary: "#3B82F6",
          secondary: "#8B5CF6",
          accent: "#F59E0B",
          background: "#FFFFFF",
          surface: "#F8FAFC",
          text: "#0F172A",
          textMuted: "#64748B",
          border: "#E2E8F0",
          success: "#22C55E",
          error: "#EF4444",
          warning: "#F59E0B",
        },
        spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, section: 64 },
        borderRadius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
      };
    },
  }),

  generate_image: tool({
    description:
      "Generate an image from a text prompt and show it in the chat. Use when the user asks for an illustration, photo, texture, or background that is NOT being applied to a specific frame. Returns the image URL, which is rendered inline in the chat.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
    }),
  }),
  generate_frame_image: tool({
    description:
      "Generate an image from a text prompt and set it as the image fill of a specific frame. Use for on-canvas requests that target a frame (e.g. 'make a background for this frame', 'fill this frame with a photo of X'). Pass the target frame's id from the editor state / current selection. The image also appears in the chat.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
      frame_id: z
        .string()
        .describe("ID of the frame whose fill should become the generated image"),
    }),
  }),
};
