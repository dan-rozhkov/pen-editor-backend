// Fake editor tabs for MCP bridge tests: a real WebSocket client that answers
// every tool_call with a canned result, so tests can assert a round trip (and
// which tab answered) without a browser.
import { WebSocket } from "ws";
import { expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_META, type McpToolName } from "../src/mcp/toolAnnotations.js";
import { APP_ORIGIN } from "./authHarness.js";
import { sessionCount } from "../src/mcp/bridge.js";

// A string is the legacy `?token=`; `{ cookie }` is a session-cookie upgrade;
// `{ ticket }` is the MCP App widget's one-time `?ticket=` (no Origin sent).
// `origin` defaults to the trusted app origin: a browser always sends one.
export type EditorCredential = string | { cookie: string; origin?: string } | { ticket: string };

function wsUrlFor(httpUrl: string, credential: EditorCredential | null): string {
  const base = `${httpUrl.replace(/^http/, "ws")}/api/mcp/ws`;
  if (typeof credential === "string") return `${base}?token=${encodeURIComponent(credential)}`;
  return credential && "ticket" in credential ? `${base}?ticket=${encodeURIComponent(credential.ticket)}` : base;
}

export function connectFakeEditor(
  httpUrl: string,
  credential: EditorCredential | null,
  resultOverrides: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers = credential && typeof credential === "object" && "cookie" in credential
        ? { Cookie: credential.cookie, Origin: credential.origin ?? APP_ORIGIN }
        : undefined;
    const socket = new WebSocket(wsUrlFor(httpUrl, credential), { headers });
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("unexpected-response", (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; type: string; tool: string };
      if (message.type !== "tool_call") return;
      const result =
        resultOverrides[message.tool] ??
        (message.tool === "get_editor_state" ? JSON.stringify({ file: "demo.pen" }) : "{}");
      socket.send(JSON.stringify({ id: message.id, type: "tool_result", result }));
    });
  });
}

export async function waitForSessionCount(target: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (sessionCount() !== target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for session count ${target}, got ${sessionCount()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Every listed tool must carry the annotations OpenAI app review checks, and
// match the central TOOL_META table (so an unannotated new tool fails here).
export function expectAnnotatedTools(tools: Tool[]): void {
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    const meta = TOOL_META[tool.name as McpToolName];
    expect(meta, `${tool.name} missing from TOOL_META`).toBeDefined();
    expect(tool.title, tool.name).toBeTruthy();
    expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf("boolean");
    expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    expect(tool.annotations, tool.name).toMatchObject(meta.annotations);
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of ["batch_design", "set_variables", "edit_embed_html", "rename_layers", "reply_comment", "resolve_comment", "leave_comment"]) {
    const annotations = byName.get(name)?.annotations;
    expect(annotations?.readOnlyHint, name).toBe(false);
    expect(annotations?.idempotentHint, name).toBe(false);
    expect(annotations?.destructiveHint, name).toBe(name === "batch_design" || name === "set_variables");
  }
}
