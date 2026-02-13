import { tool } from "ai";
import { z } from "zod";

export const penTools = {
  // ── Reading & Navigation ──────────────────────────────────────────

  get_editor_state: tool({
    description:
      "Get the current editor state including active .pen file, user selection, top-level nodes, and available reusable components. Call this first to understand what you're working with.",
    parameters: z.object({
      include_schema: z
        .boolean()
        .describe(
          "Whether to include the .pen file schema in the response. Set true if you need to understand the node format.",
        ),
    }),
  }),

  open_document: tool({
    description:
      'Open an existing .pen file or create a new one. Pass "new" to create a blank document, or a file path to open an existing file.',
    parameters: z.object({
      filePathOrTemplate: z
        .string()
        .describe(
          'File path to an existing .pen file, or "new" for a new document.',
        ),
    }),
  }),

  batch_get: tool({
    description:
      "Retrieve nodes by searching for matching patterns or by reading specific node IDs. Supports flexible tree traversal with depth control. Use this to inspect node structure before modifying.",
    parameters: z.object({
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
                "connection",
                "note",
                "icon_font",
                "image",
                "ref",
              ])
              .optional()
              .describe("Only return nodes with this type"),
            name: z
              .string()
              .optional()
              .describe(
                "Only return nodes whose name matches this regex pattern",
              ),
            reusable: z
              .boolean()
              .optional()
              .describe("Only return nodes with this reusable value"),
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
      resolveInstances: z
        .boolean()
        .optional()
        .describe(
          "If true, ref nodes are fully expanded instead of showing as references.",
        ),
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
    parameters: z.object({
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

  get_screenshot: tool({
    description:
      "Take a screenshot of a specific node for visual verification. Use this after making changes to confirm they look correct. Returns an image.",
    parameters: z.object({
      nodeId: z.string().describe("The ID of the node to screenshot."),
    }),
  }),

  get_variables: tool({
    description:
      "Read all design variables (tokens) and themes defined in the .pen file. Variables can be colors, numbers, strings, or booleans, and may have different values per theme.",
    parameters: z.object({}),
  }),

  // ── Modification ──────────────────────────────────────────────────

  batch_design: tool({
    description: `Execute batch operations on the .pen node tree. Accepts a mini-script string with operations:

**Operations:**
- \`binding=I(parent, nodeData)\` — Insert new node
- \`binding=C(sourceId, parent, overrides)\` — Copy node (use \`descendants\` for nested overrides, \`positionDirection\`/\`positionPadding\` for placement)
- \`U(path, updateData)\` — Update properties (cannot change id, type, ref, or children)
- \`binding=R(path, newNodeData)\` — Replace node entirely (ideal for swapping slots in component instances)
- \`M(nodeId, parent?, index?)\` — Move node
- \`D(nodeId)\` — Delete node
- \`G(nodeId, "ai"|"stock", prompt)\` — Generate/find image and apply as fill to frame/rectangle

**Rules:**
- Max 25 operations per call
- Bindings (e.g. \`card=I(...)\`) only live within one call
- Use \`+\` to build paths: \`U(card+"/title", {content: "Hello"})\`
- The "document" binding is predefined and references the document root
- Insert/Copy/Replace MUST have a binding name
- Do NOT U() descendants of a copied node — use \`descendants\` in C() instead
- No "image" node type — use G() on frame/rectangle to apply image fills
- \`placeholder: true\` marks frames being actively designed
- Text has no color by default — set \`fill\` property
- \`fill_container\` only valid when parent has flexbox layout

**Example:**
\`\`\`
card=I("parentId", {type: "ref", ref: "CardComp"})
U(card+"/title", {content: "Account Details"})
U(card+"/description", {content: "Manage your settings"})
\`\`\``,
    parameters: z.object({
      operations: z
        .string()
        .describe(
          "Mini-script string with I/C/U/R/M/D/G operations, one per line.",
        ),
    }),
  }),

  set_variables: tool({
    description:
      "Add or update design variables and themes. Variables can reference theme axes for different values per theme. By default merges with existing variables; set replace=true to overwrite all.",
    parameters: z.object({
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
    parameters: z.object({
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
    parameters: z.object({
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
    parameters: z.object({
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
    parameters: z.object({
      topic: z
        .enum(["code", "table", "tailwind", "landing-page", "design-system"])
        .describe("Topic to retrieve guidelines for."),
    }),
  }),

  get_style_guide_tags: tool({
    description:
      "Get all available style guide tags. Call this before get_style_guide to know which tags you can use for filtering.",
    parameters: z.object({}),
  }),

  get_style_guide: tool({
    description:
      "Get a style guide for design inspiration. Either pass 5-10 tags to find a matching style, or pass a specific name to retrieve a known style guide.",
    parameters: z.object({
      tags: z
        .array(z.string())
        .optional()
        .describe("5-10 tags to search for a matching style guide."),
      name: z
        .string()
        .optional()
        .describe("Specific style guide name to retrieve."),
    }),
  }),
};
