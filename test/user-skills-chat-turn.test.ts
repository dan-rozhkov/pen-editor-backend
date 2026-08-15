import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills } from "../src/ai/skills.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import { invalidateLearnedCatalog } from "../src/ai/skills/learnedStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

const baseSkill: UserSkill = {
  userId: "u1",
  name: "my-skill",
  description: "does a custom thing",
  body: "CUSTOM BODY",
  enabled: true,
  source: "manual",
  useCount: 0,
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// A minimal in-memory UserSkillStore double, keyed like the real table by
// (userId, name) — enough surface for chatTurn.ts/skills.ts's usage
// (get/listEnabled/bumpUse) without needing PGlite.
function fakeUserSkillStore(initial: UserSkill[]): UserSkillStore & { skills: UserSkill[] } {
  const skills = initial.map((s) => ({ ...s }));
  return {
    skills,
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
      const created: UserSkill = {
        ...baseSkill,
        ...input,
        enabled: true,
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      skills.push(created);
      return created;
    },
    async update(userId, name, patch) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (!found) return null;
      if (patch.newName !== undefined) found.name = patch.newName;
      if (patch.description !== undefined) found.description = patch.description;
      if (patch.body !== undefined) found.body = patch.body;
      if (patch.enabled !== undefined) found.enabled = patch.enabled;
      found.updatedAt = new Date();
      return found;
    },
    async remove(userId, name) {
      const idx = skills.findIndex((s) => s.userId === userId && s.name === name);
      if (idx === -1) return false;
      skills.splice(idx, 1);
      return true;
    },
    async bumpUse(userId, name) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (found) {
        found.useCount += 1;
        found.lastUsedAt = new Date();
      }
    },
    async count(userId) {
      return skills.filter((s) => s.userId === userId).length;
    },
    async close() {},
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

    const loadSkillTool = turn.tools.load_skill as unknown as {
      execute: (args: { name: string }) => Promise<Record<string, unknown>>;
    };
    const result = await loadSkillTool.execute({ name: "my-skill" });
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

    const loadSkillTool = turn.tools.load_skill as unknown as {
      execute: (args: { name: string }) => Promise<Record<string, unknown>>;
    };
    const result = await loadSkillTool.execute({ name: "a-skill" });
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

    const loadSkillTool = turn.tools.load_skill as unknown as {
      execute: (args: { name: string }) => Promise<Record<string, unknown>>;
    };
    const result = await loadSkillTool.execute({ name: "prototype" });
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
