import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { buildMcpInstructions } from "../src/mcp/instructions.js";
import { findTopLevelNativeInsert, makeBatchDesignInputSchema } from "../src/ai/tools.js";
import { connectFakeEditor, waitForSessionCount } from "./mcpEditorHelpers.js";
import { getSkillSurfaceWarning } from "../src/mcp/skillSurface.js";
import { ensureSkillsLoaded, getSkill } from "../src/ai/skills.js";

const TOKEN = "a".repeat(32);

describe("findTopLevelNativeInsert", () => {
  it("rejects a document-level frame, and a type-less insert (defaults to frame)", () => {
    expect(findTopLevelNativeInsert('s=I(document, {type: "frame", name: "A"})')).toBe("frame");
    expect(findTopLevelNativeInsert('s=I(document, {name: "A"})')).toBe("frame");
    expect(findTopLevelNativeInsert('I("document", {type: "rect"})')).toBe("rect");
  });
  it("allows a document-level embed", () => {
    expect(findTopLevelNativeInsert('s=I(document, {type: "embed", htmlContent: "<p>x</p>"})')).toBeNull();
  });
  it("rejects group/rect/frame but allows annotation types and embeds at root", () => {
    expect(findTopLevelNativeInsert('I(document, {type: "group"})')).toBe("group");
    for (const t of ["connector", "text", "line", "path", "polygon", "ellipse", "ref", "embed"]) {
      expect(findTopLevelNativeInsert(`I(document, {type: "${t}"})`)).toBeNull();
    }
    // Native components were removed (pen-editor f020802a): `reusable` no longer exempts a frame.
    expect(findTopLevelNativeInsert('I(document, {type: "frame", reusable: true, name: "Button"})')).toBe("frame");
  });
  it("allows native children inside existing nodes or bindings", () => {
    expect(findTopLevelNativeInsert('I("existingFrameId", {type: "frame"})')).toBeNull();
    expect(findTopLevelNativeInsert('s=I(document, {type: "embed"})\nI(s, {type: "text"})')).toBeNull();
  });
  it("cannot judge R() and C(): both pass", () => {
    expect(findTopLevelNativeInsert('R("someId", {type: "frame"})')).toBeNull();
    expect(findTopLevelNativeInsert('c=C("srcId", document, {})')).toBeNull();
  });
  it("is off by default and does not affect the chat schema", () => {
    const ops = 'I(document, {type: "frame"})';
    expect(makeBatchDesignInputSchema().safeParse({ operations: ops }).success).toBe(true);
    const guarded = makeBatchDesignInputSchema({ topLevelEmbedOnly: true }).safeParse({ operations: ops });
    expect(guarded.success).toBe(false);
    expect(JSON.stringify(guarded.error?.issues)).toContain("Top-level screens must be embeds");
  });
});

describe("MCP embed-first behaviour", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let url: string;
  beforeAll(async () => {
    app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: TOKEN }), { logger: false });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await app.close();
  });

  it("is compact and carries the key rules; open_canvas only with the widget", () => {
    const widget = buildMcpInstructions({ hasCanvasWidget: true, appOrigin: "https://x.test" });
    const legacy = buildMcpInstructions({ hasCanvasWidget: false });
    expect(widget.length).toBeLessThan(2500);
    for (const s of ['load_skill("prototype")', "ONE top-level `embed`", "open_canvas", "picsum", "ask_user", "https://x.test/app"]) {
      expect(widget).toContain(s);
    }
    expect(legacy).not.toContain("open_canvas");
    expect(legacy).toContain("ask the user to open it");
  });

  it("sends instructions in the initialize result of /api/mcp", async () => {
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    expect(client.getInstructions()).toBe(buildMcpInstructions({ hasCanvasWidget: false }));
    expect(client.getInstructions()).not.toContain("open_canvas");
    const tools = await client.listTools();
    const bd = tools.tools.find((t) => t.name === "batch_design");
    expect(bd?.description).not.toContain("first for auto-layout rules");
    expect(bd?.description).toContain("one top-level embed per screen");
    expect(bd?.description).toContain("native frames, call get_guidelines");
    await client.close();
  });

  it("rejects a top-level native frame without reaching the bridge, allows an embed", async () => {
    const calls: string[] = [];
    const editor = await connectFakeEditor(url, TOKEN, {});
    editor.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; tool: string };
      if (m.type === "tool_call") calls.push(m.tool);
    });
    await waitForSessionCount(1);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const bad = await client.callTool({
      name: "batch_design",
      arguments: { operations: 's=I(document, {type: "frame", name: "Home"})' },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("Top-level screens must be embeds");
    expect(calls).not.toContain("batch_design");

    const ok = await client.callTool({
      name: "batch_design",
      arguments: { operations: 's=I(document, {type: "embed", name: "Home", htmlContent: "<p>x</p>"})' },
    });
    expect(ok.isError).toBeFalsy();
    expect(calls).toContain("batch_design");
    await client.close();
    editor.close();
    await waitForSessionCount(0);
  });

  it("prototype skill warning says the embed guard applies", async () => {
    await ensureSkillsLoaded();
    const skill = getSkill("prototype");
    expect(skill).toBeDefined();
    const warning = getSkillSurfaceWarning(skill!);
    expect(warning).toContain("embed-only rule DOES apply");
    expect(warning).not.toContain("inapplicable");
  });
});
