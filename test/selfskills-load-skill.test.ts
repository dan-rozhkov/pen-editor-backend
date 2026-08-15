import { beforeAll, describe, expect, it } from "vitest";
import { getSkillTools, loadSkills } from "../src/ai/skills.js";
import { createSkillRunContext } from "../src/ai/skills/runContext.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";
import { makeConfig } from "./helpers.js";
import { getSharedLearnedSkillStore } from "../src/ai/skills/learnedStore.js";

function fakeStore(skills: LearnedSkill[]): LearnedSkillStore & { bumped: string[] } {
  const bumped: string[] = [];
  return {
    bumped,
    async listActive() {
      return skills;
    },
    async get(name) {
      return skills.find((s) => s.name === name) ?? null;
    },
    async create() {},
    async replaceBody() {},
    async remove() {
      return true;
    },
    async bumpUse(name) {
      bumped.push(name);
    },
    async bumpView() {},
  };
}

const learned: LearnedSkill = {
  name: "reading-canvas-state",
  description: "Read the canvas before editing",
  body: "# Reading canvas state\nAlways call get_editor_state first.",
  createdBy: "agent",
  state: "active",
  useCount: 0,
  viewCount: 0,
};

type LoadSkill = { execute: (args: { name: string }) => Promise<Record<string, unknown>> };

describe("load_skill with learned skills", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("still resolves a curated skill and does not touch the store", async () => {
    const store = fakeStore([learned]);
    const tools = getSkillTools({ learnedStore: store });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "prototype" });
    expect(result.name).toBe("prototype");
    expect(typeof result.instructions).toBe("string");
    expect(store.bumped).toEqual([]);
  });

  it("resolves a learned skill, marks it learned and bumps use_count", async () => {
    const store = fakeStore([learned]);
    const tools = getSkillTools({ learnedStore: store });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(result).toMatchObject({
      name: "reading-canvas-state",
      instructions: learned.body,
      learned: true,
    });
    expect(store.bumped).toEqual(["reading-canvas-state"]);
  });

  it("marks the loaded skill as read in the run context (read-before-write)", async () => {
    const runContext = createSkillRunContext();
    const tools = getSkillTools({ learnedStore: fakeStore([learned]), runContext });
    expect(runContext.hasRead("reading-canvas-state")).toBe(false);
    await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(runContext.hasRead("reading-canvas-state")).toBe(true);
  });

  it("lists curated and learned names in the unknown-skill error", async () => {
    const tools = getSkillTools({ learnedStore: fakeStore([learned]) });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "no-such-skill" });
    expect(result.error).toContain("no-such-skill");
    expect(result.error).toContain("prototype");
    expect(result.error).toContain("reading-canvas-state");
  });

  // Finding 2: `stale` is a real grace period, not `archived` under a softer
  // name — load_skill must still resolve it (and hand off to bumpUse, whose
  // own revival logic is pinned at the learnedStore/PGlite level).
  it("resolves a stale learned skill (the revival happens inside bumpUse)", async () => {
    const stale = { ...learned, state: "stale" as const };
    const store = fakeStore([stale]);
    const tools = getSkillTools({ learnedStore: store });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(result).toMatchObject({
      name: "reading-canvas-state",
      instructions: learned.body,
      learned: true,
    });
    expect(store.bumped).toEqual(["reading-canvas-state"]);
  });

  it("does not resolve an archived learned skill", async () => {
    const archived = { ...learned, state: "archived" as const };
    const tools = getSkillTools({ learnedStore: fakeStore([archived]) });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(result.error).toBeDefined();
  });

  it("falls back to the curated-only error when no store is wired", async () => {
    const tools = getSkillTools();
    const result = await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(result.error).toContain("Available skills");
  });

  // Mirrors the exact gating expression Task 8 wires into prepareChatTurn
  // (`selfSkillsOn ? getSharedLearnedSkillStore(config) : null`), so a
  // disabled kill switch is proven — at this layer, ahead of Task 8's own
  // wiring — to leave load_skill with no way to see learned skills at all.
  it("SELF_SKILLS_ENABLED=false yields no learned store, so load_skill sees only curated skills", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: false });
    const learnedStore = config.SELF_SKILLS_ENABLED ? getSharedLearnedSkillStore(config) : null;
    expect(learnedStore).toBeNull();

    const tools = getSkillTools({ learnedStore });
    const result = await (tools.load_skill as LoadSkill).execute({ name: "reading-canvas-state" });
    expect(result.error).toContain("Available skills");
    // "reading-canvas-state" appears once — echoed as the unknown name the
    // model asked for — but never as a listed available skill, because with
    // no learned store wired the "Available skills" list is curated-only.
    expect((result.error as string).split("Available skills:")[1]).not.toContain(
      "reading-canvas-state",
    );
  });
});

// Code-review finding 4: a user skill can shadow a learned skill of the same
// name (user_skills' name validator only guards against curated/penTools
// collisions, never against agent_skills — see checkUserSkillNameCollision's
// doc comment). If load_skill's user-skill branch marked the name as read in
// the shared SkillRunContext, that read would then satisfy skill_manage's
// read-before-write guard for a DIFFERENT document — the learned skill of
// the same name — whose body the agent never actually saw. `delete` only
// requires read + absorbed_into (no body comparison), so this would unlock
// deleting a learned skill through a read that never touched it.
describe("load_skill with a user skill shadowing a learned skill of the same name", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  function fakeUserSkillStore(skills: UserSkill[]): UserSkillStore {
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
      async create() {
        throw new Error("not used in this test");
      },
      async update() {
        return null;
      },
      async remove() {
        return false;
      },
      async bumpUse() {},
      async count() {
        return skills.length;
      },
      async close() {},
    };
  }

  const shadowedName = "reading-canvas-state";
  const userSkill: UserSkill = {
    userId: "u1",
    name: shadowedName,
    description: "the user's own version",
    body: "USER VERSION — not the learned body",
    enabled: true,
    source: "manual",
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("resolves the user skill (user wins the tie against learned) but does NOT mark it read", async () => {
    const runContext = createSkillRunContext();
    const learnedStore = fakeStore([learned]); // same `learned` fixture, same name
    const userSkills = { store: fakeUserSkillStore([userSkill]), userId: "u1" };
    const tools = getSkillTools({ learnedStore, runContext, userSkills });

    const result = await (tools.load_skill as LoadSkill).execute({ name: shadowedName });
    expect(result.custom).toBe(true);
    expect(result.instructions).toBe(userSkill.body);

    // The critical assertion: a load that resolved to the USER skill must
    // not authorize skill_manage to patch/delete the LEARNED skill of the
    // same name — that would be writing to a document this call never read.
    expect(runContext.hasRead(shadowedName)).toBe(false);
  });
});
