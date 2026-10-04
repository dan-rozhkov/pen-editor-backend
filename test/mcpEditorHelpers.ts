// Fake editor tabs for MCP bridge tests: a real WebSocket client that answers
// every tool_call with a canned result, so tests can assert a round trip (and
// which tab answered) without a browser.
import { WebSocket } from "ws";
import { APP_ORIGIN } from "./authHarness.js";
import { sessionCount } from "../src/mcp/bridge.js";

// A string is the legacy `?token=`; `{ cookie }` is a session-cookie upgrade.
// `origin` defaults to the trusted app origin: a browser always sends one.
export type EditorCredential = string | { cookie: string; origin?: string };

function wsUrlFor(httpUrl: string, credential: EditorCredential | null): string {
  const base = `${httpUrl.replace(/^http/, "ws")}/api/mcp/ws`;
  return typeof credential === "string" ? `${base}?token=${encodeURIComponent(credential)}` : base;
}

export function connectFakeEditor(
  httpUrl: string,
  credential: EditorCredential | null,
  resultOverrides: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers = credential && typeof credential === "object"
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
