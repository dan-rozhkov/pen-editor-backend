import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { sessionCount } from "../src/mcp/bridge.js";
import { makeConfig } from "./helpers.js";

const TEST_TOKEN = "a".repeat(32);

async function startServer(overrides: Parameters<typeof makeConfig>[0] = {}) {
  const config = makeConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, ...overrides });
  const app = await buildApp(config, { logger: false });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

function wsUrlFor(httpUrl: string, token: string | null): string {
  const base = httpUrl.replace(/^http/, "ws");
  return token ? `${base}/api/mcp/ws?token=${encodeURIComponent(token)}` : `${base}/api/mcp/ws`;
}

// Connects a fake editor tab and answers every tool_call with a canned
// result recognizable by tool name, so tests can assert the round trip
// without a real browser.
function connectFakeEditor(
  httpUrl: string,
  token: string,
  resultOverrides: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrlFor(httpUrl, token));
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; type: string; tool: string };
      if (message.type !== "tool_call") return;
      const result =
        resultOverrides[message.tool] ??
        (message.tool === "get_editor_state"
          ? JSON.stringify({ file: "demo.pen" })
          : "{}");
      socket.send(JSON.stringify({ id: message.id, type: "tool_result", result }));
    });
  });
}

async function waitForSessionCount(target: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (sessionCount() !== target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for session count ${target}, got ${sessionCount()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectMcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP server integration", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.app.close();
  });

  it("lists the curated tool set and round-trips a bridged + a static call", async () => {
    const editor = await connectFakeEditor(server.url, TEST_TOKEN);
    await waitForSessionCount(1);

    const client = await connectMcpClient(server.url, TEST_TOKEN);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_editor_state",
        "batch_get",
        "snapshot_layout",
        "get_variables",
        "get_screenshot",
        "batch_design",
        "set_variables",
        "get_guidelines",
        "get_style_guide_tags",
        "get_style_guide",
      ].sort(),
    );

    const bridged = await client.callTool({
      name: "get_editor_state",
      arguments: { include_schema: false },
    });
    expect(bridged.isError).toBeFalsy();
    expect(JSON.stringify(bridged.content)).toContain("demo.pen");

    const staticResult = await client.callTool({
      name: "get_guidelines",
      arguments: { topic: "design-system" },
    });
    expect(staticResult.isError).toBeFalsy();
    expect(JSON.stringify(staticResult.content)).toContain("Auto-Layout");

    await client.close();
    editor.close();
    await waitForSessionCount(0);
  });

  it("maps a resolved-but-failed bridged result (executeToolCall's JSON error shape) to isError:true", async () => {
    // The frontend's executeToolCall() never rejects a bridged call — a
    // thrown handler error is caught there and resolved as
    // `JSON.stringify({ error: message })` (see pen-editor's
    // useDesignChat.ts). callBridged() must detect that shape and report it
    // as an MCP error result instead of a fake success.
    const editor = await connectFakeEditor(server.url, TEST_TOKEN, {
      batch_get: JSON.stringify({ error: "Node not found: xyz" }),
    });
    await waitForSessionCount(1);

    const client = await connectMcpClient(server.url, TEST_TOKEN);
    const result = await client.callTool({ name: "batch_get", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Node not found: xyz");

    await client.close();
    editor.close();
    await waitForSessionCount(0);
  });

  it("returns an MCP error result, not a crash, when no editor tab is connected", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);

    const result = await client.callTool({ name: "batch_get", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No Pen Editor tab is connected");

    await client.close();
  });

  it("no longer rejects a batch_design call with more than 25 operations — it now reaches the bridge for client-side truncation", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);
    const tooMany = Array.from({ length: 26 }, (_, i) => `D("n${i}")`).join("\n");

    const result = await client.callTool({ name: "batch_design", arguments: { operations: tooMany } });
    // No editor tab is connected in this test, so the call still errors —
    // but now from the bridge (no connected tab), not from op-count validation.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No Pen Editor tab is connected");
    expect(JSON.stringify(result.content)).not.toContain("Too many operations");

    await client.close();
  });
});

describe("MCP auth matrix", () => {
  // MCP_AUTH_TOKEN unset now means auto-token mode (see
  // test/mcp-auto-token.test.ts for the full auto-token flow), not a
  // disabled surface — a loopback request with no token gets 401 (bad
  // credentials), not 503 (feature off).
  it("returns 401, not 503, when MCP_AUTH_TOKEN is unset (auto-token mode, wrong/no credentials)", async () => {
    const app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);

    await app.close();
  });

  it("returns 401 for a wrong bearer token", async () => {
    const server = await startServer();

    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);

    await server.app.close();
  });

  it("rejects the WS upgrade when the token is wrong", async () => {
    const server = await startServer();

    await expect(connectFakeEditor(server.url, "wrong-token")).rejects.toBeDefined();

    await server.app.close();
  });
});
