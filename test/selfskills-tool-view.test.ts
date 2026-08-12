import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { getSelfSkillTools } from "../src/ai/skills/tool.js";
import { createSkillRunContext, type SkillRunContext } from "../src/ai/skills/runContext.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

const noopDb: TraceQueryable = {
  async query() {
    return { rows: [] };
  },
  async end() {},
};

function memoryStore(initial: LearnedSkill[] = []) {
  const skills = new Map(initial.map((s) => [s.name, { ...s }]));
  const store: LearnedSkillStore = {
    async listActive() {
      return [...skills.values()].filter((s) => s.state === "active");
    },
    async get(name) {
      return skills.get(name) ?? null;
    },
    async create({ name, description, body }) {
      skills.set(name, {
        name,
        description,
        body,
        createdBy: "agent",
        state: "active",
        useCount: 0,
        viewCount: 0,
      });
    },
    async replaceBody(name, body) {
      const s = skills.get(name);
      if (s) s.body = body;
    },
    async remove(name) {
      return skills.delete(name);
    },
    async bumpUse(name) {
      const s = skills.get(name);
      if (s) s.useCount += 1;
    },
    async bumpView(name) {
      const s = skills.get(name);
      if (s) s.viewCount += 1;
    },
  };
  return { store, skills };
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

type ViewTool = { execute: (args: { name: string }) => Promise<Record<string, unknown>> };

let runContext: SkillRunContext;

describe("skill_view", () => {
  beforeAll(async () => {
    await loadSkills();
  });
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  function build(initial: LearnedSkill[] = [learned]) {
    const { store, skills } = memoryStore(initial);
    const tools = getSelfSkillTools({
      store,
      runContext,
      db: noopDb,
      userId: "u1",
      origin: "background_review",
      includeView: true,
    });
    return { tools, skills };
  }

  it("is absent when includeView is false", () => {
    const { store } = memoryStore([learned]);
    const tools = getSelfSkillTools({
      store,
      runContext,
      db: noopDb,
      userId: "u1",
      origin: "foreground",
      includeView: false,
    });
    expect(tools.skill_view).toBeUndefined();
    expect(tools.skill_manage).toBeDefined();
  });

  it("returns a learned skill's body, bumps view_count and marks it read", async () => {
    const { tools, skills } = build();
    const result = await (tools.skill_view as ViewTool).execute({ name: "reading-canvas-state" });
    expect(result).toMatchObject({
      name: "reading-canvas-state",
      description: learned.description,
      body: learned.body,
      learned: true,
      editable: true,
    });
    expect(skills.get("reading-canvas-state")!.viewCount).toBe(1);
    expect(runContext.hasRead("reading-canvas-state")).toBe(true);
  });

  it("returns a curated skill marked read-only and does NOT mark it writable-read", async () => {
    const { tools } = build();
    const result = await (tools.skill_view as ViewTool).execute({ name: "prototype" });
    expect(result).toMatchObject({ name: "prototype", learned: false, editable: false });
    expect(typeof result.body).toBe("string");
    expect(runContext.hasRead("prototype")).toBe(true);
  });

  // Finding 10: editable must reflect provenance, not just "is this a
  // learned row" — skill_manage's provenance guard refuses to patch/delete
  // anything with created_by !== 'agent', so a human-seeded row reporting
  // editable: true would be inaccurate and mislead the model into a write
  // it will always be refused.
  it("marks a human-seeded learned skill as NOT editable, matching skill_manage's provenance guard", async () => {
    const humanAuthored: LearnedSkill = { ...learned, name: "human-seeded", createdBy: "human" };
    const { tools } = build([humanAuthored]);
    const result = await (tools.skill_view as ViewTool).execute({ name: "human-seeded" });
    expect(result).toMatchObject({ name: "human-seeded", learned: true, editable: false });
  });

  it("errors on an unknown name and lists what exists", async () => {
    const { tools } = build();
    const result = await (tools.skill_view as ViewTool).execute({ name: "nope" });
    expect(result.error).toContain("nope");
    expect(result.error).toContain("reading-canvas-state");
    expect(runContext.hasRead("nope")).toBe(false);
  });
});
