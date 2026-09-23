import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BATCH_DESIGN_DESCRIPTION,
  batchDesignInputShape,
  makeBatchDesignInputSchema,
  getEditorStateInputShape,
  batchGetInputShape,
  snapshotLayoutInputShape,
  getVariablesInputShape,
  setVariablesInputShape,
  getGuidelinesImpl,
  getStyleGuideTagsImpl,
  getStyleGuideImpl,
  readCommentsInputShape,
  replyCommentInputShape,
  resolveCommentInputShape,
  leaveCommentInputShape,
  renameLayersInputShape,
  readEmbedHtmlInputShape,
  readEmbedHtmlInputSchema,
  editEmbedHtmlInputShape,
  findEmptySpaceOnCanvasInputShape,
} from "../ai/tools.js";
import { callTool as callBridgedTool } from "./bridge.js";
import { ensureSkillsLoaded, getAllSkills, getSkill } from "../ai/skills.js";
import {
  getSkillSurfaceNotice,
  getSkillSurfaceWarning,
  getUnavailableToolsForSkill,
  POLICY_DEPENDENT_SKILL_NAMES,
} from "./skillSurface.js";
import { BRIDGED_TOOL_NAMES, SKILL_TOOL_NAMES, STATIC_TOOL_NAMES } from "./toolNames.js";

