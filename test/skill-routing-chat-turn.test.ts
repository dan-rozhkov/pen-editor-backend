import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import type { SystemOneChoiceAnswer, SystemOneClient, SystemOneEvaluateParams, SystemOneQuestion } from "../src/services/systemone.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

function fakeClient(
  answer: SystemOneChoiceAnswer,
  opts: { calls?: { count: number } } = {},
): SystemOneClient {
  return {
    async evaluate(_params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) {
      if (opts.calls) opts.calls.count += 1;
      return {
        model: "jev-latest",
        answers: { skill: answer } as never,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
    },
  };
}

const confidentPrototypePick: SystemOneChoiceAnswer = {
  type: "choice",
  choice: "prototype",
  probabilities: { prototype: 0.95, none: 0.05 },
  confidence: 0.95,
};

const baseUserSkill: UserSkill = {
  userId: "u1",
  name: "mysk",
  description: "a disabled custom skill",
  body: "DISABLED CUSTOM BODY",
  enabled: false,
  source: "manual",
  useCount: 0,
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// Minimal in-memory UserSkillStore double — only `get`/`bumpUse` are
// exercised by the slash-command path this test drives.
function fakeUserSkillStore(initial: UserSkill[]): UserSkillStore {
  const skills = initial.map((s) => ({ ...s }));
  return {
    async list(userId) {
      return skills.filter((s) => s.userId === userId);
    },
    async listEnabled(userId) {
      return skills.filter((s) => s.userId === userId && s.enabled);
    },
    async get(userId, name) {
      return skills.find((s) => s.userId === userId && s.name === name) ?? null;
    },
    async create(input) {
      const created: UserSkill = { ...baseUserSkill, ...input, enabled: true };
      skills.push(created);
      return created;
    },
    async update() {
      return null;
    },
    async remove() {
      return false;
    },
    async bumpUse(userId, name) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (found) found.useCount += 1;
    },
    async count(userId) {
      return skills.filter((s) => s.userId === userId).length;
    },
    async close() {},
  };
}

describe("prepareChatTurn — Jev skill routing", () => {
  beforeAll(async () => {
    await loadSkills();
    expect(getSkill("prototype")).toBeDefined();
  });

  it("does not call Jev when an explicit slash command already resolved a skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = fakeClient(confidentPrototypePick, { calls });

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/prototype a login screen")],
      systemOneClient: client,
    });

    expect(calls.count).toBe(0);
  });

  it("shadow mode does not inject the synthetic lookup_skill pair", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = fakeClient(confidentPrototypePick);

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "shadow" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  it("enforce mode injects the synthetic lookup_skill pair for a confident pick", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = fakeClient(confidentPrototypePick);

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("lookup_skill");
    expect(injected).toContain("Agent Mode: prototype");
  });

  it("off mode never calls Jev", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = fakeClient(confidentPrototypePick, { calls });

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    expect(calls.count).toBe(0);
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  it("enforce-mode pick resolves the FIR-45 embed-only task policy, not just the injection", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = fakeClient(confidentPrototypePick);

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    // The regression this guards: an enforce-mode pick used to set
    // skillContent (so the model sees "Agent Mode: prototype") without ever
    // setting slashSkillName, so resolveTaskPolicy stayed "native" and
    // batch_design was NOT swapped for the embed-only variant.
    expect(turn.taskPolicy).toBe("prototype");
  });

  it("does not auto-pick at all when the slash command names a real-but-disabled user skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = fakeClient(confidentPrototypePick, { calls });
    const store = fakeUserSkillStore([baseUserSkill]);

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/mysk please do the thing")],
      userId: "u1",
      userSkillStore: store,
      systemOneClient: client,
    });

    // Jev must never be consulted for this message — the disabled skill is
    // deliberately unresolvable, and auto-picking a DIFFERENT curated skill
    // here would be a back door around that.
    expect(calls.count).toBe(0);
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
    expect(injected).not.toContain("DISABLED CUSTOM BODY");
  });

  it("routes Jev on the stripped text when the slash token doesn't resolve to any skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client: SystemOneClient = {
      async evaluate(params) {
        captured = params;
        return {
          model: "jev-latest",
          answers: { skill: confidentPrototypePick } as never,
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      },
    };

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/Users/me/shot.png make this a clickable prototype")],
      systemOneClient: client,
    });

    // The slash-shaped token itself must not leak into what Jev sees.
    expect(String(captured?.state)).not.toContain("/Users/me/shot.png");
    expect(String(captured?.state)).toContain("make this a clickable prototype");
  });

  it("missing client (no key) never calls Jev and never injects", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce", TYPESAFE_API_KEY: undefined }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      // No systemOneClient passed — createSystemOne(config) must be used and
      // must return null since TYPESAFE_API_KEY is unset.
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });
});
