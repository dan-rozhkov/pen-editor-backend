import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LINT_RULE_IDS, getGuidelinesImpl, penTools } from "../src/ai/tools.js";
import { buildMcpInstructions } from "../src/mcp/instructions.js";
import { registerDesignSystemResources, type BridgedCall } from "../src/mcp/designSystemResources.js";
import { BRIDGED_TOOL_NAMES } from "../src/mcp/toolNames.js";
import { TOOL_META, type McpToolName } from "../src/mcp/toolAnnotations.js";

const schemaOf = (name: string) => (penTools[name as keyof typeof penTools] as { inputSchema: z.ZodTypeAny }).inputSchema;
const descriptionOf = (name: string) => (penTools[name as keyof typeof penTools] as { description: string }).description;

describe("get_design_system schema", () => {
  it("accepts an empty call and a full call", () => {
    expect(schemaOf("get_design_system").safeParse({}).success).toBe(true);
    expect(
      schemaOf("get_design_system").safeParse({
        scope: { saved: "Brand", collections: ["Theme"], components: ["btn"], componentStatus: ["stable"], tokenScopes: ["fill"], names: ["--color-*"] },
        mode: { Brand: "B", Theme: "dark" },
        include: ["tokens", "components", "lint"],
        limit: 50,
      }).success,
    ).toBe(true);
    expect(schemaOf("get_design_system").safeParse({ mode: "dark" }).success).toBe(true);
  });

  it.each([
    { include: ["html"] },
    { include: ["library"] },
    { limit: 0 },
    { limit: 1.5 },
    { limit: 5000 },
    { scope: { componentStatus: ["beta"] } },
    { scope: { collections: "Theme" } },
  ])("rejects %j", (bad) => {
    expect(schemaOf("get_design_system").safeParse(bad).success).toBe(false);
  });

  it("describes tokens, components and the cssName rule in plain text", () => {
    const text = descriptionOf("get_design_system");
    for (const part of ["`cssName`", "<c-key>", "`tokenUses`", "`limit`", "deprecated"]) expect(text).toContain(part);
  });
});

describe("lint_design schema", () => {
  it("accepts an empty call and a full call", () => {
    expect(schemaOf("lint_design").safeParse({}).success).toBe(true);
    expect(schemaOf("lint_design").safeParse({ mode: "all" }).success).toBe(true);
    expect(
      schemaOf("lint_design").safeParse({ nodeIds: ["a"], rules: ["contrast"], mode: { Theme: "dark" }, severity: "warning", limit: 10 }).success,
    ).toBe(true);
  });

  it.each([{ rules: ["nope"] }, { severity: "fatal" }, { limit: 0 }, { limit: 1001 }, { nodeIds: "a" }])("rejects %j", (bad) => {
    expect(schemaOf("lint_design").safeParse(bad).success).toBe(false);
  });

  it("says the default is the current mode context and documents mode all", () => {
    expect(descriptionOf("lint_design")).toContain("only the current mode context");
    expect(descriptionOf("lint_design")).toContain('mode: "all"');
  });

  it("names exactly the seven rules in the description", () => {
    expect([...LINT_RULE_IDS]).toHaveLength(7);
    for (const id of LINT_RULE_IDS) expect(descriptionOf("lint_design")).toContain(id);
  });
});

describe("design-system guideline", () => {
  it("tells the agent to call get_design_system and lint_design", async () => {
    const result = await getGuidelinesImpl("design-system");
    expect("guidelines" in result && result.guidelines).toContain("Call `get_design_system` once before you design.");
    expect("guidelines" in result && result.guidelines).toContain("Call `lint_design` after you edit.");
  });
});