// Re-exported for existing importers (test/mcp-tools-contract.test.ts) — the
// actual definitions live in toolNames.js so skillSurface.js can depend on
// them without a circular import back onto this module.
export { BRIDGED_TOOL_NAMES, STATIC_TOOL_NAMES, SKILL_TOOL_NAMES };

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Wraps a bridged tool call: forwards to the connected editor tab and turns
// any rejection (no session / timeout / mid-call disconnect / a handler
// exception the tab reported as tool_error) into an MCP isError text result
// instead of throwing — a bridge failure must never crash the MCP session.
async function callBridged(tool: string, args: Record<string, unknown>) {
  try {
    const result = await callBridgedTool(tool, args);
    const errorMessage = bridgedErrorMessage(result);
    return errorMessage !== undefined ? errorResult(errorMessage) : textResult(result);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// The frontend's executeToolCall() (useDesignChat.ts) never rejects — a
// handler exception is caught there and returned as a resolved result whose
// body is `JSON.stringify({ error: message })`. That means a resolved
// callBridgedTool() promise can still represent a tool failure, not just a
// successful "tool_result". Without this check, that error shape would be
// wrapped in textResult() and reported to the MCP client as isError:false.
function bridgedErrorMessage(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "string"
  ) {
    return (parsed as { error: string }).error;
  }
  return undefined;
}

const GET_SCREENSHOT_DESCRIPTION =
  "Take a screenshot of a node for visual verification — enabled only for MCP clients (not the built-in chat agent). " +
  "Omit nodeId to screenshot the current selection (errors if none or more than one node is selected). Returns a PNG image.";

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "pen-editor", version: "1.0.0" });

  server.registerTool(
    "get_editor_state",
    {
      description:
        "Get the current editor state: active .pen file, user selection, top-level nodes. Call this first — Figma's metadata-first pattern.",
      inputSchema: getEditorStateInputShape,
    },
    (args) => callBridged("get_editor_state", args),
  );

  server.registerTool(
    "batch_get",
    {
      description:
        "Retrieve nodes by id or search pattern, with depth control. Use to inspect structure before modifying.",
      inputSchema: batchGetInputShape,
    },
    (args) => callBridged("batch_get", args),
  );

  server.registerTool(
    "snapshot_layout",
    {
      description:
        "Get computed layout rectangles (positions/sizes after the layout engine runs). Key for design-to-code fidelity — use to check placement, overlap, and clipping.",
      inputSchema: snapshotLayoutInputShape,
    },
    (args) => callBridged("snapshot_layout", args),
  );

  server.registerTool(
    "get_variables",
    {
      description: "Read all design variables (tokens) and themes defined in the .pen file.",
      inputSchema: getVariablesInputShape,
    },
    (args) => callBridged("get_variables", args),
  );

  server.registerTool(
    "get_screenshot",
    {
      description: GET_SCREENSHOT_DESCRIPTION,
      inputSchema: {
        nodeId: z.string().optional().describe("Node to screenshot. Omit to use the current selection."),
      },
    },
    async (args) => {
      let raw: string;
      try {
        raw = await callBridgedTool("get_screenshot", args);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      let parsed: { imageData?: string; error?: string };
      try {
        parsed = JSON.parse(raw) as { imageData?: string; error?: string };
      } catch {
        return errorResult(`Malformed screenshot response: ${raw}`);
      }
      if (parsed.error || !parsed.imageData) {
        return errorResult(parsed.error ?? "No image returned.");
      }

      const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(parsed.imageData);
      if (!match) {
        return errorResult("Screenshot response was not a data URL.");
      }
      const [, mimeType, base64Data] = match;
      return { content: [{ type: "image" as const, data: base64Data, mimeType }] };
    },
  );

  server.registerTool(
    "batch_design",
    {
      description: `${BATCH_DESIGN_DESCRIPTION}\n\nCall get_guidelines(topic: "design-system") first for auto-layout rules.`,
      inputSchema: batchDesignInputShape,
    },
    async (rawArgs) => {
      // Reuse the exact same alias-normalization validation the chat tool
      // uses, instead of duplicating it — registerTool's own raw-shape
      // validation can't run this schema's .transform() refinement.
      const parsed = makeBatchDesignInputSchema().safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return callBridged("batch_design", parsed.data);
    },
  );

  server.registerTool(
    "set_variables",
    {
      description: "Add or update design variables and themes. Merges by default; replace=true overwrites all.",
      inputSchema: setVariablesInputShape,
    },
    (args) => callBridged("set_variables", args),
  );

  server.registerTool(
    "read_comments",
    {
      description:
        "Read canvas comment threads (feedback pins). Each thread carries an order number, resolved state, and — when anchored to a node — that node's id and name. Pass threadId for a single thread, or omit it to list all threads.",
      inputSchema: readCommentsInputShape,
    },
    (args) => callBridged("read_comments", args),
  );

  server.registerTool(
    "reply_comment",
    {
      description: "Append a reply to an existing comment thread, authored by you (the agent).",
      inputSchema: replyCommentInputShape,
    },
    (args) => callBridged("reply_comment", args),
  );

  server.registerTool(
    "resolve_comment",
    {
      description: "Mark a comment thread as resolved, after you've addressed what it asked for.",
      inputSchema: resolveCommentInputShape,
    },
    (args) => callBridged("resolve_comment", args),
  );

  server.registerTool(
    "leave_comment",
    {
      description:
        "Drop one or more comment pins authored by you (the agent), each starting a new thread. Pass a batch of 1-50 comments in one call. Each item needs nodeId (anchors to that node's center) or both x and y (a world-space canvas point). Returns the created thread numbers.",
      inputSchema: leaveCommentInputShape,
    },
    (args) => callBridged("leave_comment", args),
  );

  server.registerTool(
    "read_embed_html",
    {
      description:
        "Read part of an existing embed node's HTML without pulling the whole document into context. `outline` (default) returns the tag structure with attributes intact and text/deep subtrees elided; `grep` returns lines matching a literal substring with surrounding context, for byte-exact anchors to feed edit_embed_html; `full` returns the entire HTML. Always read before editing.",
      // registerTool's declared inputSchema is a raw shape (the SDK needs
      // that shape, not a refined ZodEffects, to advertise the tool's JSON
      // schema) — it can't carry the "pattern required when mode is 'grep'"
      // refinement that penTools.read_embed_html enforces via
      // readEmbedHtmlInputSchema. Without re-checking it in the handler
      // below, an invalid grep call (mode: "grep", no pattern) would sail
      // past registration, cross the bridge to the browser tab, occupy a
      // queue slot and the 30s bridge timeout, and only then come back as a
      // handler error — all for a mistake this process could reject
      // instantly.
      inputSchema: readEmbedHtmlInputShape,
    },
    async (rawArgs) => {
      const parsed = readEmbedHtmlInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return callBridged("read_embed_html", parsed.data);
    },
  );

  server.registerTool(
    "edit_embed_html",
    {
      description:
        "Apply targeted text edits to an existing embed node's HTML instead of rewriting the whole screen. Each edit replaces an exact substring (oldString) with newString; an empty newString deletes the match. Use this to change part of a screen that already exists; rewriting the whole htmlContent costs thousands of tokens and silently drifts parts you weren't asked to touch, so reserve that for replacing a screen wholesale with a different concept. Read the fragment with read_embed_html first.",
      inputSchema: editEmbedHtmlInputShape,
    },
    (args) => callBridged("edit_embed_html", args),
  );

  server.registerTool(
    "rename_layers",
    {
      description:
        "Rename one or more layers (nodes) to logical, human-readable names in a single undoable step. Read each layer's type, text content, and hierarchy first (via get_editor_state / batch_get) so the names reflect each layer's role.",
      inputSchema: renameLayersInputShape,
    },
    (args) => callBridged("rename_layers", args),
  );

  server.registerTool(
    "find_empty_space_on_canvas",
    {
      description:
        "Find available empty space on the canvas in a given direction with the specified dimensions. Use before inserting new top-level frames to avoid overlapping.",
      inputSchema: findEmptySpaceOnCanvasInputShape,
    },
    (args) => callBridged("find_empty_space_on_canvas", args),
  );

  server.registerTool(
    "list_skills",
    {
      description:
        "List the curated skill catalog available on this server (name + description). Curated skills only — learned and per-user skills need a userId this MCP session doesn't have. " +
        "This server's tool surface is narrower than the built-in chat agent's, so some catalog entries carry an `unavailableTools` list — call load_skill on those to see the exact warning before relying on them.",
      inputSchema: {},
    },
    async () => {
      await ensureSkillsLoaded();
      const skills = getAllSkills().map((s) => {
        const unavailableTools = getUnavailableToolsForSkill(s);
        // Without this, prototype/slides/research looked "clean" in the
        // catalog (no unavailableTools) even though load_skill warns about
        // all three — the catalog was silent about exactly the entries
        // whose entire MODE is gated (resolveTaskPolicy for prototype/
        // slides, research's Mobbin-token-only reference tools for
        // research), not just missing an individual tool. A caller that
        // only ever reads list_skills (never loads every skill just to
        // check) had no way to see that.
        const policyDependent = POLICY_DEPENDENT_SKILL_NAMES.has(s.name);
        return {
          name: s.name,
          description: s.description,
          ...(unavailableTools.length > 0 ? { unavailableTools } : {}),
          ...(policyDependent ? { policyDependent: true as const } : {}),
        };
      });
      return textResult(JSON.stringify({ notice: getSkillSurfaceNotice(), skills }));
    },
  );

  server.registerTool(
    "load_skill",
    {
      description:
        "Load a curated skill's full instructions by name. Call this when the task matches a skill from list_skills.",
      inputSchema: {
        name: z.string().describe("The exact skill name from list_skills."),
      },
    },
    async ({ name }) => {
      await ensureSkillsLoaded();
      const skill = getSkill(name);
      if (!skill) {
        const available = getAllSkills()
          .map((s) => s.name)
          .join(", ");
        return errorResult(`Unknown skill "${name}". Available skills: ${available}`);
      }
      const warning = getSkillSurfaceWarning(skill);
      return textResult(warning ? `${warning}\n\n${skill.content}` : skill.content);
    },
  );

  server.registerTool(
    "get_guidelines",
    {
      description: "Get design guidelines and rules for a topic (design-system, code, table, tailwind, landing-page).",
      inputSchema: { topic: z.enum(["code", "table", "tailwind", "landing-page", "design-system"]) },
    },
    async ({ topic }) => textResult(JSON.stringify(await getGuidelinesImpl(topic))),
  );

  server.registerTool(
    "get_style_guide_tags",
    {
      description: "Get all available style guide tags. Call before get_style_guide to know which tags to use.",
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await getStyleGuideTagsImpl())),
  );

  server.registerTool(
    "get_style_guide",
    {
      description: "Get a style guide for design inspiration, by tags or by name.",
      inputSchema: { tags: z.array(z.string()).optional(), name: z.string().optional() },
    },
    async (args) => textResult(JSON.stringify(await getStyleGuideImpl(args))),
  );

  return server;
}
