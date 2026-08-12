import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills } from "../src/ai/skills.js";
import { invalidateLearnedCatalog } from "../src/ai/skills/learnedStore.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const learned: LearnedSkill = {
  name: "a-skill",
  description: "does a thing",
  body: "LEARNED BODY",
  createdBy: "agent",
  state: "active",
  useCount: 0,
  viewCount: 0,
};

function storeWith(skills: LearnedSkill[]): LearnedSkillStore {
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

const noopDb: TraceQueryable = {
  query: vi.fn(async () => ({ rows: [] })),
  end: vi.fn(async () => {}),
};

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("prepareChatTurn — self-authored skills", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  // getLearnedCatalog (src/ai/skills/learnedStore.ts) caches for 30s across
  // calls in the same process — long enough to leak a previous test's
  // catalog into this one if not invalidated between tests.
  afterEach(() => {
    invalidateLearnedCatalog();
  });

  it("omits skill_manage and learned catalog entries when the flag is off", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: false }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: storeWith([learned]),
      auditDb: noopDb,
    });

    expect(turn.tools.skill_manage).toBeUndefined();
    expect(turn.tools.skill_view).toBeUndefined();
    expect(turn.system).not.toContain("a-skill");
    expect(turn.learnedSkillNames).toEqual([]);
  });

  it("adds skill_manage (but never skill_view) and merges the learned catalog when on", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: storeWith([learned]),
      auditDb: noopDb,
    });

    expect(turn.tools.skill_manage).toBeDefined();
    expect(turn.tools.skill_view).toBeUndefined();
    expect(turn.system).toContain("- `a-skill` — does a thing (learned)");
    expect(turn.system).toContain("you wrote yourself");
    expect(turn.learnedSkillNames).toEqual(["a-skill"]);
  });

  it("does not slash-invoke a learned skill (slash stays curated-only)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const messages = [userMessage("/a-skill do the thing")];
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages,
      userId: "u1",
      learnedSkillStore: storeWith([learned]),
      auditDb: noopDb,
    });

    expect(JSON.stringify(turn.modelMessages)).not.toContain("LEARNED BODY");
    // The unresolved slash text passes through as plain text, unchanged.
    expect(JSON.stringify(turn.modelMessages)).toContain("/a-skill do the thing");
  });

  it("still prepares a turn (with skill_manage) when the catalog read throws", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const broken: LearnedSkillStore = {
      ...storeWith([]),
      listActive: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: broken,
      auditDb: noopDb,
    });

    expect(turn.learnedSkillNames).toEqual([]);
    expect(turn.tools.skill_manage).toBeDefined();
  });

  it("degrades to a normal turn (still with skill_manage) when the catalog read hangs forever", async () => {
    vi.useFakeTimers();
    try {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const hanging: LearnedSkillStore = {
        ...storeWith([]),
        listActive: vi.fn(() => new Promise<LearnedSkill[]>(() => {})),
      };

      const pending = prepareChatTurn({
        config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
        messages: [userMessage("hi")],
        userId: "u1",
        learnedSkillStore: hanging,
        auditDb: noopDb,
      });

      await vi.advanceTimersByTimeAsync(2_001);
      const turn = await pending;

      expect(turn.learnedSkillNames).toEqual([]);
      expect(turn.tools.skill_manage).toBeDefined();
      expect(turn.system.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an explicitly-passed store when there is no database configured for skill_manage (no auditDb)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: storeWith([learned]),
      auditDb: null,
    });
    // load_skill still resolves learned skills (store is present), but the
    // write-side tool needs its own audit db and stays off without one.
    expect(turn.tools.skill_manage).toBeUndefined();
    expect(turn.learnedSkillNames).toEqual(["a-skill"]);
  });

  // Finding 6: a learned row can end up sharing a name with a curated skill
  // added LATER (checkNameCollision only guards create time). Rendering
  // both would show the name twice and mislead the model, since load_skill
  // always resolves the curated one on a collision — the learned duplicate
  // is dead weight.
  it("hides a learned skill from the catalog when a curated skill of the same name exists (curated wins)", async () => {
    const shadowed: LearnedSkill = { ...learned, name: "prototype" };
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: storeWith([shadowed, learned]),
      auditDb: noopDb,
    });

    // "prototype" appears once (the curated entry, unmarked), never twice
    // and never with "(learned)".
    const prototypeLines = turn.system
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- `prototype`"));
    expect(prototypeLines).toHaveLength(1);
    expect(prototypeLines[0]).not.toContain("(learned)");
    // The non-shadowed learned skill still renders normally.
    expect(turn.system).toContain("- `a-skill` — does a thing (learned)");
    expect(turn.learnedSkillNames).toEqual(["a-skill"]);
  });

  // Finding 6: nothing bounded how many learned rows get rendered into the
  // prompt — an unbounded catalog is an unbounded system prompt.
  it("caps the number of learned skills rendered into the catalog", async () => {
    const many: LearnedSkill[] = Array.from({ length: 55 }, (_, i) => ({
      ...learned,
      name: `skill-${String(i).padStart(3, "0")}`,
    }));
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      learnedSkillStore: storeWith(many),
      auditDb: noopDb,
    });

    expect(turn.learnedSkillNames).toHaveLength(50);
    expect(turn.learnedSkillNames).toEqual(many.slice(0, 50).map((s) => s.name));
  });

  it("adds nothing when neither the store nor the flag is present", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ SELF_SKILLS_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
    });
    expect(turn.tools.skill_manage).toBeUndefined();
    expect(turn.learnedSkillNames).toEqual([]);
  });
});
