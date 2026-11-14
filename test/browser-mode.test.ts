import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { AGENT_MODES } from "../src/ai/system-prompt.js";
import { makeConfig } from "./helpers.js";
import { resetChatMocks, userMessage } from "./chatMocks.js";
import { postChat, startApp, toolsSentFor, type RunningApp } from "./chatHarness.js";

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

// What Sideform Light sends (CONTRACT.md "Backend").
const LIGHT_CAPS = {
  desktopBrowser: true,
  browser: "desktop" as const,
  browseQa: true,
  browseIsolation: true,
  browseAssert: true,
  traceTabs: true,
};
const EXPECTED_TOOLS = ["analyze_image", "ask_user", "browse_agent", "trace_list", "trace_read"];

let server: RunningApp;

beforeAll(async () => {
  await loadSkills();
  server = await startApp(makeConfig({ BROWSE_MODE: "agent" }));
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  resetChatMocks();
});

describe("agentMode browser", () => {
  it("is a known agent mode and the route accepts it", async () => {
    expect(AGENT_MODES).toContain("browser");
    const res = await postChat(server.url, {
      messages: [userMessage("find the cheapest flight")],
      agentMode: "browser",
      clientCapabilities: LIGHT_CAPS,
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("400s browse_agent_disabled when BROWSE_MODE is not agent", async () => {
    const own = await startApp(makeConfig({ BROWSE_MODE: "manual" }));
    try {
      const res = await postChat(own.url, { messages: [userMessage("hi")], agentMode: "browser" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("browse_agent_disabled");
    } finally {
      await own.close();
    }
  });

  it("400s browser_required when the client reports no browser", async () => {
    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      agentMode: "browser",
      clientCapabilities: {},
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("browser_required");
  });

  it("offers browse_agent without the canvas `capture` param", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("compare two laptops")],
      agentMode: "browser",
      clientCapabilities: LIGHT_CAPS,
    });
    const tool = turn.tools.browse_agent as { inputSchema: { shape?: Record<string, unknown>; _def?: unknown }; description?: string };
    const json = JSON.stringify(await (await import("ai")).asSchema(tool.inputSchema as never).jsonSchema);
    expect(json).toContain('"goal"');
    expect(json).not.toContain('"capture"');
    expect(tool.description).not.toContain("capture");
    expect(tool.description).not.toContain("canvas");
  });

  it("keeps `capture` on browse_agent in edits mode", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("copy that page")],
      clientCapabilities: LIGHT_CAPS,
    });
    const tool = turn.tools.browse_agent as { inputSchema: never };
    const json = JSON.stringify(await (await import("ai")).asSchema(tool.inputSchema).jsonSchema);
    expect(json).toContain('"capture"');
  });

  it("parallel prompt bullet does not mention qa and explains login for isolated sessions", async () => {
    const { buildBrowserModePrompt } = await import("../src/ai/system-prompt.js");
    const prompt = buildBrowserModePrompt({ isolated: true });
    expect(prompt).not.toMatch(/`qa`/);
    expect(prompt).toContain("without the user's cookies");
    expect(prompt).toContain("browse_fill_login");
  });

  it("offers exactly the browser tool set for the Light capabilities, with no canvas tool", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("compare two laptops")],
      agentMode: "browser",
      clientCapabilities: LIGHT_CAPS,
    });
    expect(Object.keys(turn.tools).sort()).toEqual(EXPECTED_TOOLS);
    for (const name of ["get_editor_state", "batch_design", "open_canvas_tab", "trace_frame", "get_guidelines", "load_skill"]) {
      expect(turn.tools[name]).toBeUndefined();
    }
  });

  it("sends the same tool set over HTTP", async () => {
    const sent = await toolsSentFor(server.url, "compare two laptops", {
      agentMode: "browser",
      clientCapabilities: LIGHT_CAPS,
    });
    expect([...sent].sort()).toEqual(EXPECTED_TOOLS);
  });

  it("drops browse and trace tools when the client has no browser or trace tabs", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("hi")],
      agentMode: "browser",
      clientCapabilities: {},
    });
    expect(turn.tools.browse_agent).toBeUndefined();
    expect(turn.tools.trace_list).toBeUndefined();
    expect(turn.tools.trace_read).toBeUndefined();
  });

  it("keeps the system prompt constant across different canvasContext values and renders none of it", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const run = (canvasContext: string) =>
      prepareChatTurn({
        config: makeConfig({ BROWSE_MODE: "agent" }),
        messages: [userMessage("find a recipe")],
        agentMode: "browser",
        clientCapabilities: LIGHT_CAPS,
        canvasContext,
      });
    const a = await run('{"roots":["frame-1"],"selectedIds":["x"]}');
    const b = await run('{"roots":["frame-2"],"selectedIds":[]}');
    expect(a.system).toBe(b.system);
    expect(a.systemPromptHash).toBe(b.systemPromptHash);
    expect(a.system).not.toContain("frame-1");
    expect(JSON.stringify(a.modelMessages)).not.toContain("canvas_context");
    expect(a.system).toContain("browse_agent");
    expect(a.system).toContain("in parallel");
  });

  it("does not resolve a slash skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("/prototype a login screen")],
      agentMode: "browser",
      clientCapabilities: LIGHT_CAPS,
    });
    expect(turn.slashSkillName).toBeUndefined();
    expect(turn.taskPolicy).toBe("native");
  });
});
