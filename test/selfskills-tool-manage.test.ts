import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { getSelfSkillTools } from "../src/ai/skills/tool.js";
import { createSkillRunContext, type SkillRunContext } from "../src/ai/skills/runContext.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

interface AuditCall {
  sql: string;
  params: unknown[];
}

function recordingDb(): TraceQueryable & { calls: AuditCall[] } {
  const calls: AuditCall[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
    async end() {},
  };
}

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
    async bumpUse() {},
    async bumpView() {},
  };
  return { store, skills };
}

const learned: LearnedSkill = {
  name: "reading-canvas-state",
  description: "Read the canvas before editing",
  body: "# Reading canvas state\nAlways call get_editor_state first.\nThen call get_variables.",
  createdBy: "agent",
  state: "active",
  useCount: 0,
  viewCount: 0,
};

interface ManageArgs {
  action: "create" | "patch" | "delete";
  name: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  absorbed_into?: string;
}
type ManageTool = { execute: (args: ManageArgs) => Promise<Record<string, unknown>> };
type ViewTool = { execute: (args: { name: string }) => Promise<Record<string, unknown>> };

let runContext: SkillRunContext;

function build(initial: LearnedSkill[] = [learned]) {
  const { store, skills } = memoryStore(initial);
  const db = recordingDb();
  const tools = getSelfSkillTools({
    store,
    runContext,
    db,
    userId: "u1",
    origin: "background_review",
    includeView: true,
  });
  return {
    manage: tools.skill_manage as ManageTool,
    view: tools.skill_view as ViewTool,
    skills,
    db,
  };
}

describe("skill_manage — create", () => {
  beforeAll(async () => {
    await loadSkills();
  });
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("creates a valid skill", async () => {
    const { manage, skills } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "handling-user-style-corrections",
      description: "What to do when the user corrects tone",
      body: "# Style corrections\nMirror the user's own wording.",
    });
    expect(result.ok).toBe(true);
    expect(skills.get("handling-user-style-corrections")).toMatchObject({
      description: "What to do when the user corrects tone",
      createdBy: "agent",
      state: "active",
    });
  });

  it("rejects a non-kebab-case name", async () => {
    const { manage, skills } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "Fix_The_Thing",
      description: "d",
      body: "b",
    });
    expect(result.error).toContain("kebab-case");
    expect(skills.size).toBe(0);
  });

  it("rejects a description over 60 chars", async () => {
    const { manage } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "a-skill",
      description: "x".repeat(61),
      body: "b",
    });
    expect(result.error).toContain("60");
  });

  it("rejects a body over 200 lines", async () => {
    const { manage } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "a-skill",
      description: "d",
      body: Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"),
    });
    expect(result.error).toContain("200");
  });

  it("refuses a curated skill's name and says it is git-owned", async () => {
    const { manage } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "prototype",
      description: "d",
      body: "b",
    });
    expect(result.error).toContain("git-owned");
  });

  it("refuses a penTools name", async () => {
    const { manage } = build([]);
    const result = await manage.execute({
      action: "create",
      name: "batch_design",
      description: "d",
      body: "b",
    });
    expect(result.error).toBeDefined();
  });

  it("refuses to create over an existing learned skill and points at patch", async () => {
    const { manage } = build();
    const result = await manage.execute({
      action: "create",
      name: "reading-canvas-state",
      description: "d",
      body: "b",
    });
    expect(result.error).toContain("patch");
  });

  it("requires description and body", async () => {
    const { manage } = build([]);
    expect((await manage.execute({ action: "create", name: "a-skill", body: "b" })).error).toContain(
      "description",
    );
    expect(
      (await manage.execute({ action: "create", name: "a-skill", description: "d" })).error,
    ).toContain("body");
  });

  it("writes one audit row with the create payload", async () => {
    const { manage, db } = build([]);
    await manage.execute({
      action: "create",
      name: "a-skill",
      description: "does a thing",
      body: "line one\nline two",
    });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain("agent_selfimprove_audit");
    expect(db.calls[0].params).toEqual([
      "u1",
      "background_review",
      "skill",
      "create",
      JSON.stringify({ name: "a-skill", description: "does a thing", bodyLines: 2 }),
    ]);
  });
});