describe("bridged style, component and design-system tools", () => {
  const NEW = [
    "get_design_system", "lint_design", "get_styles", "get_text_styles", "set_styles", "set_text_styles",
    "apply_fill_style", "apply_text_style", "apply_effect_style", "define_component", "extract_component",
    "detach_instance", "delete_component",
  ];

  it("are bridged and have penTools schemas", () => {
    for (const name of NEW) {
      expect(BRIDGED_TOOL_NAMES as readonly string[], name).toContain(name);
      expect(name in penTools, name).toBe(true);
    }
  });

  it("annotate reads as read-only, writes as writes, and only the delete/overwrite tools as destructive", () => {
    const meta = (n: string) => TOOL_META[n as McpToolName].annotations;
    for (const n of ["get_design_system", "lint_design", "get_styles", "get_text_styles"]) expect(meta(n).readOnlyHint, n).toBe(true);
    for (const n of NEW.filter((x) => !["get_design_system", "lint_design", "get_styles", "get_text_styles"].includes(x))) {
      expect(meta(n).readOnlyHint, n).toBe(false);
      expect(meta(n).destructiveHint, n).toBe(["delete_component", "set_styles", "set_text_styles", "define_component", "extract_component", "detach_instance"].includes(n));
    }
  });
});

describe("MCP instructions", () => {
  it("stay under 2500 characters and mention the design system and <c-key> tags", () => {
    for (const hasCanvasWidget of [true, false]) {
      const text = buildMcpInstructions({ hasCanvasWidget, appOrigin: "https://app.example.com" });
      expect(text.length).toBeLessThan(2500);
      expect(text).toContain("get_design_system");
      expect(text).toContain("<c-key>");
    }
  });
});

describe("design system MCP resources", () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let failWith: string | null = null;
  let reply: unknown = null;
  const call: BridgedCall = async (tool, args) => {
    calls.push({ tool, args });
    return failWith
      ? { isError: true, content: [{ type: "text", text: failWith }] }
      : { content: [{ type: "text", text: JSON.stringify(reply ?? { schema: 1, args }) }] };
  };
  let client: Client;

  beforeAll(async () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerDesignSystemResources(server, call);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "c", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });

  it("lists the two fixed resources and the two scope templates", async () => {
    expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual([
      "sideform://ds/components.json",
      "sideform://ds/tokens.json",
    ]);
    expect((await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual([
      "sideform://ds/{scope}/components.json",
      "sideform://ds/{scope}/tokens.json",
    ]);
  });

  it("reads tokens and components through get_design_system", async () => {
    calls.length = 0;
    const tokens = await client.readResource({ uri: "sideform://ds/tokens.json" });
    expect(tokens.contents[0]).toMatchObject({ uri: "sideform://ds/tokens.json", mimeType: "application/json" });
    await client.readResource({ uri: "sideform://ds/components.json" });
    expect(calls).toEqual([
      { tool: "get_design_system", args: { include: ["tokens"], limit: 2000 } },
      { tool: "get_design_system", args: { include: ["components"], limit: 2000 } },
    ]);
  });

  it("passes the saved scope from the URI", async () => {
    calls.length = 0;
    await client.readResource({ uri: "sideform://ds/Brand%20A/components.json" });
    expect(calls).toEqual([{ tool: "get_design_system", args: { include: ["components"], limit: 2000, scope: { saved: "Brand A" } } }]);
  });

  it("fails with an open-the-editor message when no tab answers", async () => {
    failWith = "No Sideform editor is open for your account.";
    await expect(client.readResource({ uri: "sideform://ds/tokens.json" })).rejects.toThrow(/Open the Sideform editor in a browser tab/);
    failWith = null;
  });

  it("keeps the real error when the failure is not a missing tab", async () => {
    failWith = "Editor tab is not responding to \"get_design_system\" (no acknowledgement within 30000ms).";
    const read = client.readResource({ uri: "sideform://ds/tokens.json" });
    await expect(read).rejects.toThrow(/not responding/);
    await expect(read).rejects.not.toThrow(/Open the Sideform editor/);
    failWith = null;
  });

  it("adds a truncation note when the result is cut", async () => {
    reply = { schema: 1, tokens: [], truncated: true };
    const { contents } = await client.readResource({ uri: "sideform://ds/tokens.json" });
    reply = null;
    const body = JSON.parse(contents[0].text as string) as { truncated: boolean; truncatedNote: string };
    expect(body.truncated).toBe(true);
    expect(body.truncatedNote).toContain("get_design_system");
  });

  it("rejects a malformed scope with a clear error", async () => {
    await expect(client.readResource({ uri: "sideform://ds/%E0%A4%A/tokens.json" })).rejects.toThrow(/Invalid scope in resource URI/);
  });
});
