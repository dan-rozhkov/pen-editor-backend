import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { connectFakeEditor, waitForSessionCount } from "./mcpEditorHelpers.js";

const TEST_TOKEN = "a".repeat(32);

async function startServer(overrides: Parameters<typeof makeConfig>[0] = {}) {
  const config = makeConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, ...overrides });
  const app = await buildApp(config, { logger: false });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
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
        "read_comments",
        "reply_comment",
        "resolve_comment",
        "leave_comment",
        "read_embed_html",
        "edit_embed_html",
        "rename_layers",
        "find_empty_space_on_canvas",
        "get_design_system",
        "get_styles",
        "get_text_styles",
        "set_styles",
        "set_text_styles",
        "apply_fill_style",
        "apply_text_style",
        "apply_effect_style",
        "define_component",
        "extract_component",
        "detach_instance",
        "delete_component",
        "lint_design",
        "get_guidelines",
        "get_style_guide_tags",
        "get_style_guide",
        "list_skills",
        "load_skill",
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

  it("round-trips get_design_system, lint_design and the design-system resources through the bridge", async () => {
    const editor = await connectFakeEditor(server.url, TEST_TOKEN, {
      get_design_system: JSON.stringify({ schema: 1, tokens: [] }),
      lint_design: JSON.stringify({ summary: { errors: 0 } }),
    });
    await waitForSessionCount(1);
    const client = await connectMcpClient(server.url, TEST_TOKEN);
    const textOf = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0].text;

    const ds = await client.callTool({ name: "get_design_system", arguments: { include: ["tokens"] } });
    expect(ds.isError).toBeFalsy();
    expect(JSON.parse(textOf(ds))).toEqual({ schema: 1, tokens: [] });
    const lint = await client.callTool({ name: "lint_design", arguments: { rules: ["contrast"] } });
    expect(JSON.parse(textOf(lint))).toEqual({ summary: { errors: 0 } });
    const bad = await client.callTool({ name: "lint_design", arguments: { rules: ["nope"] } });
    expect(bad.isError).toBe(true);

    const resource = await client.readResource({ uri: "sideform://ds/tokens.json" });
    expect(JSON.parse(resource.contents[0].text as string)).toEqual({ schema: 1, tokens: [] });
    expect((await client.listResources()).resources.map((r) => r.uri)).toContain("sideform://ds/tokens.json");

    await client.close();
    editor.close();
    await waitForSessionCount(0);
  });

  it("rejects a design-system resource read without an editor tab with an open-the-editor message", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);
    await expect(client.readResource({ uri: "sideform://ds/components.json" })).rejects.toThrow(
      /Open the Sideform editor in a browser tab/,
    );
    await client.close();
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

  // Defect 2 regression: penTools.read_embed_html's zod schema refines that
  // `pattern` is required when `mode: "grep"`, but registerTool's declared
  // inputSchema is the raw shape (registerTool can't take a refined
  // ZodEffects) — so before the handler re-validated, an invalid grep call
  // sailed straight past registration and reached the bridge (occupying a
  // queue slot and the 30s timeout) before ever being rejected. This asserts
  // it is now rejected LOCALLY, with no editor tab connected at all — if it
  // reached the bridge instead, it would fail with "No Pen Editor tab is
  // connected", not this message.
  it("rejects an invalid read_embed_html grep call before it reaches the bridge", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);

    const result = await client.callTool({
      name: "read_embed_html",
      arguments: { nodeId: "n1", mode: "grep" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("pattern is required when mode is 'grep'");
    expect(JSON.stringify(result.content)).not.toContain("No Pen Editor tab is connected");

    await client.close();
  });

  it("still forwards a valid read_embed_html grep call to the bridge", async () => {
    const editor = await connectFakeEditor(server.url, TEST_TOKEN, {
      read_embed_html: JSON.stringify({ matches: [] }),
    });
    await waitForSessionCount(1);

    const client = await connectMcpClient(server.url, TEST_TOKEN);
    const result = await client.callTool({
      name: "read_embed_html",
      arguments: { nodeId: "n1", mode: "grep", pattern: "hello" },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("matches");

    await client.close();
    editor.close();
    await waitForSessionCount(0);
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