describe("skill_manage — patch", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("refuses to patch a skill that was not read in this run", async () => {
    const { manage, skills } = build();
    const result = await manage.execute({
      action: "patch",
      name: "reading-canvas-state",
      old_string: "get_variables",
      new_string: "get_styles",
    });
    expect(result.error).toContain("skill_view");
    expect(skills.get("reading-canvas-state")!.body).toBe(learned.body);
  });

  it("patches after skill_view and audits it", async () => {
    const { manage, view, skills, db } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "patch",
      name: "reading-canvas-state",
      old_string: "Then call get_variables.",
      new_string: "Then call get_variables and get_styles.",
    });
    expect(result.ok).toBe(true);
    expect(skills.get("reading-canvas-state")!.body).toContain("get_variables and get_styles");
    expect(db.calls[0].params[3]).toBe("patch");
  });

  it("refuses to patch a curated skill and mentions git", async () => {
    const { manage, view } = build();
    await view.execute({ name: "prototype" });
    const result = await manage.execute({
      action: "patch",
      name: "prototype",
      old_string: "a",
      new_string: "b",
    });
    expect(result.error).toContain("git-owned");
  });

  it("errors when old_string is not unique", async () => {
    const { manage, view } = build([{ ...learned, body: "same\nsame" }]);
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "patch",
      name: "reading-canvas-state",
      old_string: "same",
      new_string: "other",
    });
    expect(result.error).toContain("more than once");
  });

  it("rejects a patch that pushes the body past 200 lines", async () => {
    const { manage, view } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "patch",
      name: "reading-canvas-state",
      old_string: "Then call get_variables.",
      new_string: Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"),
    });
    expect(result.error).toContain("200");
  });

  it("requires old_string and new_string", async () => {
    const { manage, view } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({ action: "patch", name: "reading-canvas-state" });
    expect(result.error).toContain("old_string");
  });

  it("errors on patching an unknown skill", async () => {
    const { manage } = build();
    const result = await manage.execute({
      action: "patch",
      name: "no-such-skill",
      old_string: "a",
      new_string: "b",
    });
    expect(result.error).toContain("no-such-skill");
  });

  it("refuses to patch a skill not created_by 'agent' even after reading it (provenance guard)", async () => {
    const humanAuthored: LearnedSkill = { ...learned, name: "human-seeded-skill", createdBy: "human" };
    const { manage, view, skills } = build([humanAuthored]);
    await view.execute({ name: "human-seeded-skill" });
    const result = await manage.execute({
      action: "patch",
      name: "human-seeded-skill",
      old_string: "get_variables",
      new_string: "get_styles",
    });
    expect(result.error).toContain("created_by");
    expect(skills.get("human-seeded-skill")!.body).toBe(humanAuthored.body);
  });
});

describe("skill_manage — delete", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("requires absorbed_into", async () => {
    const { manage, view, skills } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({ action: "delete", name: "reading-canvas-state" });
    expect(result.error).toContain("absorbed_into");
    expect(skills.has("reading-canvas-state")).toBe(true);
  });

  it("accepts an empty absorbed_into as pruning", async () => {
    const { manage, view, skills, db } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "",
    });
    expect(result.ok).toBe(true);
    expect(skills.has("reading-canvas-state")).toBe(false);
    expect(db.calls[0].params[4]).toBe(
      JSON.stringify({ name: "reading-canvas-state", absorbedInto: "" }),
    );
  });

  it("accepts absorbed_into naming another existing skill", async () => {
    const other: LearnedSkill = { ...learned, name: "canvas-reading" };
    const { manage, view, skills } = build([learned, other]);
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "canvas-reading",
    });
    expect(result.ok).toBe(true);
    expect(skills.has("canvas-reading")).toBe(true);
  });

  it("rejects absorbed_into naming a skill that does not exist", async () => {
    const { manage, view } = build();
    await view.execute({ name: "reading-canvas-state" });
    const result = await manage.execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "imaginary-skill",
    });
    expect(result.error).toContain("imaginary-skill");
  });

  it("refuses to delete without reading first", async () => {
    const { manage } = build();
    const result = await manage.execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "",
    });
    expect(result.error).toContain("skill_view");
  });

  it("refuses to delete a curated skill", async () => {
    const { manage, view } = build();
    await view.execute({ name: "prototype" });
    const result = await manage.execute({
      action: "delete",
      name: "prototype",
      absorbed_into: "",
    });
    expect(result.error).toContain("git-owned");
  });

  it("refuses to delete a skill not created_by 'agent' (provenance guard)", async () => {
    const humanAuthored: LearnedSkill = { ...learned, name: "human-seeded-skill", createdBy: "human" };
    const { manage, view, skills } = build([humanAuthored]);
    await view.execute({ name: "human-seeded-skill" });
    const result = await manage.execute({
      action: "delete",
      name: "human-seeded-skill",
      absorbed_into: "",
    });
    expect(result.error).toContain("created_by");
    expect(skills.has("human-seeded-skill")).toBe(true);
  });
});

