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

describe("schedule tools", () => {
  const SCHEDULE_CAPS = { ...LIGHT_CAPS, schedules: true };
  const SCHEDULE_TOOLS = ["schedule_create", "schedule_list", "schedule_set_enabled", "schedule_delete"];
  const turnFor = async (agentMode: "browser" | "browse" | "edits", clientCapabilities: Record<string, unknown>) => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    return prepareChatTurn({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      messages: [userMessage("check prices every morning")],
      agentMode,
      clientCapabilities,
    });
  };

  it("offers both tools, without execute, in browser mode with schedules", async () => {
    const turn = await turnFor("browser", SCHEDULE_CAPS);
    expect(Object.keys(turn.tools).sort()).toEqual([...EXPECTED_TOOLS, ...SCHEDULE_TOOLS].sort());
    expect(turn.tools.schedule_create?.execute).toBeUndefined();
    expect(turn.tools.schedule_list?.execute).toBeUndefined();
    expect(turn.tools.schedule_set_enabled?.execute).toBeUndefined();
    expect(turn.tools.schedule_delete?.execute).toBeUndefined();
    expect(turn.system).toContain("## Schedules");
  });

  it("sends the schedule tools over HTTP", async () => {
    const sent = await toolsSentFor(server.url, "every monday check the news", {
      agentMode: "browser",
      clientCapabilities: SCHEDULE_CAPS,
    });
    expect([...sent].sort()).toEqual([...EXPECTED_TOOLS, ...SCHEDULE_TOOLS].sort());
  });

  it("omits the tools and the prompt section without the schedules flag", async () => {
    const turn = await turnFor("browser", LIGHT_CAPS);
    expect(Object.keys(turn.tools).sort()).toEqual(EXPECTED_TOOLS);
    expect(turn.system).not.toContain("schedule");
  });

  it("never offers them in edits mode or to a browse subagent", async () => {
    for (const mode of ["edits", "browse"] as const) {
      const turn = await turnFor(mode, SCHEDULE_CAPS);
      for (const name of SCHEDULE_TOOLS) expect(turn.tools[name]).toBeUndefined();
    }
  });

  it("keeps the schedule tools out of penTools", async () => {
    const { penTools } = await import("../src/ai/tools.js");
    for (const name of SCHEDULE_TOOLS) expect(Object.keys(penTools)).not.toContain(name);
  });

  it("builds the same prompt with schedules false or omitted, and no schedule text", async () => {
    const { buildBrowserModePrompt } = await import("../src/ai/system-prompt.js");
    for (const isolated of [false, true]) {
      const off = buildBrowserModePrompt({ isolated, schedules: false });
      expect(off).toBe(buildBrowserModePrompt({ isolated }));
      expect(off).not.toContain("schedule");
      const on = buildBrowserModePrompt({ isolated, schedules: true });
      expect(on).toContain("## Schedules");
      expect(on).toContain("`schedule_create`");
      expect(on).toContain("`schedule_list`");
      expect(on).toContain("`schedule_set_enabled`");
      expect(on).toContain("`schedule_delete`");
      expect(on).toContain("Settings > Schedules");
      expect(off).not.toContain("schedule_set_enabled");
    }
  });

  it("validates the id and enabled of schedule_set_enabled and schedule_delete", async () => {
    const { scheduleSetEnabledInputSchema, scheduleDeleteInputSchema } = await import("../src/ai/scheduleTools.js");
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "abc_DEF-123", enabled: false }).success).toBe(true);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "a".repeat(128), enabled: true }).success).toBe(true);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "a".repeat(129), enabled: true }).success).toBe(false);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "", enabled: true }).success).toBe(false);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "has space", enabled: true }).success).toBe(false);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "a/b", enabled: true }).success).toBe(false);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "abc", enabled: "yes" }).success).toBe(false);
    expect(scheduleSetEnabledInputSchema.safeParse({ id: "abc" }).success).toBe(false);
    expect(scheduleDeleteInputSchema.safeParse({ id: "abc-1" }).success).toBe(true);
    expect(scheduleDeleteInputSchema.safeParse({ id: "../x" }).success).toBe(false);
    expect(scheduleDeleteInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts only 5-field cron expressions", async () => {
    const { scheduleCreateInputSchema } = await import("../src/ai/scheduleTools.js");
    const base = { name: "n", prompt: "p" };
    for (const cron of ["0 9 * * 1-5", "*/15 * * * *", "0 9 * JAN MON-FRI", "0 8,20 1 * *", " 0 9 * * * "]) {
      expect(scheduleCreateInputSchema.safeParse({ ...base, cron }).success, cron).toBe(true);
    }
    for (const cron of ["@daily", "0 0 9 * * 1", "0 9 * *", "every morning at 9", "0 9 * * ?!", "0 9 * * 1;rm"]) {
      const r = scheduleCreateInputSchema.safeParse({ ...base, cron });
      expect(r.success, cron).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toContain("Use 5 fields");
    }
  });

  it("validates the input lengths", async () => {
    const { scheduleCreateInputSchema } = await import("../src/ai/scheduleTools.js");
    const ok = { name: "n", prompt: "p", cron: "0 9 * * *" };
    expect(scheduleCreateInputSchema.safeParse(ok).success).toBe(true);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, name: "" }).success).toBe(false);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, name: "n".repeat(101) }).success).toBe(false);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, prompt: "p".repeat(20001) }).success).toBe(false);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, prompt: "p".repeat(20000) }).success).toBe(true);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, cron: "" }).success).toBe(false);
    expect(scheduleCreateInputSchema.safeParse({ ...ok, cron: "x".repeat(101) }).success).toBe(false);
  });
});
