import { tool } from "ai";
import { z } from "zod";

export const penTools = {
  // ── Reading & Navigation ──────────────────────────────────────────

  get_editor_state: tool({
    description:
      "Get the current editor state including active .pen file, user selection, top-level nodes, and available reusable components. Call this first to understand what you're working with.",
    inputSchema: z.object({
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
    inputSchema: z.object({
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
- If using existing node IDs from previous tool results, pass them as strings (e.g. \`U("abc123", {...})\`)
- The "document" binding is predefined and references the document root
- Insert/Copy/Replace MUST have a binding name
- Do NOT U() descendants of a copied node — use \`descendants\` in C() instead
- No "image" node type — use G() on frame/rectangle to apply image fills
- \`placeholder: true\` marks frames being actively designed
- Text has no color by default — set \`fill\` property
- \`fill_container\` only valid when parent has flexbox layout
- Variable references must use exact names from \`get_variables\` (including leading \`--\` and dashes), e.g. \`"$--ck-blue-500"\`
- For instance descendant updates, path must start with the instance/ref ID (NOT a frame path chain).

**Example:**
\`\`\`
card=I("parentId", {type: "ref", ref: "CardComp"})
U(card+"/title", {content: "Account Details"})
U(card+"/description", {content: "Manage your settings"})
U("existingRefId", {descendants: {"title": {content: "New title"}}})
U("existingRefId/title", {content: "New title"})
\`\`\``,
    inputSchema: z.object({
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
          "- Use reusable components (frames with reusable: true) as building blocks.\n" +
          "- Insert instances via ref nodes: `{type: \"ref\", ref: \"componentId\"}`.\n" +
          "- Override descendant properties using the descendants map.\n" +
          "- Use slots (frames with `slot` property) to insert child content into components.\n" +
          "- Disable unused slots with `enabled: false`.\n\n" +
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
};
