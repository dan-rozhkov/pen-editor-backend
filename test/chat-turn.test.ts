import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

// prepareChatTurn calls createModel(config, modelOverride), which needs a
// real OpenRouter provider construction only — createModel itself doesn't
// make network calls, it just builds a LanguageModel descriptor, so no mock
// is required here (unlike test/chat-route.test.ts, which mocks it to swap
// in MockLanguageModelV3 for streaming).

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("prepareChatTurn", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("routes a /prototype slash command to a non-native task policy with the embed-only batch_design variant", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const skill = getSkill("prototype");
    expect(skill).toBeDefined();

    const config = makeConfig();
    const messages = [userMessage("/prototype a login screen")];

    const turn = await prepareChatTurn({ config, messages });

    expect(turn.taskPolicy).toBe("prototype");
    expect(turn.slashSkillName).toBe("prototype");
    expect(turn.tools.batch_design).toBeDefined();

    // The embed-only variant is a distinct tool instance from the default
    // penTools.batch_design (schema swapped in resolveTaskPolicy branch).
    const { penTools } = await import("../src/ai/tools.js");
    expect(turn.tools.batch_design).not.toBe(penTools.batch_design);
  });

  // Regression: prepareChatTurn used to assume some *other* code had already
  // called loadSkills() — true for the HTTP server (src/index.ts does it at
  // boot), false for the showcase runner, which is a separate process. There,
  // every skill lookup resolved to nothing and the turn was assembled with no
  // skill instructions, no skill catalog in the system prompt, and a
  // load_skill tool that could not resolve a name. Nothing threw; the agent
  // just silently lost its craft rules. The tests above miss this because
  // their beforeAll preloads the skills — so this one deliberately does not.
  it("injects skill instructions even when nothing preloaded the skills", async () => {
    vi.resetModules();
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const config = makeConfig();
    const messages = [userMessage("/prototype a login screen")];

    const turn = await prepareChatTurn({ config, messages });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("Agent Mode: prototype");
    // The catalog of available skills is built from the same map.
    expect(turn.system).toContain("prototype");
    expect(turn.tools.load_skill).toBeDefined();
  });

  it("resolves a plain message to the native task policy with a non-empty system prompt", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const { penTools } = await import("../src/ai/tools.js");

    const config = makeConfig();
    const messages = [userMessage("make the header bigger")];

    const turn = await prepareChatTurn({ config, messages });

    expect(turn.taskPolicy).toBe("native");
    expect(turn.slashSkillName).toBeUndefined();
    expect(turn.system.length).toBeGreaterThan(0);
    expect(turn.tools.batch_design).toBe(penTools.batch_design);
  });
});