describe("skill_manage — curated-name shadowing (finding 6)", () => {
  beforeAll(async () => {
    await loadSkills();
  });
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("allows DELETING a learned row whose name is now shadowed by a curated skill", async () => {
    // "prototype" is a real curated skill (src/skills/prototype.md). A
    // learned row with that exact name simulates one that predates the
    // curated file — checkNameCollision only guards create time, so this
    // state is reachable in practice once a human adds a curated skill
    // under a name the loop already used.
    const shadowed: LearnedSkill = { ...learned, name: "prototype" };
    const { manage, view, skills } = build([shadowed]);
    // skill_view resolves "prototype" to the CURATED file (curated always
    // wins), but that still satisfies the read-before-write guard for the
    // name.
    const viewed = await view.execute({ name: "prototype" });
    expect(viewed.learned).toBe(false);

    const result = await manage.execute({
      action: "delete",
      name: "prototype",
      absorbed_into: "",
    });
    expect(result.ok).toBe(true);
    expect(skills.has("prototype")).toBe(false);
  });

  it("still refuses to PATCH a learned row shadowed by a curated skill of the same name", async () => {
    const shadowed: LearnedSkill = { ...learned, name: "prototype" };
    const { manage, view, skills } = build([shadowed]);
    await view.execute({ name: "prototype" });

    const result = await manage.execute({
      action: "patch",
      name: "prototype",
      old_string: "get_variables",
      new_string: "get_styles",
    });
    expect(result.error).toContain("git-owned");
    // Untouched — the guard blocked the write.
    expect(skills.get("prototype")!.body).toBe(shadowed.body);
  });
});

describe("skill_manage — store errors are model-facing, not thrown (finding 7)", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  function brokenDb(): TraceQueryable {
    return { async query() { return { rows: [] }; }, async end() {} };
  }

  it("returns an error instead of throwing when store.get fails (create)", async () => {
    const store: LearnedSkillStore = {
      ...memoryStore([]).store,
      get: async () => {
        throw new Error("connection refused");
      },
    };
    const tools = getSelfSkillTools({
      store,
      runContext,
      db: brokenDb(),
      userId: "u1",
      origin: "foreground",
      includeView: false,
    });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "create",
      name: "a-skill",
      description: "d",
      body: "b",
    });
    expect(result.error).toBeDefined();
    expect(result.ok).toBeUndefined();
  });

  it("translates a unique-violation race on create into 'already exists' guidance, not a raw DB error", async () => {
    const store: LearnedSkillStore = {
      ...memoryStore([]).store,
      get: async () => null, // pre-check sees nothing...
      create: async () => {
        // ...but another writer won the race in between.
        const err = new Error('duplicate key value violates unique constraint "agent_skills_pkey"');
        (err as Error & { code: string }).code = "23505";
        throw err;
      },
    };
    const tools = getSelfSkillTools({
      store,
      runContext,
      db: brokenDb(),
      userId: "u1",
      origin: "foreground",
      includeView: false,
    });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "create",
      name: "a-skill",
      description: "d",
      body: "b",
    });
    expect(result.error).toContain("already exists");
    expect(result.error).toContain("patch");
    expect(result.error).not.toContain("unique constraint");
  });

  it("returns an error instead of throwing when store.get fails (patch/delete lookup)", async () => {
    const store: LearnedSkillStore = {
      ...memoryStore([learned]).store,
      get: async () => {
        throw new Error("connection refused");
      },
    };
    const tools = getSelfSkillTools({
      store,
      runContext,
      db: brokenDb(),
      userId: "u1",
      origin: "foreground",
      includeView: false,
    });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "",
    });
    expect(result.error).toBeDefined();
  });

  it("returns an error instead of throwing when replaceBody fails", async () => {
    const { store } = memoryStore([learned]);
    const broken: LearnedSkillStore = {
      ...store,
      replaceBody: async () => {
        throw new Error("connection refused");
      },
    };
    const tools = getSelfSkillTools({
      store: broken,
      runContext,
      db: brokenDb(),
      userId: "u1",
      origin: "foreground",
      includeView: true,
    });
    await (tools.skill_view as ViewTool).execute({ name: "reading-canvas-state" });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "patch",
      name: "reading-canvas-state",
      old_string: "get_variables",
      new_string: "get_styles",
    });
    expect(result.error).toBeDefined();
    expect(result.ok).toBeUndefined();
  });

  it("returns an error instead of throwing when remove fails", async () => {
    const { store } = memoryStore([learned]);
    const broken: LearnedSkillStore = {
      ...store,
      remove: async () => {
        throw new Error("connection refused");
      },
    };
    const tools = getSelfSkillTools({
      store: broken,
      runContext,
      db: brokenDb(),
      userId: "u1",
      origin: "foreground",
      includeView: true,
    });
    await (tools.skill_view as ViewTool).execute({ name: "reading-canvas-state" });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "",
    });
    expect(result.error).toBeDefined();
  });
});

