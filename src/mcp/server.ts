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
} from "../ai/tools.js";
import { callTool as callBridgedTool } from "./bridge.js";

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
] as const;

export const STATIC_TOOL_NAMES = ["get_guidelines", "get_style_guide_tags", "get_style_guide"] as const;

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
        "Get the current editor state: active .pen file, user selection, top-level nodes, and available components. Call this first — Figma's metadata-first pattern.",
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
      description: `${BATCH_DESIGN_DESCRIPTION}\n\nCall get_guidelines(topic: "design-system") first for auto-layout and component-usage rules.`,
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
