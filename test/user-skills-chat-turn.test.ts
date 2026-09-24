import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills } from "../src/ai/skills.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import { invalidateLearnedCatalog } from "../src/ai/skills/learnedStore.js";
import { fakeUserSkillStore, userSkill } from "./userSkillFakes.js";

// See the hoisting contract at the top of test/chatMocks.ts.
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

const baseSkill: UserSkill = userSkill({ userId: "u1", body: "CUSTOM BODY" });

// The turn's backend-executed load_skill tool, typed for a direct call.
function loadSkillTool(turn: { tools: Record<string, unknown> }) {
  return turn.tools.load_skill as {
    execute: (args: { name: string }) => Promise<Record<string, unknown>>;
  };
}

const learnedTemplate: LearnedSkill = {
  name: "a-skill",
  description: "does a thing",
  body: "LEARNED BODY",
  createdBy: "agent",
  state: "active",
  useCount: 0,
  viewCount: 0,
};

function fakeLearnedStore(skills: LearnedSkill[]): LearnedSkillStore {
  return {
    listActive: vi.fn(async () => skills),
    get: vi.fn(async (name: string) => skills.find((s) => s.name === name) ?? null),
    create: vi.fn(async () => {}),
    replaceBody: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    bumpUse: vi.fn(async () => {}),
    bumpView: vi.fn(async () => {}),
  };
}

describe("prepareChatTurn — user (custom) skills", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  afterEach(() => {
    invalidateLearnedCatalog();
  });

  it("renders byte-identical to today when the user has no custom skills", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const withoutStore = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
    });
    const withEmptyStore = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: fakeUserSkillStore([]),
    });

    expect(withEmptyStore.system).toBe(withoutStore.system);
    expect(withEmptyStore.system).not.toContain("(custom)");
  });

  it("merges enabled custom skills into the catalog, marked (custom)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([baseSkill]);
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
    });

    expect(turn.system).toContain("- `my-skill` — does a custom thing (custom)");
    expect(turn.system).toContain("ones the user created themselves");
  });

  it("does not merge a disabled custom skill into the catalog", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, enabled: false }]);
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
    });

    expect(turn.system).not.toContain("my-skill");
  });

  it("does not merge custom skills belonging to a different user", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, userId: "someone-else" }]);
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
    });

    expect(turn.system).not.toContain("my-skill");
  });

  it("renders both markers with an adapted legend when learned and custom skills coexist", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: fakeUserSkillStore([baseSkill]),
      learnedSkillStore: fakeLearnedStore([learnedTemplate]),
      auditDb: { query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => {}) },
    });

    expect(turn.system).toContain("- `my-skill` — does a custom thing (custom)");
    expect(turn.system).toContain("- `a-skill` — does a thing (learned)");
    expect(turn.system).toContain("skills marked `(custom)` are ones the user created themselves");
  });

  it("`/my-skill` injects the custom skill's body and strips the slash prefix from the visible text", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([baseSkill]);
    const messages = [userMessage("/my-skill please do the thing")];
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages,
      userId: "u1",
      userSkillStore: store,
    });

    const serialized = JSON.stringify(turn.modelMessages);
    expect(serialized).toContain("CUSTOM BODY");
    expect(serialized).toContain("please do the thing");
    // The "/my-skill " prefix must be stripped from the user's visible text,
    // exactly as it is for a curated skill.
    expect(serialized).not.toContain("/my-skill please do the thing");
    expect(store.skills[0].useCount).toBe(1);
  });

  it("a disabled skill is NOT resolvable by slash command", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, enabled: false }]);
    const messages = [userMessage("/my-skill please do the thing")];
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages,
      userId: "u1",
      userSkillStore: store,
    });

    const serialized = JSON.stringify(turn.modelMessages);
    expect(serialized).not.toContain("CUSTOM BODY");
    // Unresolved slash text passes through unchanged, like an unknown curated skill.
    expect(serialized).toContain("/my-skill please do the thing");
    expect(store.skills[0].useCount).toBe(0);
  });

  it("a disabled skill is NOT resolvable by load_skill either", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, enabled: false }]);
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
    });

    const result = await loadSkillTool(turn).execute({ name: "my-skill" });
    expect(result.error).toContain("Unknown skill");
    expect(store.skills[0].useCount).toBe(0);
  });

  it("load_skill resolves a user skill over a same-named learned skill (user wins the tie)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, name: "a-skill", body: "CUSTOM WINS" }]);
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
      learnedSkillStore: fakeLearnedStore([learnedTemplate]),
      auditDb: { query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => {}) },
    });

    const result = await loadSkillTool(turn).execute({ name: "a-skill" });
    expect(result.instructions).toBe("CUSTOM WINS");
    expect(result.custom).toBe(true);

    // And the catalog should show it once, as `(custom)`, not `(learned)`.
    const lines = turn.system.split("\n").filter((l) => l.trimStart().startsWith("- `a-skill`"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(custom)");
    expect(lines[0]).not.toContain("(learned)");
  });

  it("a curated skill always wins a name tie against a user skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseSkill, name: "prototype", body: "SHOULD NOT WIN" }]);
    const turn = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userId: "u1",
      userSkillStore: store,
    });

    const result = await loadSkillTool(turn).execute({ name: "prototype" });
    expect(result.instructions).not.toBe("SHOULD NOT WIN");

    const lines = turn.system.split("\n").filter((l) => l.trimStart().startsWith("- `prototype`"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("(custom)");
  });

  it("degrades to a normal turn with no custom skills when the catalog read hangs forever", async () => {
    vi.useFakeTimers();
    try {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const hanging: UserSkillStore = {
        ...fakeUserSkillStore([]),
        listEnabled: vi.fn(() => new Promise<UserSkill[]>(() => {})),
      };

      const pending = prepareChatTurn({
        config: makeConfig({}),
        messages: [userMessage("hi")],
        userId: "u1",
        userSkillStore: hanging,
      });

      await vi.advanceTimersByTimeAsync(2_001);
      const turn = await pending;

      expect(turn.system).not.toContain("(custom)");
      expect(turn.system.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays completely unaffected (no userId, showcase-runner shape) even with a store wired", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const withoutAnything = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
    });
    const withStoreNoUserId = await prepareChatTurn({
      config: makeConfig({}),
      messages: [userMessage("hi")],
      userSkillStore: fakeUserSkillStore([baseSkill]),
    });

    expect(withStoreNoUserId.system).toBe(withoutAnything.system);
  });
});
