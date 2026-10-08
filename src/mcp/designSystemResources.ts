import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NO_SESSION_MESSAGE } from "./bridge.js";

// MCP resources for the design system of the open document. They are thin
// views over the bridged get_design_system tool, so a client that prefers
// resources to tool calls reads the same data.
//
//   sideform://ds/tokens.json                  all tokens
//   sideform://ds/components.json              all components
//   sideform://ds/{scope}/tokens.json          tokens of a saved scope
//   sideform://ds/{scope}/components.json      components of a saved scope
//
// Reserved for Phase 6 (shared libraries): sideform://ds/lib/{libraryId}/...
// The literal "lib" segment cannot clash with {scope}/tokens.json, because a
// library URI has one more path segment. Do not add a saved-scope named "lib".
//
// No design-system data lives in this file. It is static text plus a bridge call.

export interface BridgedCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export type BridgedCall = (tool: string, args: Record<string, unknown>) => Promise<BridgedCallResult>;

const JSON_MIME = "application/json";
const NO_TAB_HINT = "Open the Sideform editor in a browser tab, then read this resource again.";

type DesignSystemPart = "tokens" | "components";

// The fixed resources have no arguments, so they ask for the largest page the
// tool allows and say so when the result is still cut.
const RESOURCE_LIMIT = 2000;
const TRUNCATED_NOTE =
  "The design system has more items than this resource returns. Call the get_design_system tool with scope and limit to read the rest.";

// True when the bridge reports that no editor tab is connected (legacy or
// per-user wording). Other failures (timeout, unknown tool, handler error)
// keep their own message.
function isNoTabMessage(text: string): boolean {
  return text.includes(NO_SESSION_MESSAGE) || text.startsWith("No Sideform editor is open");
}

// Marks a cut result with a top-level `truncated` field and a note. A result
// that is not a JSON object is returned as it is.
function withTruncationNote(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { truncated?: unknown }).truncated) {
      return JSON.stringify({ ...(parsed as object), truncatedNote: TRUNCATED_NOTE });
    }
  } catch {
    // not JSON: pass through
  }
  return text;
}

async function readPart(call: BridgedCall, uri: URL, part: DesignSystemPart, scope?: string): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const args: Record<string, unknown> = { include: [part], limit: RESOURCE_LIMIT };
  if (scope !== undefined) args.scope = { saved: scope };
  const result = await call("get_design_system", args);
  const text = result.content.map((c) => c.text ?? "").join("");
  if (result.isError) {
    // A resource read has no isError field. A thrown Error becomes a JSON-RPC error.
    throw new Error(
      isNoTabMessage(text)
        ? `Cannot read the design system. ${text} ${NO_TAB_HINT}`
        : `Cannot read the design system. ${text}`,
    );
  }
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: withTruncationNote(text) }] };
}

const first = (value: string | string[]): string => (Array.isArray(value) ? value[0] ?? "" : value);

function decodeScope(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new Error("Invalid scope in resource URI. Percent-encode the scope name, for example Brand%20A.");
  }
}

export function registerDesignSystemResources(server: McpServer, call: BridgedCall): void {
  const parts: Array<{ part: DesignSystemPart; title: string; description: string }> = [
    {
      part: "tokens",
      title: "Design tokens",
      description: "Design tokens of the open document: name, cssName, type, scopes, and raw and resolved values per mode.",
    },
    {
      part: "components",
      title: "Design components",
      description: "Registered components of the open document: key, status, variants, slots, usage, and the tokens each uses.",
    },
  ];

  for (const { part, title, description } of parts) {
    server.registerResource(
      `ds-${part}`,
      `sideform://ds/${part}.json`,
      { title, description, mimeType: JSON_MIME },
      (uri) => readPart(call, uri, part),
    );
    server.registerResource(
      `ds-scope-${part}`,
      new ResourceTemplate(`sideform://ds/{scope}/${part}.json`, { list: undefined }),
      { title: `${title} of a saved scope`, description: `${description} Limited to the saved scope named in the URI.`, mimeType: JSON_MIME },
      (uri, variables) => readPart(call, uri, part, decodeScope(first(variables.scope ?? ""))),
    );
  }
}
