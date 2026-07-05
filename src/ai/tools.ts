import { tool } from "ai";
import { z } from "zod";

const MAX_BATCH_DESIGN_OPERATIONS = 25;

// Mirrors splitOperationLines in the frontend parser
// (pen-editor/src/lib/tools/batchDesign/parser.ts): a newline ends a statement
// only at top level — outside strings and unbalanced (), {}, [] — so a
// multi-line value (e.g. htmlContent) still counts as one operation.
function countBatchDesignOperations(operations: string): number {
  let count = 0;
  let current = "";
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let escaped = false;
  let stringDelimiter: '"' | "'" | "`" | null = null;

  const countStatement = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
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
- \`binding=I(parent, nodeData)\` — Insert new node
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
- **Fills (single vs stack):** A single \`fill: "#hex"\` or \`fill: "$--var"\` still works for one solid/variable color. For Figma-style multiple/layered fills, pass a \`fills\` array (bottom-to-top — last entry renders on top) of paint objects:
  - Solid: \`{type: "solid", color: "#hex" | "$--var", opacity?: 0-1, visible?: bool, blendMode?: string}\`
  - Gradient: \`{type: "gradient", gradient: {type: "linear"|"radial", stops: [{color, position}], startX, startY, endX, endY}}\`
  - Image: \`{type: "image", url: "https://...", mode: "fill"|"fit"|"stretch"}\`
  Do NOT pass an \`id\` on paints — ids are generated automatically. When you set \`fills\`, it is the single source of truth and any single \`fill\` on that node is ignored. \`$--var\` references inside a solid paint's \`color\` resolve and bind exactly like a single \`fill\`. Example: \`U("abc", {fills: [{type: "solid", color: "$--background"}, {type: "image", url: "https://...", mode: "fill"}]})\`
- **Effects (shadow/blur stack):** pass an \`effects\` array (bottom-to-top, like \`fills\`) on any node (rectangle/frame/ellipse/text) to add shadows and blur:
  - Drop shadow (cast outward, behind the node): \`{type: "shadow", shadowType: "outer", color: "#hex", offset: {x, y}, blur, spread}\`
  - Inner shadow (cast inward from the edges, e.g. for pressed/inset states): \`{type: "shadow", shadowType: "inner", color: "#hex", offset: {x, y}, blur, spread}\` — renders as CSS \`box-shadow: inset ...\` on export
  - Layer blur: \`{type: "blur", radius}\`
  Multiple shadows (of either kind) and multiple blurs can coexist in the same stack; each entry accepts an optional \`visible: bool\` (defaults true). Setting \`effects\` replaces the whole stack. Example: \`U("abc", {effects: [{type: "shadow", shadowType: "outer", color: "#00000040", offset: {x: 0, y: 4}, blur: 8, spread: 0}, {type: "shadow", shadowType: "inner", color: "#00000080", offset: {x: 0, y: 2}, blur: 4, spread: 0}]})\`
- **Corner radius (frame/rectangle):** \`cornerRadius\` accepts either a single number for a uniform radius (\`U("abc", {cornerRadius: 12})\`) OR an array of per-corner radii in \`[topLeft, topRight, bottomRight, bottomLeft]\` order for independent corners (\`U("abc", {cornerRadius: [12, 12, 0, 0]})\`). CSS-style shorthand lengths (1, 2, or 3 values) are also accepted. Setting one form clears the other.
- \`fill_container\` only valid when parent has flexbox layout
- Variable references must use exact names from \`get_variables\` (including leading \`--\` and dashes), e.g. \`"$--ck-blue-500"\`
- **Constraints (resize behavior, Figma-style):** \`constraints: {horizontal, vertical}\` on a child controls how it repositions/resizes when its parent frame is resized. Each axis is one of \`"min"\` (pinned to left/top, fixed size — the default when unset), \`"max"\` (pinned to right/bottom, fixed size), \`"center"\` (keeps its offset from the parent's center), \`"stretch"\` (left & right / top & bottom both pinned — size grows/shrinks with the parent), or \`"scale"\` (position and size both scale with the parent). Only meaningful for a direct child of a frame WITHOUT auto-layout — auto-layout frames size children via flex rules and ignore constraints. Example: \`U("abc", {constraints: {horizontal: "stretch", vertical: "min"}})\`

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
      "Add or update design variables and themes. Variables can reference theme axes for different values per theme. By default merges with existing variables; set replace=true to overwrite all.",
    inputSchema: z.object({
      variables: z
        .record(z.unknown())
        .describe("Variable definitions to add or merge."),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces all existing variables. Default is merge.",
        ),
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
          "- Wrapper/container frames: ALWAYS set `height: \"fit_content\"` — they should grow with content.\n\n" +
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
