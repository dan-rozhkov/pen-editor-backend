import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import {
  AGENT_BROWSER_GUIDANCE,
  BROWSE_AGENT_LOGIN_PROMPT,
  BROWSE_AGENT_PROMPT,
  MANUAL_BROWSER_GUIDANCE,
  browseAgentPrompt,
} from "../src/ai/system-prompt.js";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

const MARK = "<browser_secrets>";
const PLACEHOLDER_RULE = "text of the form `{{secret:<name>}}`";
const DESKTOP_SECRETS = { desktopBrowser: true, browseSecrets: true };

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

async function prepare(overrides: Record<string, unknown>) {
  const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
  return prepareChatTurn({
    config: makeConfig({ BROWSE_MODE: "agent" }),
    messages: [userMessage("sign in")],
    ...overrides,
  });
}

function lastText(turn: { modelMessages: { content: unknown }[] }): string {
  const content = turn.modelMessages[turn.modelMessages.length - 1].content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

describe("browse secrets", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("puts a <browser_secrets> user message last, after canvas_context", async () => {
    const turn = await prepare({
      clientCapabilities: DESKTOP_SECRETS,
      canvasContext: "frames: none",
      browseSecrets: ["github_password", "mail", "github_password"],
    });
    const last = turn.modelMessages[turn.modelMessages.length - 1];
    expect(last.role).toBe("user");
    const text = lastText(turn);
    expect(text).toContain(MARK);
    expect(text).toContain("- {{secret:github_password}}\n- {{secret:mail}}\n</browser_secrets>");
    expect(text.match(/github_password/g)).toHaveLength(1);
    expect(JSON.stringify(turn.modelMessages[turn.modelMessages.length - 2])).toContain("<canvas_context>");
  });

  it("adds no message without the capability, even when names are given", async () => {
    const turn = await prepare({ clientCapabilities: { desktopBrowser: true }, browseSecrets: ["x"] });
    expect(JSON.stringify(turn.modelMessages)).not.toContain(MARK);
  });

  it("adds no message without names or without a browser", async () => {
    const empty = await prepare({ clientCapabilities: DESKTOP_SECRETS, browseSecrets: [] });
    expect(JSON.stringify(empty.modelMessages)).not.toContain(MARK);
    const noBrowser = await prepare({ clientCapabilities: { browseSecrets: true }, browseSecrets: ["x"] });
    expect(JSON.stringify(noBrowser.modelMessages)).not.toContain(MARK);
  });

  it("gives the browse subagent the message and the placeholder rule", async () => {
    const turn = await prepare({
      agentMode: "browse",
      clientCapabilities: DESKTOP_SECRETS,
      browseSecrets: ["bank"],
    });
    expect(lastText(turn)).toContain("- {{secret:bank}}");
    expect(turn.system).toContain(PLACEHOLDER_RULE);
    expect(turn.system).toBe(browseAgentPrompt({ secrets: true }));
    const off = await prepare({ agentMode: "browse", clientCapabilities: { desktopBrowser: true }, browseSecrets: ["bank"] });
    expect(off.system).toBe(BROWSE_AGENT_PROMPT);
    expect(JSON.stringify(off.modelMessages)).not.toContain(MARK);
  });

  it("renders the main-chat secrets bullet only with the capability, constant across name lists", async () => {
    const withCap = await prepare({ clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["a"] });
    const withCap2 = await prepare({ clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["b", "c"] });
    const noNames = await prepare({ clientCapabilities: DESKTOP_SECRETS });
    const without = await prepare({ clientCapabilities: { desktopBrowser: true }, browseSecrets: ["a"] });
    expect(withCap.system).toContain(AGENT_BROWSER_GUIDANCE);
    expect(withCap.system).toContain("- Passwords: the user adds a secret");
    expect(withCap2.system).toBe(withCap.system);
    expect(noNames.system).toBe(withCap.system);
    expect(without.system).not.toContain("- Passwords: the user adds a secret");
    expect(withCap.system).not.toContain("{{secret:a}}");
  });

  it("tells the main chat to use the goal in agent mode, browse_act in manual mode and the subagent", async () => {
    const agent = await prepare({ clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["a"] });
    expect(lastText(agent)).toContain("in the browse_agent goal");
    expect(lastText(agent)).not.toContain("browse_act");
    const manual = await prepare({ config: makeConfig({ BROWSE_MODE: "manual" }), clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["a"] });
    expect(lastText(manual)).toContain('browse_act "type"');
    const sub = await prepare({ agentMode: "browse", clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["a"] });
    expect(lastText(sub)).toContain('browse_act "type"');
  });

  it("gives the main chat nothing in task mode, but the subagent still gets it", async () => {
    const config = makeConfig({ BROWSE_MODE: "task", TYPESAFE_API_KEY: "k" });
    const turn = await prepare({ config, clientCapabilities: DESKTOP_SECRETS, browseSecrets: ["a"] });
    expect(JSON.stringify(turn.modelMessages)).not.toContain(MARK);
    expect(turn.system).not.toContain("- Passwords: the user adds a secret");
    expect(turn.system).not.toContain("Never type a password that is not a placeholder");
  });

  it("adds the manual-mode exception only with the capability", async () => {
    const config = makeConfig({ BROWSE_MODE: "manual" });
    const withCap = await prepare({ config, clientCapabilities: DESKTOP_SECRETS });
    const without = await prepare({ config, clientCapabilities: { desktopBrowser: true } });
    expect(withCap.system).toContain(MANUAL_BROWSER_GUIDANCE);
    expect(withCap.system).toContain("Never type a password that is not a placeholder");
    expect(without.system).not.toContain("Never type a password that is not a placeholder");
  });
});

describe("browseAgentPrompt secrets flag", () => {
  it("includes the placeholder bullet only when secrets is true", () => {
    expect(browseAgentPrompt({ secrets: true })).toContain(PLACEHOLDER_RULE);
    expect(browseAgentPrompt()).not.toContain(PLACEHOLDER_RULE);
    expect(browseAgentPrompt({ qa: true, secrets: true })).toContain(PLACEHOLDER_RULE);
    expect(browseAgentPrompt({ qa: true })).not.toContain(PLACEHOLDER_RULE);
  });

  it("keeps both bullets when login and secrets are on, without contradiction", () => {
    const both = browseAgentPrompt({ login: true, secrets: true });
    expect(both).toContain("browse_fill_login");
    expect(both).toContain("`{{secret:<name>}}` exactly as written");
    expect(both.match(/Exception to the password rule/g)).toHaveLength(1);
    expect(both).toContain("call `browse_fill_login` first");
    expect(browseAgentPrompt({ login: true })).toBe(BROWSE_AGENT_LOGIN_PROMPT);
    expect(BROWSE_AGENT_LOGIN_PROMPT).toContain("Never type a password yourself. After it");
    expect(BROWSE_AGENT_LOGIN_PROMPT).not.toContain(PLACEHOLDER_RULE);
  });
});
