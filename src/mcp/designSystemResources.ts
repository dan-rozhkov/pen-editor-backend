import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

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

async function readPart(call: BridgedCall, uri: URL, part: DesignSystemPart, scope?: string): Promise<{
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}> {
  const args: Record<string, unknown> = { include: [part] };
  if (scope !== undefined) args.scope = { saved: scope };
  const result = await call("get_design_system", args);
  const text = result.content.map((c) => c.text ?? "").join("");
  if (result.isError) {
    // A resource read has no isError field. A thrown Error becomes a JSON-RPC error.
    throw new Error(`Cannot read the design system. ${text} ${NO_TAB_HINT}`);
  }
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
}

const first = (value: string | string[]): string => (Array.isArray(value) ? value[0] ?? "" : value);

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
      (uri, variables) => readPart(call, uri, part, decodeURIComponent(first(variables.scope ?? ""))),
    );
  }
}