describe("skill_manage — delete reports when the row is already gone (finding 8)", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("errors (does not report success) when remove() returns false — deleted concurrently since the read", async () => {
    const { store, skills } = memoryStore([learned]);
    const removeSpy = vi.fn(async () => false);
    const raced: LearnedSkillStore = { ...store, remove: removeSpy };
    const db = recordingDb();
    const tools = getSelfSkillTools({
      store: raced,
      runContext,
      db,
      userId: "u1",
      origin: "foreground",
      includeView: true,
    });
    await (tools.skill_view as ViewTool).execute({ name: "reading-canvas-state" });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "delete",
      name: "reading-canvas-state",
      absorbed_into: "",
    });
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain("no longer exists");
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // No audit row for a delete that didn't actually happen.
    expect(db.calls).toHaveLength(0);
    // The in-memory row was untouched by this call (still present per the
    // fake store's own bookkeeping, since remove() was stubbed to report
    // false without touching `skills`).
    expect(skills.has("reading-canvas-state")).toBe(true);
  });
});

describe("skill_manage — failure isolation", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  it("returns ok even if the audit write fails", async () => {
    const { store } = memoryStore([]);
    const db: TraceQueryable = {
      async query() {
        throw new Error("audit table gone");
      },
      async end() {},
    };
    const tools = getSelfSkillTools({
      store,
      runContext,
      db,
      userId: "u1",
      origin: "background_review",
      includeView: true,
    });
    const result = await (tools.skill_manage as ManageTool).execute({
      action: "create",
      name: "a-skill",
      description: "d",
      body: "b",
    });
    expect(result.ok).toBe(true);
  });
});

describe("skill_manage — SELF_SKILLS_ENABLED gating", () => {
  beforeEach(() => {
    runContext = createSkillRunContext();
  });

  // Task 8 (out of this scope) is what actually wires this: prepareChatTurn
  // only calls getSelfSkillTools() at all when config.SELF_SKILLS_ENABLED is
  // true. This test proves the *behavior* that wiring is meant to produce —
  // with the flag off, nothing in a turn's tool set can be skill_manage or
  // skill_view — using the exact gating expression Task 8 documents.
  it("a flag-off config never reaches getSelfSkillTools, so those tools never exist in the assembled set", () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: false });
    const { store } = memoryStore([learned]);
    const db = recordingDb();

    const selfSkillsOn = config.SELF_SKILLS_ENABLED;
    const tools: Record<string, unknown> = {};
    if (selfSkillsOn) {
      Object.assign(
        tools,
        getSelfSkillTools({ store, runContext, db, userId: "u1", origin: "foreground", includeView: false }),
      );
    }

    expect(tools.skill_manage).toBeUndefined();
    expect(tools.skill_view).toBeUndefined();
    expect(db.calls).toHaveLength(0);
  });
});
