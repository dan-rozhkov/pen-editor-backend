# Phase 2 — Self-Authored Skills (`agent_skills`, `skill_manage`, `skill_view`, skill review pass)

> ## As shipped (v0.38.0, 2026-08-12) — read this before the plan below
>
> Implemented and merged; kept for rationale, not as an API reference. See
> `CLAUDE.md`'s "Self-authored skills" section for the built system.
>
> - **The "Depends on Phase 1" list below is wrong.** It was written before
>   Phase 1 existed and names modules that never shipped (`selfimprove/db.ts`,
>   `audit.ts`, `reviewState.ts`, `getSelfImproveDb`, `009_selfimprove.sql`).
>   Its instruction to rename Phase 1's symbols to match was **not** followed —
>   the plan was adapted to the code instead, which is the right order and the
>   rule to apply to any future phase.
> - Modules as built: `src/ai/skills/{validate,learnedStore,runContext,tool,prompts}.ts`,
>   `src/ai/selfimprove/auditDb.ts`, migration `011_agent_skills.sql`.
> - Beyond the plan, review found and fixed: a skills-only deployment needs a
>   `memory` stub and a conditional tool sentence in the review prompt;
>   `steps_since_skill` must accumulate across mid-turn requests; a learned
>   skill shadowed by a later curated file must be hidden *and* deletable; the
>   catalog cache must be keyed per store; `applyPatch` must catch overlapping
>   matches.
> - **Learned skills are global, not per-user** — deliberate (see Global
>   Constraints), and the one place the shipped behaviour most often surprises
>   people, since memory *is* per-user.
>
> **Not done:** the manual live smoke. Nothing here has run against a real model.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-11-self-improvement-loop-spec.md` (its "Locked interfaces" section is binding).
**Phase:** 2 of 3. **Assumes Phase 1 (persistent memory) is fully implemented and merged to `main`.** Phase 2 consumes Phase 1's interfaces exactly as listed in "Depends on Phase 1" below; it never forks or re-implements them. If Phase 1 shipped a listed symbol under a different name or signature, rename it *in Phase 1's module* first — do not add an adapter here.

## Goal

Let the agent write and maintain its own skill library. A background review pass (Phase 1's runner) fires on a tool-step counter, reads the conversation, and creates/patches/deletes rows in a new `agent_skills` table via two backend-executed tools. Learned skills then appear in the next turn's system-prompt catalog marked `(learned)` and are loadable by `load_skill` exactly like curated ones — while the curated `src/skills/*.md` files stay git-owned and unwritable.

## Architecture

`agent_skills` is a global (not per-user) Postgres table in the same database as traces; `src/ai/skills/learnedStore.ts` owns all SQL and a 30s in-process catalog cache. Two turn-time, backend-executed tools (`skill_manage`, `skill_view`) — injected the same way `load_skill` is via `getSkillTools()`, so they are **not** `penTools` and touch no cross-repo contract — mutate that table behind pure validators (`src/ai/skills/validate.ts`) and a read-before-write guard tracked in a per-run in-memory `SkillRunContext`. `prepareChatTurn` merges learned rows into `buildSystemPrompt`'s catalog with a `(learned)` marker and teaches `load_skill` to resolve them (bumping `use_count`); `maybeRunReview` gains the `steps_since_skill` branch plus the skill/combined review prompts.

## Tech Stack

- TypeScript strict, ESM, `moduleResolution: "NodeNext"` — **every relative import ends in `.js`**.
- `zod` for tool input schemas; `ai` SDK `tool()` helper; `pg` via `TraceQueryable` (`src/tracing/traceStore.ts`).
- SQL migrations as numbered files in `src/analysis/migrations/`, applied by `src/analysis/migrate.ts` (also at server startup via `src/startupMigrations.ts`).
- Tests: Vitest in `test/`; DB against **PGlite** (`@electric-sql/pglite`, already a devDependency); LLM via `MockLanguageModelV3` from `ai/test` with `vi.mock("../src/ai/provider.js")`.

## Global Constraints

Verbatim from the spec — these are not negotiable defaults, they are the locked contract:

- `description` **≤60 chars**, enforced on create.
- `body` **≤200 lines**, enforced on create *and* on the post-patch body.
- Skill `name` is **kebab-case, validated**, and must not collide with a curated skill name or a `penTools` name.
- Learned skills are **global, not per-user** ("the agent serves one design domain; revisit per-user scoping only if real multi-tenancy arrives").
- Curated `src/skills/*.md` are **read-only** to the tool; the error must mention they are git-owned.
- `patch`/`delete` require the exact skill to have been read via `load_skill`/`skill_view` **within the same run** (in-memory run context).
- `delete` requires `absorbed_into: string` — **empty string = pruning**.
- Learned skills are **NOT slash-invocable** (slash stays curated-only).
- **No `penTools` changes in any phase** → no cross-repo contract work, no `toolRegistry.ts` edit, no `tools-contract.test.ts` name-list edit.
- Kill switch `SELF_SKILLS_ENABLED` (zod, **default `false`**), checked in `prepareChatTurn` tool assembly and in `maybeRunReview`.
- Every autonomous write lands in `agent_selfimprove_audit`.
- Concurrency: read-modify-write goes through `SELECT … FOR UPDATE` inside a transaction; a failed read aborts the write.

## Depends on Phase 1

Phase 2 imports these and nothing else from Phase 1. Exact signatures:

```ts
// src/ai/selfimprove/db.ts
export function getSelfImproveDb(config: Config): TraceQueryable | null;
export function withTransaction<T>(
  db: TraceQueryable,
  fn: (tx: TraceQueryable) => Promise<T>,
): Promise<T>;

// src/ai/selfimprove/audit.ts
export type AuditOrigin = "foreground" | "background_review" | "curator";
export type AuditSubsystem = "memory" | "skill";
export interface AuditRow {
  userId: string;
  origin: AuditOrigin;
  subsystem: AuditSubsystem;
  action: string;
  payload: unknown;
}
export function writeAudit(db: TraceQueryable, row: AuditRow): Promise<void>;

// src/ai/selfimprove/reviewState.ts
export interface ReviewDue {
  turnsSinceMemory: number;
  stepsSinceSkill: number;
  memoryDue: boolean;
  skillDue: boolean;
}
export function bumpAndCheckCounters(
  tx: TraceQueryable,
  userId: string,
  delta: { turns: number; steps: number },
): Promise<ReviewDue>;
export const MEMORY_REVIEW_INTERVAL: number; // 10 user turns
export const SKILL_REVIEW_INTERVAL: number;  // 15 tool steps

// src/ai/selfimprove/review.ts
export interface MaybeRunReviewInput {
  config: Config;
  userId: string | undefined;
  prepared: PreparedChatTurn;
  messages: Array<Record<string, unknown>>;
  stepCount: number;
}
export function maybeRunReview(input: MaybeRunReviewInput): Promise<void>;

// src/ai/memory/prompts.ts
export const MEMORY_REVIEW_PROMPT: string;

// src/ai/memory/tool.ts
export function getMemoryTools(deps: {
  db: TraceQueryable;
  userId: string;
  origin: AuditOrigin;
}): Record<string, unknown>;

// src/ai/chatTurn.ts — PrepareChatTurnInput gained one optional field in Phase 1
export interface PrepareChatTurnInput {
  config: Config;
  messages: Array<Record<string, unknown>>;
  canvasContext?: string;
  modelOverride?: string;
  userId?: string; // ← Phase 1
}

// src/config.ts — Phase 1 added
MEMORY_ENABLED: boolean;
```

Tables created by Phase 1 (Phase 2 reads/writes them, never re-creates them): `agent_memory`, `agent_review_state`, `agent_selfimprove_audit`. Phase 1's migration file is `009_selfimprove.sql`; Phase 2 adds `010_agent_skills.sql`.

`SKILL_REVIEW_INTERVAL = 15` and the `steps_since_skill` column already exist after Phase 1 (they are in the locked DDL); Phase 2 is the first phase that *acts* on them.

---

### Task 1: `SELF_SKILLS_ENABLED` flag + `agent_skills` migration + PGlite harness

**Files**
- Modify: `src/config.ts`
- Modify: `test/helpers.ts`
- Create: `src/analysis/migrations/010_agent_skills.sql`
- Create: `test/pgliteSkillsHelpers.ts`
- Test: `test/selfskills-migration.test.ts`, `test/config.test.ts` (modify)

**Interfaces**
- Consumes: `migrate(client, dir)` from `src/analysis/migrate.ts`; `TraceQueryable` from `src/tracing/traceStore.ts`.
- Produces:
```ts
// src/config.ts (added to envSchema)
SELF_SKILLS_ENABLED: boolean;

// test/pgliteSkillsHelpers.ts
export interface PgliteSkillsHarness {
  db: TraceQueryable;
  reset(): Promise<void>;
  close(): Promise<void>;
}
export function createPgliteSkillsHarness(): Promise<PgliteSkillsHarness>;
```

**Steps**

- [ ] Write the failing migration test `test/selfskills-migration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPgliteSkillsHarness, type PgliteSkillsHarness } from "./pgliteSkillsHelpers.js";

let harness: PgliteSkillsHarness;

describe("010_agent_skills migration", () => {
  beforeEach(async () => {
    harness ??= await createPgliteSkillsHarness();
    await harness.reset();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("creates agent_skills with the locked column defaults", async () => {
    await harness.db.query(
      "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
      ["reading-canvas-state", "How to read the canvas before editing", "# Body\n", "agent"],
    );
    const result = (await harness.db.query(
      "SELECT name, state, use_count, view_count, last_used_at FROM agent_skills WHERE name = $1",
      ["reading-canvas-state"],
    )) as { rows: Array<Record<string, unknown>> };
    expect(result.rows[0]).toMatchObject({
      name: "reading-canvas-state",
      state: "active",
      use_count: 0,
      view_count: 0,
      last_used_at: null,
    });
  });

  it("enforces name as the primary key", async () => {
    await harness.db.query(
      "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
      ["dup-name", "d", "b", "agent"],
    );
    await expect(
      harness.db.query(
        "INSERT INTO agent_skills (name, description, body, created_by) VALUES ($1, $2, $3, $4)",
        ["dup-name", "d2", "b2", "agent"],
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] Write `test/pgliteSkillsHelpers.ts` (mirrors `test/pgliteShowcaseHelpers.ts`; skips the two pgvector-dependent migrations for the same reason, truncates the self-improvement tables between tests):

```ts
// Real-Postgres-engine backing for the self-improvement tables. Same reasons
// as test/pgliteShowcaseHelpers.ts: a fake pool cannot catch SQL that is
// syntactically fine but semantically illegal (FOR UPDATE outside a
// transaction, ON CONFLICT on a non-unique column, ambiguous references).
import { PGlite } from "@electric-sql/pglite";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/analysis/migrate.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/analysis/migrations",
);

// 001 starts with `CREATE EXTENSION vector` (PGlite ships no pgvector) and
// 002 only adds a table referencing 001's. Nothing self-improvement-related
// has an FK to either.
const SKIP_MIGRATIONS = new Set(["001_init.sql", "002_insights.sql"]);

function adaptPglite(db: PGlite): TraceQueryable {
  return {
    async query(sql: string, params?: unknown[]) {
      if (params === undefined) {
        await db.exec(sql);
        return { rows: [] };
      }
      const result = await db.query(sql, params);
      return { rows: result.rows };
    },
    async end() {
      await db.close();
    },
  };
}

export interface PgliteSkillsHarness {
  db: TraceQueryable;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createPgliteSkillsHarness(): Promise<PgliteSkillsHarness> {
  const pglite = new PGlite();
  const db = adaptPglite(pglite);

  const allFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const files = allFiles.filter((f) => !SKIP_MIGRATIONS.has(f));
  const dir = await mkdtemp(join(tmpdir(), "pglite-selfskills-migrations-"));
  for (const file of files) {
    await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  await migrate(db, dir);

  return {
    db,
    async reset() {
      await pglite.exec(
        "TRUNCATE TABLE agent_skills, agent_selfimprove_audit, agent_review_state, agent_memory RESTART IDENTITY CASCADE",
      );
    },
    async close() {
      await pglite.close();
    },
  };
}
```

- [ ] Run `npx vitest run test/selfskills-migration.test.ts` — see it fail (`relation "agent_skills" does not exist`).
- [ ] Create `src/analysis/migrations/010_agent_skills.sql` with the locked DDL:

```sql
-- Skills the agent wrote for itself. GLOBAL, not per-user: the agent serves
-- one design domain, so a procedure learned in one session is procedure for
-- every session. Revisit only if real multi-tenancy arrives.
--
-- Curated skills live in src/skills/*.md and are git-owned; they are never
-- represented here, and the tool that writes this table refuses their names.
CREATE TABLE IF NOT EXISTS agent_skills (
  name         text PRIMARY KEY,
  description  text NOT NULL,
  body         text NOT NULL,
  created_by   text NOT NULL,
  state        text NOT NULL DEFAULT 'active',
  use_count    int NOT NULL DEFAULT 0,
  view_count   int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The catalog read runs on every prepared turn: state filter first, then a
-- stable name order.
CREATE INDEX IF NOT EXISTS agent_skills_state_name_idx
  ON agent_skills (state, name);

-- Phase 3's deterministic curator sweeps by "unused since": active → stale at
-- 30 days, stale → archived at 90.
CREATE INDEX IF NOT EXISTS agent_skills_state_last_used_idx
  ON agent_skills (state, last_used_at NULLS FIRST);
```

- [ ] Run `npx vitest run test/selfskills-migration.test.ts` — pass.
- [ ] Add the kill switch to `src/config.ts`, immediately after `MEMORY_ENABLED` (same `z.coerce.boolean()`-avoidance note as `ENABLE_AGENT_LOGGING`):

```ts
  // Kill switch for phase 2 (self-authored skills). Default false until the
  // loop is verified live. Same parsing as ENABLE_AGENT_LOGGING: z.coerce
  // .boolean() would treat "false" as true.
  SELF_SKILLS_ENABLED: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
```

- [ ] Add `SELF_SKILLS_ENABLED: false,` to `makeConfig()` in `test/helpers.ts` (next to `MEMORY_ENABLED: false,`).
- [ ] Add to `test/config.test.ts`:

```ts
  it("defaults SELF_SKILLS_ENABLED to false and only 'true'/'1' enable it", () => {
    expect(parseEnv({}).SELF_SKILLS_ENABLED).toBe(false);
    expect(parseEnv({ SELF_SKILLS_ENABLED: "false" }).SELF_SKILLS_ENABLED).toBe(false);
    expect(parseEnv({ SELF_SKILLS_ENABLED: "true" }).SELF_SKILLS_ENABLED).toBe(true);
    expect(parseEnv({ SELF_SKILLS_ENABLED: "1" }).SELF_SKILLS_ENABLED).toBe(true);
  });
```

(`parseEnv` is the existing helper in that file — if it is named differently there, use the file's own existing pattern for building an env object and parsing it.)

- [ ] Run `npx vitest run test/config.test.ts test/selfskills-migration.test.ts` — pass.
- [ ] Commit: `feat(selfskills): agent_skills migration + SELF_SKILLS_ENABLED flag`

---

### Task 2: Pure validators (`src/ai/skills/validate.ts`)

**Files**
- Create: `src/ai/skills/validate.ts`
- Test: `test/selfskills-validate.test.ts`

**Interfaces**
- Consumes: nothing (pure module — no DB, no config, deliberately).
- Produces:
```ts
export const SKILL_NAME_RE: RegExp;
export const MAX_DESCRIPTION_CHARS: 60;
export const MAX_BODY_LINES: 200;
export const MAX_NAME_CHARS: 64;
export function validateSkillName(name: string): string | null;
export function validateDescription(description: string): string | null;
export function validateBody(body: string): string | null;
export function checkNameCollision(
  name: string,
  known: { curatedNames: string[]; toolNames: string[] },
): string | null;
export function applyPatch(
  body: string,
  oldString: string,
  newString: string,
): { body: string } | { error: string };
```
Every validator returns `null` on success and a **model-facing error string** on failure (never throws) — the tool layer returns those strings straight to the LLM.

**Steps**

- [ ] Write `test/selfskills-validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  checkNameCollision,
  validateBody,
  validateDescription,
  validateSkillName,
} from "../src/ai/skills/validate.js";

describe("validateSkillName", () => {
  it("accepts kebab-case", () => {
    expect(validateSkillName("reading-canvas-state")).toBeNull();
    expect(validateSkillName("layout")).toBeNull();
    expect(validateSkillName("fix-v2-embeds")).toBeNull();
  });

  it("rejects non-kebab-case forms", () => {
    for (const bad of ["Reading-Canvas", "reading_canvas", "-leading", "trailing-", "double--dash", "1st-thing", "with space", ""]) {
      expect(validateSkillName(bad), `expected "${bad}" to be rejected`).not.toBeNull();
    }
  });

  it("rejects names longer than 64 chars", () => {
    expect(validateSkillName("a".repeat(65))).toContain("1-64");
  });
});

describe("validateDescription", () => {
  it("accepts a 60-char description", () => {
    expect(validateDescription("x".repeat(60))).toBeNull();
  });
  it("rejects 61 chars and reports the actual length", () => {
    const err = validateDescription("x".repeat(61));
    expect(err).toContain("60");
    expect(err).toContain("61");
  });
  it("rejects empty/whitespace", () => {
    expect(validateDescription("   ")).not.toBeNull();
  });
});

describe("validateBody", () => {
  it("accepts a 200-line body", () => {
    expect(validateBody(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"))).toBeNull();
  });
  it("rejects a 201-line body and reports the actual count", () => {
    const err = validateBody(Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n"));
    expect(err).toContain("200");
    expect(err).toContain("201");
  });
  it("rejects empty/whitespace", () => {
    expect(validateBody("\n\n")).not.toBeNull();
  });
});

describe("checkNameCollision", () => {
  const known = { curatedNames: ["prototype", "slides"], toolNames: ["batch_design", "ask_user"] };

  it("rejects a curated name and says the file is git-owned", () => {
    const err = checkNameCollision("prototype", known);
    expect(err).toContain("git-owned");
    expect(err).toContain("src/skills/prototype.md");
  });

  it("rejects a penTools name", () => {
    expect(checkNameCollision("batch_design", known)).toContain("tool");
  });

  it("allows a free name", () => {
    expect(checkNameCollision("reading-canvas-state", known)).toBeNull();
  });
});

describe("applyPatch", () => {
  it("replaces a unique occurrence", () => {
    expect(applyPatch("alpha\nbeta\ngamma", "beta", "BETA")).toEqual({ body: "alpha\nBETA\ngamma" });
  });
  it("errors when old_string is absent", () => {
    const result = applyPatch("alpha", "delta", "x") as { error: string };
    expect(result.error).toContain("not found");
  });
  it("errors when old_string occurs twice", () => {
    const result = applyPatch("a\na", "a", "b") as { error: string };
    expect(result.error).toContain("more than once");
  });
  it("errors on an empty old_string", () => {
    const result = applyPatch("a", "", "b") as { error: string };
    expect(result.error).toContain("must not be empty");
  });
});
```

- [ ] Run `npx vitest run test/selfskills-validate.test.ts` — see it fail (module not found).
- [ ] Create `src/ai/skills/validate.ts`:

```ts
// Pure validation for self-authored skills. No DB, no config, no I/O: every
// rule the spec locks is checkable from strings alone, and keeping them here
// means the tool layer is only wiring. Each function returns null on success
// or a MODEL-FACING error string — the tool returns these verbatim to the LLM,
// so they must say what to do next, not just what went wrong.

export const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 60;
export const MAX_BODY_LINES = 200;

export function validateSkillName(name: string): string | null {
  if (!name || name.length > MAX_NAME_CHARS) {
    return `Skill name must be 1-64 characters (got ${name?.length ?? 0}).`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return `Skill name "${name}" must be kebab-case: lowercase letters and digits separated by single hyphens, starting with a letter (e.g. "reading-canvas-state").`;
  }
  return null;
}

export function validateDescription(description: string): string | null {
  if (!description || !description.trim()) {
    return "description is required: one line saying when this skill applies.";
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return `description must be ${MAX_DESCRIPTION_CHARS} characters or fewer (got ${description.length}). It is a catalog line, not the skill.`;
  }
  return null;
}

export function validateBody(body: string): string | null {
  if (!body || !body.trim()) {
    return "body is required: the skill's instructions in markdown, without frontmatter.";
  }
  const lines = body.split("\n").length;
  if (lines > MAX_BODY_LINES) {
    return `body must be ${MAX_BODY_LINES} lines or fewer (got ${lines}). Keep the skill class-level: cut the session narrative, keep the procedure.`;
  }
  return null;
}

export function checkNameCollision(
  name: string,
  known: { curatedNames: string[]; toolNames: string[] },
): string | null {
  if (known.curatedNames.includes(name)) {
    return `"${name}" is a curated skill. Curated skills are git-owned files (src/skills/${name}.md) and are read-only to this tool — they can only be changed by a human in git. Pick a different name, or put the lesson in a learned skill of your own.`;
  }
  if (known.toolNames.includes(name)) {
    return `"${name}" is the name of a tool you can call. A skill may not shadow a tool name — pick a different name.`;
  }
  return null;
}

// Exact-substring patch, deliberately the same contract as a code editor's
// str_replace: the old text must occur EXACTLY once. Zero matches means the
// model is patching a body it did not actually read; several matches mean the
// edit is ambiguous and could land in the wrong section.
export function applyPatch(
  body: string,
  oldString: string,
  newString: string,
): { body: string } | { error: string } {
  if (oldString === "") {
    return { error: "old_string must not be empty. Copy the exact text to replace out of the skill body." };
  }
  const first = body.indexOf(oldString);
  if (first === -1) {
    return {
      error:
        "old_string was not found in the skill body. View the skill again with skill_view and copy the exact text, including whitespace.",
    };
  }
  const second = body.indexOf(oldString, first + oldString.length);
  if (second !== -1) {
    return {
      error:
        "old_string occurs more than once in the skill body. Include more surrounding lines so the match is unique.",
    };
  }
  return { body: body.slice(0, first) + newString + body.slice(first + oldString.length) };
}
```

- [ ] Run `npx vitest run test/selfskills-validate.test.ts` — pass.
- [ ] Commit: `feat(selfskills): pure validators for learned-skill names, limits and patches`

---

### Task 3: Learned-skill store + catalog cache

**Files**
- Create: `src/ai/skills/learnedStore.ts`
- Test: `test/selfskills-store.test.ts`

**Interfaces**
- Consumes: `createPgPool`, `TraceQueryable` (`src/tracing/traceStore.js`); `Config` (`src/config.js`).
- Produces:
```ts
export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  createdBy: string;
  state: "active" | "stale" | "archived";
  useCount: number;
  viewCount: number;
}
export interface LearnedSkillStore {
  listActive(): Promise<LearnedSkill[]>;
  get(name: string): Promise<LearnedSkill | null>;
  create(input: { name: string; description: string; body: string }): Promise<void>;
  replaceBody(name: string, body: string): Promise<void>;
  remove(name: string): Promise<boolean>;
  bumpUse(name: string): Promise<void>;
  bumpView(name: string): Promise<void>;
}
export function createLearnedSkillStore(
  config: Config,
  pool?: TraceQueryable,
): LearnedSkillStore | null;
export function getSharedLearnedSkillStore(config: Config): LearnedSkillStore | null;
export function __resetSharedLearnedSkillStore(): void;
export function getLearnedCatalog(store: LearnedSkillStore): Promise<LearnedSkill[]>;
export function invalidateLearnedCatalog(): void;
```

**Steps**

- [ ] Write `test/selfskills-store.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeConfig } from "./helpers.js";
import { createPgliteSkillsHarness, type PgliteSkillsHarness } from "./pgliteSkillsHelpers.js";
import {
  createLearnedSkillStore,
  getLearnedCatalog,
  invalidateLearnedCatalog,
  type LearnedSkillStore,
} from "../src/ai/skills/learnedStore.js";

let harness: PgliteSkillsHarness;
let store: LearnedSkillStore;

describe("learned skill store", () => {
  beforeEach(async () => {
    harness ??= await createPgliteSkillsHarness();
    await harness.reset();
    invalidateLearnedCatalog();
    store = createLearnedSkillStore(makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }), harness.db)!;
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("creates and reads back a skill", async () => {
    await store.create({ name: "a-skill", description: "does a thing", body: "# A\nbody" });
    const skill = await store.get("a-skill");
    expect(skill).toMatchObject({
      name: "a-skill",
      description: "does a thing",
      body: "# A\nbody",
      createdBy: "agent",
      state: "active",
      useCount: 0,
      viewCount: 0,
    });
  });

  it("returns null for an unknown name", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("listActive excludes stale and archived rows and sorts by name", async () => {
    await store.create({ name: "b-skill", description: "b", body: "b" });
    await store.create({ name: "a-skill", description: "a", body: "a" });
    await store.create({ name: "z-old", description: "z", body: "z" });
    await harness.db.query("UPDATE agent_skills SET state = 'archived' WHERE name = $1", ["z-old"]);
    expect((await store.listActive()).map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
  });

  it("replaceBody rewrites the body and moves updated_at", async () => {
    await store.create({ name: "a-skill", description: "d", body: "old" });
    await harness.db.query("UPDATE agent_skills SET updated_at = now() - interval '1 day'", []);
    await store.replaceBody("a-skill", "new");
    const rows = (await harness.db.query(
      "SELECT body, updated_at > now() - interval '1 minute' AS fresh FROM agent_skills WHERE name = $1",
      ["a-skill"],
    )) as { rows: Array<{ body: string; fresh: boolean }> };
    expect(rows.rows[0]).toEqual({ body: "new", fresh: true });
  });

  it("remove reports whether a row was deleted", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    expect(await store.remove("a-skill")).toBe(true);
    expect(await store.remove("a-skill")).toBe(false);
  });

  it("bumpUse increments use_count and sets last_used_at", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    await store.bumpUse("a-skill");
    await store.bumpUse("a-skill");
    const rows = (await harness.db.query(
      "SELECT use_count, last_used_at IS NOT NULL AS used FROM agent_skills WHERE name = $1",
      ["a-skill"],
    )) as { rows: Array<{ use_count: number; used: boolean }> };
    expect(rows.rows[0]).toEqual({ use_count: 2, used: true });
  });

  it("bumpView increments view_count but not use_count", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    await store.bumpView("a-skill");
    const skill = await store.get("a-skill");
    expect(skill).toMatchObject({ viewCount: 1, useCount: 0 });
  });

  it("getLearnedCatalog caches until invalidated", async () => {
    await store.create({ name: "a-skill", description: "d", body: "b" });
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

    await store.create({ name: "b-skill", description: "d", body: "b" });
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill"]);

    invalidateLearnedCatalog();
    expect((await getLearnedCatalog(store)).map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
  });

  it("getLearnedCatalog returns [] instead of throwing when the query fails", async () => {
    const broken: LearnedSkillStore = {
      ...store,
      listActive: async () => {
        throw new Error("db down");
      },
    };
    invalidateLearnedCatalog();
    expect(await getLearnedCatalog(broken)).toEqual([]);
  });

  it("createLearnedSkillStore returns null without a database URL and no pool", () => {
    expect(createLearnedSkillStore(makeConfig())).toBeNull();
  });
});
```

- [ ] Run `npx vitest run test/selfskills-store.test.ts` — see it fail.
- [ ] Create `src/ai/skills/learnedStore.ts`:

```ts
import type { Config } from "../../config.js";
import { createPgPool, type TraceQueryable } from "../../tracing/traceStore.js";

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  createdBy: string;
  state: "active" | "stale" | "archived";
  useCount: number;
  viewCount: number;
}

interface SkillRow {
  name: string;
  description: string;
  body: string;
  created_by: string;
  state: string;
  use_count: number;
  view_count: number;
}

function toSkill(row: SkillRow): LearnedSkill {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    createdBy: row.created_by,
    state: row.state as LearnedSkill["state"],
    // pg returns int4 as a JS number; PGlite does too.
    useCount: Number(row.use_count),
    viewCount: Number(row.view_count),
  };
}

const SELECT_COLUMNS =
  "name, description, body, created_by, state, use_count, view_count";

export interface LearnedSkillStore {
  listActive(): Promise<LearnedSkill[]>;
  get(name: string): Promise<LearnedSkill | null>;
  create(input: { name: string; description: string; body: string }): Promise<void>;
  replaceBody(name: string, body: string): Promise<void>;
  remove(name: string): Promise<boolean>;
  bumpUse(name: string): Promise<void>;
  bumpView(name: string): Promise<void>;
}

export function createLearnedSkillStore(
  config: Config,
  pool?: TraceQueryable,
): LearnedSkillStore | null {
  if (!pool && !config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable = pool ?? createPgPool(config.TRACE_DATABASE_URL!);

  return {
    async listActive() {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM agent_skills WHERE state = 'active' ORDER BY name`,
        [],
      )) as { rows: SkillRow[] };
      return result.rows.map(toSkill);
    },

    async get(name) {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM agent_skills WHERE name = $1`,
        [name],
      )) as { rows: SkillRow[] };
      return result.rows[0] ? toSkill(result.rows[0]) : null;
    },

    async create({ name, description, body }) {
      // No ON CONFLICT: a duplicate name is a validation failure the tool
      // layer already reported, so reaching here with one means two writers
      // raced and the loser must NOT silently overwrite the winner's skill.
      await db.query(
        `INSERT INTO agent_skills (name, description, body, created_by)
         VALUES ($1, $2, $3, 'agent')`,
        [name, description, body],
      );
    },

    async replaceBody(name, body) {
      await db.query(
        "UPDATE agent_skills SET body = $2, updated_at = now() WHERE name = $1",
        [name, body],
      );
    },

    async remove(name) {
      const result = (await db.query(
        "DELETE FROM agent_skills WHERE name = $1 RETURNING name",
        [name],
      )) as { rows: unknown[] };
      return result.rows.length > 0;
    },

    async bumpUse(name) {
      await db.query(
        "UPDATE agent_skills SET use_count = use_count + 1, last_used_at = now() WHERE name = $1",
        [name],
      );
    },

    async bumpView(name) {
      await db.query(
        "UPDATE agent_skills SET view_count = view_count + 1 WHERE name = $1",
        [name],
      );
    },
  };
}

// One pool per process, not per request: prepareChatTurn runs on every chat
// request and a fresh pg.Pool per turn would leak connections until Postgres
// refuses new ones.
let shared: { url: string; store: LearnedSkillStore } | null = null;

export function getSharedLearnedSkillStore(config: Config): LearnedSkillStore | null {
  const url = config.TRACE_DATABASE_URL;
  if (!url) return null;
  if (shared?.url === url) return shared.store;
  const store = createLearnedSkillStore(config);
  if (!store) return null;
  shared = { url, store };
  return store;
}

export function __resetSharedLearnedSkillStore(): void {
  shared = null;
}

// The catalog is read on every prepared turn but changes only when the agent
// writes a skill — which is rare and always goes through this module. A short
// TTL bounds staleness for writes from another process (a second server
// instance); invalidateLearnedCatalog() makes this process's own writes
// visible on the very next turn.
const CATALOG_TTL_MS = 30_000;
let catalogCache: { at: number; skills: LearnedSkill[] } | null = null;

export async function getLearnedCatalog(
  store: LearnedSkillStore,
): Promise<LearnedSkill[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.skills;
  }
  try {
    const skills = await store.listActive();
    catalogCache = { at: Date.now(), skills };
    return skills;
  } catch (err) {
    // A self-improvement read must never break a design turn: fall back to
    // the last known catalog, or to none at all.
    console.error("[selfskills] catalog read failed:", (err as Error).message);
    return catalogCache?.skills ?? [];
  }
}

export function invalidateLearnedCatalog(): void {
  catalogCache = null;
}
```

- [ ] Run `npx vitest run test/selfskills-store.test.ts` — pass.
- [ ] Commit: `feat(selfskills): learned-skill Postgres store + cached catalog read`

---

### Task 4: Catalog merge — `(learned)` marker in `buildSystemPrompt`

**Files**
- Modify: `src/ai/system-prompt.ts`
- Test: `test/system-prompt.test.ts` (modify)

**Interfaces**
- Consumes: nothing new.
- Produces:
```ts
export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Written by the agent itself (agent_skills), not a git-owned src/skills file. */
  learned?: boolean;
}
```
`buildSystemPrompt(canvasContext?, skills?)` signature is unchanged.

**Steps**

- [ ] Add to `test/system-prompt.test.ts`:

```ts
  it("marks learned skills in the catalog and leaves curated ones unmarked", () => {
    const prompt = buildSystemPrompt(undefined, [
      { name: "prototype", description: "Build a clickable prototype" },
      { name: "reading-canvas-state", description: "Read the canvas before editing", learned: true },
    ]);
    expect(prompt).toContain("- `prototype` — Build a clickable prototype");
    expect(prompt).toContain(
      "- `reading-canvas-state` — Read the canvas before editing (learned)",
    );
  });

  it("explains what (learned) means when at least one learned skill is present", () => {
    const prompt = buildSystemPrompt(undefined, [
      { name: "reading-canvas-state", description: "Read the canvas first", learned: true },
    ]);
    expect(prompt).toContain("(learned)");
    expect(prompt).toContain("you wrote yourself");
  });

  it("omits the (learned) legend when every skill is curated", () => {
    const prompt = buildSystemPrompt(undefined, [
      { name: "prototype", description: "Build a clickable prototype" },
    ]);
    expect(prompt).not.toContain("(learned)");
  });
```

- [ ] Run `npx vitest run test/system-prompt.test.ts` — see the three new cases fail.
- [ ] Modify `src/ai/system-prompt.ts`:

```ts
export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Written by the agent itself (agent_skills), not a git-owned src/skills file. */
  learned?: boolean;
}
```

and inside `renderSkillCatalog`, replace the `lines` computation and insert the legend:

```ts
function renderSkillCatalog(skills: SkillCatalogEntry[]): string {
  const lines = skills
    .map((s) => `- \`${s.name}\` — ${s.description}${s.learned ? " (learned)" : ""}`)
    .join("\n");
  // Only shown when there is something to explain: on a fresh install the
  // library is entirely curated and the legend would be noise in the cached
  // prefix.
  const legend = skills.some((s) => s.learned)
    ? "\n\nSkills marked `(learned)` are ones you wrote yourself in an earlier session. Load them exactly like the others; if one turns out to be wrong or outdated, fix it rather than working around it."
    : "";
  return `
## Available Skills

You can load extra task-specific instructions on demand. When the user's request matches one of the skills below, call the \`load_skill\` tool with its \`name\` BEFORE doing the work, then follow the returned instructions for the rest of the turn. Load at most one skill unless a task clearly spans several.

${lines}${legend}
```

(the rest of the template literal — the `### FIRST DECISION` block through the final backtick — is unchanged.)

- [ ] Run `npx vitest run test/system-prompt.test.ts` — pass.
- [ ] Commit: `feat(selfskills): mark learned skills in the system-prompt catalog`

---

### Task 5: `load_skill` resolves learned skills + run context

**Files**
- Create: `src/ai/skills/runContext.ts`
- Modify: `src/ai/skills.ts`
- Test: `test/selfskills-load-skill.test.ts`

**Interfaces**
- Consumes: `LearnedSkillStore` (Task 3).
- Produces:
```ts
// src/ai/skills/runContext.ts
export interface SkillRunContext {
  markRead(name: string): void;
  hasRead(name: string): boolean;
  readNames(): string[];
}
export function createSkillRunContext(): SkillRunContext;

// src/ai/skills.ts
export interface SkillToolsOptions {
  learnedStore?: LearnedSkillStore | null;
  runContext?: SkillRunContext;
}
export function getSkillTools(options?: SkillToolsOptions): Record<string, unknown>;
```
`getSkillTools()` keeps working with no arguments (existing call sites and `test/skills.test.ts` are untouched).

**Steps**

- [ ] Write `test/selfskills-load-skill.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { getSkillTools, loadSkills } from "../src/ai/skills.js";
import { createSkillRunContext } from "../src/ai/skills/runContext.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";

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
});
```

- [ ] Run `npx vitest run test/selfskills-load-skill.test.ts` — see it fail.
- [ ] Create `src/ai/skills/runContext.ts`:

```ts
// Read-before-write bookkeeping for one run (one chat request, or one
// background review run). The spec forbids patching or deleting a skill the
// agent has not actually read IN THIS RUN — a model that patches from memory
// rewrites a body it never saw, which is exactly how a good skill gets
// clobbered by a half-remembered one. Deliberately in-memory and per-run: a
// process-wide set would let a read from an unrelated session authorize a
// write here.
export interface SkillRunContext {
  markRead(name: string): void;
  hasRead(name: string): boolean;
  readNames(): string[];
}

export function createSkillRunContext(): SkillRunContext {
  const read = new Set<string>();
  return {
    markRead(name) {
      read.add(name);
    },
    hasRead(name) {
      return read.has(name);
    },
    readNames() {
      return [...read];
    },
  };
}
```

- [ ] Modify `src/ai/skills.ts` — add imports at the top:

```ts
import type { LearnedSkillStore } from "./skills/learnedStore.js";
import type { SkillRunContext } from "./skills/runContext.js";
```

and replace `getSkillTools` wholesale:

```ts
export interface SkillToolsOptions {
  /** When wired, load_skill also resolves agent-authored skills from Postgres. */
  learnedStore?: LearnedSkillStore | null;
  /** When wired, a successful load counts as "read" for skill_manage's guard. */
  runContext?: SkillRunContext;
}

export function getSkillTools(
  options: SkillToolsOptions = {},
): Record<string, unknown> {
  const { learnedStore, runContext } = options;

  const load_skill = tool({
    description:
      "Load a skill's full instructions by name. Call this when the user's task matches a skill listed in the 'Available Skills' catalog in your system prompt. Returns the skill's instructions to follow for the current turn.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("The exact skill name from the Available Skills catalog."),
    }),
    execute: async ({ name }: { name: string }) => {
      const skill = getSkill(name);
      if (skill) {
        runContext?.markRead(name);
        return { name: skill.name, instructions: skill.content };
      }

      if (learnedStore) {
        // Curated first, always: a learned skill can never shadow a git-owned
        // one, and the name validator already refuses that collision anyway.
        const learned = await learnedStore.get(name).catch(() => null);
        if (learned && learned.state === "active") {
          // Best-effort: a failed counter bump must not fail the load.
          await learnedStore.bumpUse(name).catch(() => undefined);
          runContext?.markRead(name);
          return { name: learned.name, instructions: learned.body, learned: true };
        }
      }

      const curatedNames = getAllSkills().map((s) => s.name);
      const learnedNames = learnedStore
        ? (await learnedStore.listActive().catch(() => [])).map((s) => s.name)
        : [];
      const available = [...curatedNames, ...learnedNames].join(", ");
      return {
        error: `Unknown skill "${name}". Available skills: ${available}`,
      };
    },
  });
  return { load_skill };
}
```

- [ ] Run `npx vitest run test/selfskills-load-skill.test.ts test/skills.test.ts` — pass (the existing `skills.test.ts` calls `getSkillTools()` with no arguments and must stay green).
- [ ] Commit: `feat(selfskills): load_skill resolves learned skills and bumps use_count`

---

### Task 6: `skill_view` tool

**Files**
- Create: `src/ai/skills/tool.ts`
- Test: `test/selfskills-tool-view.test.ts`

**Interfaces**
- Consumes: `LearnedSkillStore`, `SkillRunContext`, `getSkill`/`getAllSkills` (`src/ai/skills.js`).
- Produces:
```ts
export interface SelfSkillToolDeps {
  store: LearnedSkillStore;
  runContext: SkillRunContext;
  db: TraceQueryable;
  userId: string;
  origin: AuditOrigin;
  /** skill_view is only offered to the background review run. */
  includeView: boolean;
}
export function getSelfSkillTools(deps: SelfSkillToolDeps): Record<string, unknown>;
```
(`skill_manage` lands in Task 7 in the same module and the same factory.)

**Steps**

- [ ] Write `test/selfskills-tool-view.test.ts`:

```ts
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

  it("errors on an unknown name and lists what exists", async () => {
    const { tools } = build();
    const result = await (tools.skill_view as ViewTool).execute({ name: "nope" });
    expect(result.error).toContain("nope");
    expect(result.error).toContain("reading-canvas-state");
    expect(runContext.hasRead("nope")).toBe(false);
  });
});
```

- [ ] Run `npx vitest run test/selfskills-tool-view.test.ts` — see it fail.
- [ ] Create `src/ai/skills/tool.ts` (this task adds the module, the factory and `skill_view`; `skill_manage` is added in Task 7 — for now the factory returns a `skill_manage` placeholder-free minimal stub is NOT acceptable, so implement `skill_manage` in Task 7 and, for this task only, have the factory return just `skill_view` and let the `includeView: false` assertion on `tools.skill_manage` fail until Task 7. Mark that one expectation `it.todo` here and restore it in Task 7):

Concretely, in this task write the module as:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { TraceQueryable } from "../../tracing/traceStore.js";
import type { AuditOrigin } from "../selfimprove/audit.js";
import { getAllSkills, getSkill } from "../skills.js";
import type { LearnedSkillStore } from "./learnedStore.js";
import type { SkillRunContext } from "./runContext.js";

export interface SelfSkillToolDeps {
  store: LearnedSkillStore;
  runContext: SkillRunContext;
  db: TraceQueryable;
  userId: string;
  origin: AuditOrigin;
  /** skill_view exists for the background review run; a normal design turn
   *  reads skills through load_skill, which already satisfies the guard. */
  includeView: boolean;
}

export function getSelfSkillTools(
  deps: SelfSkillToolDeps,
): Record<string, unknown> {
  const { store, runContext } = deps;

  const skill_view = tool({
    description:
      "Read a skill in full — its description and body — without loading it as instructions for the current turn. Use this before patching or deleting a skill: you may only edit a skill you have actually read in this run. Curated skills can be viewed but never edited.",
    inputSchema: z.object({
      name: z.string().describe("Exact skill name, curated or learned."),
    }),
    execute: async ({ name }: { name: string }) => {
      const curated = getSkill(name);
      if (curated) {
        runContext.markRead(name);
        return {
          name: curated.name,
          description: curated.description,
          body: curated.content,
          learned: false,
          editable: false,
        };
      }

      const learned = await store.get(name).catch(() => null);
      if (learned) {
        await store.bumpView(name).catch(() => undefined);
        runContext.markRead(name);
        return {
          name: learned.name,
          description: learned.description,
          body: learned.body,
          learned: true,
          editable: true,
          state: learned.state,
          useCount: learned.useCount,
        };
      }

      const available = [
        ...getAllSkills().map((s) => s.name),
        ...(await store.listActive().catch(() => [])).map((s) => s.name),
      ].join(", ");
      return { error: `Unknown skill "${name}". Skills that exist: ${available}` };
    },
  });

  const tools: Record<string, unknown> = {};
  if (deps.includeView) tools.skill_view = skill_view;
  return tools;
}
```

- [ ] In `test/selfskills-tool-view.test.ts`, change the first test to `it.todo("is absent when includeView is false")` for this task only — Task 7 restores it as a real test once `skill_manage` exists.
- [ ] Run `npx vitest run test/selfskills-tool-view.test.ts` — pass (one todo).
- [ ] Commit: `feat(selfskills): skill_view tool with read-before-write bookkeeping`

---

### Task 7: `skill_manage` tool (create / patch / delete) with guards + audit

**Files**
- Modify: `src/ai/skills/tool.ts`
- Modify: `test/selfskills-tool-view.test.ts` (restore the `it.todo`)
- Test: `test/selfskills-tool-manage.test.ts`

**Interfaces**
- Consumes: `writeAudit`, `AuditRow`, `AuditOrigin` (`src/ai/selfimprove/audit.js`); `penTools` (`src/ai/tools.js`); every validator from Task 2; `invalidateLearnedCatalog` (Task 3).
- Produces: `skill_manage` inside the existing `getSelfSkillTools` factory. Input schema:
```ts
z.object({
  action: z.enum(["create", "patch", "delete"]),
  name: z.string(),
  description: z.string().optional(),
  body: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  absorbed_into: z.string().optional(),
})
```
Returns `{ ok: true, message: string }` or `{ error: string }` — never throws.

**Steps**

- [ ] Write `test/selfskills-tool-manage.test.ts` (reuses the `memoryStore` helper — copy it into this file rather than exporting it from a test file, matching the repo's existing per-file helper style):

```ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { getSelfSkillTools } from "../src/ai/skills/tool.js";
import { createSkillRunContext, type SkillRunContext } from "../src/ai/skills/runContext.js";
import type { LearnedSkill, LearnedSkillStore } from "../src/ai/skills/learnedStore.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

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
```

- [ ] Run `npx vitest run test/selfskills-tool-manage.test.ts` — see it fail (`skill_manage` undefined).
- [ ] Modify `src/ai/skills/tool.ts` — extend the imports:

```ts
import { penTools } from "../tools.js";
import { writeAudit } from "../selfimprove/audit.js";
import { invalidateLearnedCatalog } from "./learnedStore.js";
import {
  applyPatch,
  checkNameCollision,
  validateBody,
  validateDescription,
  validateSkillName,
} from "./validate.js";
```

and add, inside `getSelfSkillTools` before the `const tools` line:

```ts
  const { db, userId, origin } = deps;

  // Audit is observability, not the write itself: an audit failure must never
  // turn a landed skill change into a reported error, or the model retries a
  // write that already succeeded.
  const audit = async (action: string, payload: unknown) => {
    try {
      await writeAudit(db, { userId, origin, subsystem: "skill", action, payload });
    } catch (err) {
      console.error("[selfskills] audit write failed:", (err as Error).message);
    }
  };

  const curatedGuard = (name: string): string | null =>
    getSkill(name)
      ? `"${name}" is a curated skill. Curated skills are git-owned files (src/skills/${name}.md) and are read-only to this tool — a human edits them in git. If the lesson belongs somewhere, put it in a learned skill.`
      : null;

  const readGuard = (name: string): string | null =>
    runContext.hasRead(name)
      ? null
      : `You have not read "${name}" in this run. Call skill_view with name "${name}" first, then patch or delete it — editing a skill you have not actually read overwrites work you cannot see.`;

  const skill_manage = tool({
    description:
      "Create, patch or delete a skill you wrote yourself. Prefer patching an existing skill over creating a new one; skills should be class-level (a kind of task), never a record of one session. Curated skills cannot be changed here. You must skill_view (or load_skill) a skill in this run before patching or deleting it.",
    inputSchema: z.object({
      action: z
        .enum(["create", "patch", "delete"])
        .describe("create a new skill, patch an existing one, or delete one."),
      name: z.string().describe("Skill name, kebab-case (e.g. \"reading-canvas-state\")."),
      description: z
        .string()
        .optional()
        .describe("create only. One catalog line, 60 characters or fewer."),
      body: z
        .string()
        .optional()
        .describe("create only. Markdown instructions, 200 lines or fewer, no frontmatter."),
      old_string: z
        .string()
        .optional()
        .describe("patch only. Exact text to replace; must occur exactly once in the body."),
      new_string: z.string().optional().describe("patch only. Replacement text."),
      absorbed_into: z
        .string()
        .optional()
        .describe(
          "delete only, required. Name of the skill that now covers this one, or an empty string when you are simply pruning it.",
        ),
    }),
    execute: async (args: {
      action: "create" | "patch" | "delete";
      name: string;
      description?: string;
      body?: string;
      old_string?: string;
      new_string?: string;
      absorbed_into?: string;
    }) => {
      const { action, name } = args;

      if (action === "create") {
        const nameError = validateSkillName(name);
        if (nameError) return { error: nameError };

        const collision = checkNameCollision(name, {
          curatedNames: getAllSkills().map((s) => s.name),
          toolNames: Object.keys(penTools),
        });
        if (collision) return { error: collision };

        const description = args.description ?? "";
        const descriptionError = validateDescription(description);
        if (descriptionError) return { error: descriptionError };

        const body = args.body ?? "";
        const bodyError = validateBody(body);
        if (bodyError) return { error: bodyError };

        const existing = await store.get(name);
        if (existing) {
          return {
            error: `A learned skill named "${name}" already exists. Use action "patch" to change it — do not replace a skill wholesale.`,
          };
        }

        await store.create({ name, description, body });
        invalidateLearnedCatalog();
        await audit("create", { name, description, bodyLines: body.split("\n").length });
        return {
          ok: true,
          message: `Created skill "${name}". It will appear in your skills catalog marked (learned) on the next turn.`,
        };
      }

      const curatedError = curatedGuard(name);
      if (curatedError) return { error: curatedError };

      const existing = await store.get(name);
      if (!existing) {
        const available = (await store.listActive()).map((s) => s.name).join(", ");
        return {
          error: `No learned skill named "${name}". Learned skills: ${available || "(none yet)"}.`,
        };
      }

      const readError = readGuard(name);
      if (readError) return { error: readError };

      if (action === "patch") {
        if (args.old_string === undefined || args.new_string === undefined) {
          return { error: "patch requires both old_string and new_string." };
        }
        const patched = applyPatch(existing.body, args.old_string, args.new_string);
        if ("error" in patched) return { error: patched.error };

        const bodyError = validateBody(patched.body);
        if (bodyError) return { error: bodyError };

        await store.replaceBody(name, patched.body);
        invalidateLearnedCatalog();
        await audit("patch", {
          name,
          oldString: args.old_string,
          newString: args.new_string,
          bodyLines: patched.body.split("\n").length,
        });
        return { ok: true, message: `Patched skill "${name}".` };
      }

      // action === "delete"
      const absorbedInto = args.absorbed_into;
      if (absorbedInto === undefined) {
        return {
          error:
            'delete requires absorbed_into: the name of the skill that now covers this one, or an empty string ("") if you are simply pruning it. Deleting knowledge without saying where it went is how a library loses things silently.',
        };
      }
      if (absorbedInto !== "") {
        const target = getSkill(absorbedInto) ?? (await store.get(absorbedInto));
        if (!target) {
          return {
            error: `absorbed_into names "${absorbedInto}", which is not an existing skill. Name the skill that actually covers this material, or pass "" to prune.`,
          };
        }
      }

      await store.remove(name);
      invalidateLearnedCatalog();
      await audit("delete", { name, absorbedInto });
      return {
        ok: true,
        message: absorbedInto
          ? `Deleted skill "${name}" (absorbed into "${absorbedInto}").`
          : `Deleted skill "${name}" (pruned).`,
      };
    },
  });
```

then change the returned map:

```ts
  const tools: Record<string, unknown> = { skill_manage };
  if (deps.includeView) tools.skill_view = skill_view;
  return tools;
```

- [ ] Restore the `it.todo("is absent when includeView is false")` in `test/selfskills-tool-view.test.ts` back to a real `it(...)` with the body written in Task 6.
- [ ] Run `npx vitest run test/selfskills-tool-manage.test.ts test/selfskills-tool-view.test.ts` — pass, no todos.
- [ ] Run `npx vitest run test/tools-contract.test.ts` — pass unchanged (proof that `skill_manage`/`skill_view` are turn-time tools, not `penTools`, so the cross-repo contract is untouched).
- [ ] Commit: `feat(selfskills): skill_manage create/patch/delete with curated + read-before-write guards`

---

### Task 8: Wire the skill tools and the learned catalog into `prepareChatTurn`

**Files**
- Modify: `src/ai/chatTurn.ts`
- Test: `test/selfskills-chat-turn.test.ts`

**Interfaces**
- Consumes: `getSharedLearnedSkillStore`, `getLearnedCatalog` (Task 3); `createSkillRunContext` (Task 5); `getSelfSkillTools` (Tasks 6-7); `getSelfImproveDb` (Phase 1).
- Produces: `PreparedChatTurn` gains one field:
```ts
export interface PreparedChatTurn {
  // …unchanged fields…
  /** Skills the agent wrote itself that were advertised in this turn's catalog. */
  learnedSkillNames: string[];
}
```

**Steps**

- [ ] Write `test/selfskills-chat-turn.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills } from "../src/ai/skills.js";
import {
  __resetSharedLearnedSkillStore,
  invalidateLearnedCatalog,
} from "../src/ai/skills/learnedStore.js";

vi.mock("../src/ai/provider.js", () => ({
  createModel: () => ({ modelId: "mock" }),
}));
vi.mock("../src/ai/mcp.js", () => ({ getMCPTools: async () => ({}) }));

const listActive = vi.fn();
vi.mock("../src/ai/skills/learnedStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/skills/learnedStore.js")>();
  return {
    ...actual,
    getSharedLearnedSkillStore: () => ({
      listActive,
      get: async () => null,
      create: async () => {},
      replaceBody: async () => {},
      remove: async () => true,
      bumpUse: async () => {},
      bumpView: async () => {},
    }),
  };
});

const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

function userMessage(text: string) {
  return [{ role: "user", parts: [{ type: "text", text }] }] as Array<Record<string, unknown>>;
}

describe("prepareChatTurn with self-authored skills", () => {
  beforeAll(async () => {
    await loadSkills();
  });
  afterEach(() => {
    invalidateLearnedCatalog();
    __resetSharedLearnedSkillStore();
    listActive.mockReset();
  });

  it("omits skill tools and learned catalog entries when the flag is off", async () => {
    listActive.mockResolvedValue([
      { name: "a-skill", description: "d", body: "b", createdBy: "agent", state: "active", useCount: 0, viewCount: 0 },
    ]);
    const prepared = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: false }),
      messages: userMessage("hi"),
      userId: "u1",
    });
    expect(prepared.tools.skill_manage).toBeUndefined();
    expect(prepared.tools.skill_view).toBeUndefined();
    expect(prepared.system).not.toContain("a-skill");
    expect(prepared.learnedSkillNames).toEqual([]);
  });

  it("adds skill_manage (but never skill_view) and merges the learned catalog when on", async () => {
    listActive.mockResolvedValue([
      { name: "a-skill", description: "does a thing", body: "b", createdBy: "agent", state: "active", useCount: 0, viewCount: 0 },
    ]);
    const prepared = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: userMessage("hi"),
      userId: "u1",
    });
    expect(prepared.tools.skill_manage).toBeDefined();
    expect(prepared.tools.skill_view).toBeUndefined();
    expect(prepared.system).toContain("- `a-skill` — does a thing (learned)");
    expect(prepared.learnedSkillNames).toEqual(["a-skill"]);
  });

  it("does not slash-invoke a learned skill (slash stays curated-only)", async () => {
    listActive.mockResolvedValue([
      { name: "a-skill", description: "d", body: "LEARNED BODY", createdBy: "agent", state: "active", useCount: 0, viewCount: 0 },
    ]);
    const messages = userMessage("/a-skill do the thing");
    const prepared = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages,
      userId: "u1",
    });
    expect(JSON.stringify(prepared.modelMessages)).not.toContain("LEARNED BODY");
    // The unresolved slash text passes through as plain text, unchanged.
    expect(JSON.stringify(prepared.modelMessages)).toContain("/a-skill do the thing");
  });

  it("still prepares a turn when the catalog read throws", async () => {
    listActive.mockRejectedValue(new Error("db down"));
    const prepared = await prepareChatTurn({
      config: makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true }),
      messages: userMessage("hi"),
      userId: "u1",
    });
    expect(prepared.learnedSkillNames).toEqual([]);
    expect(prepared.tools.skill_manage).toBeDefined();
  });

  it("adds nothing when there is no database configured", async () => {
    const prepared = await prepareChatTurn({
      config: makeConfig({ SELF_SKILLS_ENABLED: true }),
      messages: userMessage("hi"),
      userId: "u1",
    });
    expect(prepared.tools.skill_manage).toBeUndefined();
    expect(prepared.learnedSkillNames).toEqual([]);
  });
});
```

- [ ] Run `npx vitest run test/selfskills-chat-turn.test.ts` — see it fail.
- [ ] Modify `src/ai/chatTurn.ts`. Add imports:

```ts
import { getSelfImproveDb } from "./selfimprove/db.js";
import {
  getLearnedCatalog,
  getSharedLearnedSkillStore,
  type LearnedSkill,
} from "./skills/learnedStore.js";
import { createSkillRunContext } from "./skills/runContext.js";
import { getSelfSkillTools } from "./skills/tool.js";
```

Add the field to `PreparedChatTurn`:

```ts
  /** Skills the agent wrote itself that were advertised in this turn's catalog. */
  learnedSkillNames: string[];
```

Replace the catalog + tools section (from `const skillCatalog = …` down to the `return`) with:

```ts
  // Self-authored skills. Everything here is best-effort and additive: if the
  // flag is off, the DB is unconfigured, or the read fails, the turn is
  // exactly the turn that shipped before phase 2.
  const selfSkillsOn = config.SELF_SKILLS_ENABLED;
  const learnedStore = selfSkillsOn ? getSharedLearnedSkillStore(config) : null;
  const learnedSkills: LearnedSkill[] = learnedStore
    ? await getLearnedCatalog(learnedStore)
    : [];

  const skillCatalog = [
    ...getAllSkills().map((s) => ({ name: s.name, description: s.description })),
    ...learnedSkills.map((s) => ({
      name: s.name,
      description: s.description,
      learned: true,
    })),
  ];
  const system = buildSystemPrompt(canvasContext, skillCatalog);
```

(the `selectedModelId` / `systemPromptHash` / `normalizedMessages` / `modelMessages` / `taskPolicy` block below is unchanged), then the tool assembly:

```ts
  const mcpTools = await getMCPTools(config);
  // One run context per request: load_skill marks what the model actually
  // read, and skill_manage refuses to patch anything it did not.
  const skillRunContext = createSkillRunContext();
  const tools = {
    ...penTools,
    ...getWebTools(config),
    ...mcpTools,
    ...getSkillTools({ learnedStore, runContext: skillRunContext }),
  } as ToolSet;

  const selfImproveDb = selfSkillsOn ? getSelfImproveDb(config) : null;
  if (learnedStore && selfImproveDb) {
    Object.assign(
      tools,
      getSelfSkillTools({
        store: learnedStore,
        runContext: skillRunContext,
        db: selfImproveDb,
        // Skills are global, so a write is legitimate without a userId; the
        // audit row still needs one, and "anonymous" is the honest value.
        userId: input.userId ?? "anonymous",
        origin: "foreground",
        // skill_view belongs to the review run. In a design turn the model
        // reads a skill by loading it, and offering a second reader would
        // just invite it to browse the library mid-task.
        includeView: false,
      }),
    );
  }

  if (taskPolicy !== "native") {
    tools.batch_design = makeBatchDesignTool({ embedOnly: true });
    delete tools.draw_vector;
  }

  return {
    model,
    system,
    modelMessages,
    tools,
    taskPolicy,
    selectedModelId,
    systemPromptHash,
    slashSkillName,
    learnedSkillNames: learnedSkills.map((s) => s.name),
  };
```

- [ ] Run `npx vitest run test/selfskills-chat-turn.test.ts test/chat-turn.test.ts test/chat-route.test.ts test/chat-route-policy.test.ts` — pass.
- [ ] Commit: `feat(selfskills): merge learned catalog and skill_manage into prepareChatTurn`

---

### Task 9: Skill + combined review prompts

**Files**
- Create: `src/ai/skills/prompts.ts`
- Test: `test/selfskills-prompts.test.ts`

**Interfaces**
- Consumes: `MEMORY_REVIEW_PROMPT` from `src/ai/memory/prompts.js` (Phase 1) — imported, **never duplicated**.
- Produces:
```ts
export const SKILL_REVIEW_PROMPT: string;
export const MEMORY_SKILL_BRIDGE: string;
export function buildCombinedReviewPrompt(): string;
export function selectReviewPrompt(due: { memoryDue: boolean; skillDue: boolean }): string | null;
```

**Steps**

- [ ] Write `test/selfskills-prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import {
  MEMORY_SKILL_BRIDGE,
  SKILL_REVIEW_PROMPT,
  buildCombinedReviewPrompt,
  selectReviewPrompt,
} from "../src/ai/skills/prompts.js";

describe("skill review prompt", () => {
  it("carries the preference ladder in order", () => {
    const patchIdx = SKILL_REVIEW_PROMPT.indexOf("UPDATE A SKILL THAT WAS LOADED THIS SESSION");
    const existingIdx = SKILL_REVIEW_PROMPT.indexOf("UPDATE AN EXISTING SKILL");
    const createIdx = SKILL_REVIEW_PROMPT.indexOf("CREATE A NEW CLASS-LEVEL SKILL");
    expect(patchIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeLessThan(existingIdx);
    expect(existingIdx).toBeLessThan(createIdx);
  });

  it("carries the whole do-not-capture list", () => {
    for (const phrase of [
      "environment-dependent failures",
      "negative claims about tools",
      "transient errors that resolved",
      "one-off task narratives",
      "unresolved failures",
    ]) {
      expect(SKILL_REVIEW_PROMPT).toContain(phrase);
    }
  });

  it("keeps 'Nothing to save.' available but non-default, and names the tool restriction", () => {
    expect(SKILL_REVIEW_PROMPT).toContain("'Nothing to save.' is a real option but should NOT be the default.");
    expect(SKILL_REVIEW_PROMPT).toContain("You can only call skill and memory management tools.");
  });
});

describe("combined review prompt", () => {
  it("puts the memory half first, then the bridge, then the skill half", () => {
    const combined = buildCombinedReviewPrompt();
    const memIdx = combined.indexOf(MEMORY_REVIEW_PROMPT);
    const bridgeIdx = combined.indexOf(MEMORY_SKILL_BRIDGE);
    const skillIdx = combined.indexOf(SKILL_REVIEW_PROMPT);
    expect(memIdx).toBe(0);
    expect(memIdx).toBeLessThan(bridgeIdx);
    expect(bridgeIdx).toBeLessThan(skillIdx);
  });

  it("does not duplicate the memory prompt text", () => {
    const combined = buildCombinedReviewPrompt();
    expect(combined.split(MEMORY_REVIEW_PROMPT)).toHaveLength(2);
  });
});

describe("selectReviewPrompt", () => {
  it("returns the memory prompt when only memory is due", () => {
    expect(selectReviewPrompt({ memoryDue: true, skillDue: false })).toBe(MEMORY_REVIEW_PROMPT);
  });
  it("returns the skill prompt when only skills are due", () => {
    expect(selectReviewPrompt({ memoryDue: false, skillDue: true })).toBe(SKILL_REVIEW_PROMPT);
  });
  it("returns the combined prompt when both are due", () => {
    expect(selectReviewPrompt({ memoryDue: true, skillDue: true })).toBe(buildCombinedReviewPrompt());
  });
  it("returns null when nothing is due", () => {
    expect(selectReviewPrompt({ memoryDue: false, skillDue: false })).toBeNull();
  });
});
```

- [ ] Run `npx vitest run test/selfskills-prompts.test.ts` — see it fail.
- [ ] Create `src/ai/skills/prompts.ts`. **The prompt strings below are ported verbatim and must not be paraphrased, reflowed into different sentences, or "improved".**

```ts
import { MEMORY_REVIEW_PROMPT } from "../memory/prompts.js";

// Trailing user message of the background review run when only the skill
// counter fired. Ported verbatim (Hermes). Do not paraphrase: the bias
// against creating new skills, and the do-not-capture list, are the two
// things standing between this loop and a library full of
// "fix-the-thing-2026-08-11" entries.
export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich body. Not a long flat list of narrow one-session-one-skill entries. This shapes HOW you update, not WHETHER you update.

Signals that warrant action (any one is enough): the user corrected your style, tone, format, or verbosity (frustration signals like 'stop doing X' are FIRST-CLASS skill signals); the user corrected your workflow; a non-trivial technique, fix, or workaround emerged; a skill consulted this session was wrong or outdated — patch it NOW.

Preference order — a strong bias against creating new skills:
1. UPDATE A SKILL THAT WAS LOADED THIS SESSION — it is the skill that was in play.
2. UPDATE AN EXISTING SKILL that covers this class of task (check the catalog, view it first).
3. Only when nothing covers the class: CREATE A NEW CLASS-LEVEL SKILL. The name MUST NOT be a specific error string, feature codename, or 'fix-X / debug-Y-today' session artifact. If the proposed name only makes sense for today's task, it's wrong — fall back to (1) or (2).

Do NOT capture: environment-dependent failures (missing binaries, 'command not found'); negative claims about tools — these harden into refusals the agent cites against itself for months after the actual problem was fixed; transient errors that resolved; one-off task narratives; unresolved failures — do NOT write failed attempts up as a 'reliable workflow'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat.

'Nothing to save.' is a real option but should NOT be the default.

You can only call skill and memory management tools. Other tools will be denied at runtime — do not attempt them.`;

// Joins the memory half to the skill half when both counters fire in the same
// request. Without it the model treats the second half as a restatement of the
// first and writes the same lesson into memory twice.
export const MEMORY_SKILL_BRIDGE = `Memory captures 'who the user is and what the current situation and state of your operations are'; skills capture 'how to do this class of task for this user'. When the user complains about how you handled a task, update the skill that governs that task — memory alone isn't enough.`;

export function buildCombinedReviewPrompt(): string {
  return `${MEMORY_REVIEW_PROMPT}\n\n${MEMORY_SKILL_BRIDGE}\n\n${SKILL_REVIEW_PROMPT}`;
}

export function selectReviewPrompt(due: {
  memoryDue: boolean;
  skillDue: boolean;
}): string | null {
  if (due.memoryDue && due.skillDue) return buildCombinedReviewPrompt();
  if (due.memoryDue) return MEMORY_REVIEW_PROMPT;
  if (due.skillDue) return SKILL_REVIEW_PROMPT;
  return null;
}
```

- [ ] Run `npx vitest run test/selfskills-prompts.test.ts` — pass.
- [ ] Commit: `feat(selfskills): skill and combined background-review prompts`

---

### Task 10: Extend the background review runner with the skill branch

**Files**
- Modify: `src/ai/selfimprove/review.ts`
- Test: `test/selfskills-review.test.ts`

**Interfaces**
- Consumes: `bumpAndCheckCounters`, `withTransaction`, `getSelfImproveDb`, `getMemoryTools` (Phase 1); `selectReviewPrompt` (Task 9); `getSelfSkillTools` (Tasks 6-7); `getSharedLearnedSkillStore` (Task 3); `createSkillRunContext` (Task 5).
- Produces: no new exported symbols. `maybeRunReview` keeps its Phase 1 signature; its behavior gains: the `skillDue` branch, `SELF_SKILLS_ENABLED` gating, and the skill tools in the whitelist.

**Steps**

- [ ] Write `test/selfskills-review.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { makeConfig } from "./helpers.js";
import { loadSkills } from "../src/ai/skills.js";
import { SKILL_REVIEW_PROMPT } from "../src/ai/skills/prompts.js";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import { createPgliteSkillsHarness, type PgliteSkillsHarness } from "./pgliteSkillsHelpers.js";

const doStreamCalls: Array<Record<string, unknown>> = [];

vi.mock("../src/ai/provider.js", () => ({
  createModel: () =>
    new MockLanguageModelV3({
      doStream: async (options: Record<string, unknown>) => {
        doStreamCalls.push(options);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: "Nothing to save." },
              { type: "text-end", id: "0" },
              {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }),
}));
vi.mock("../src/ai/mcp.js", () => ({ getMCPTools: async () => ({}) }));

const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

let harness: PgliteSkillsHarness;

function lastPromptText(): string {
  const call = doStreamCalls.at(-1) as { prompt: Array<Record<string, unknown>> };
  return JSON.stringify(call.prompt);
}

function lastToolNames(): string[] {
  const call = doStreamCalls.at(-1) as { tools?: Array<{ name: string }> };
  return (call.tools ?? []).map((t) => t.name).sort();
}

async function prepared(config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true, MEMORY_ENABLED: true })) {
  return prepareChatTurn({
    config,
    messages: [{ role: "user", parts: [{ type: "text", text: "make the header tighter" }] }],
    userId: "u1",
  });
}

describe("maybeRunReview — skill branch", () => {
  beforeAll(async () => {
    await loadSkills();
    harness = await createPgliteSkillsHarness();
  });
  afterEach(async () => {
    await harness.reset();
    doStreamCalls.length = 0;
  });

  it("does not fire before the 15-step threshold", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true });
    const turn = await prepared(config);
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 14, db: harness.db });
    expect(doStreamCalls).toHaveLength(0);
  });

  it("fires the skill-only prompt at 15 accumulated steps and resets the counter", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true });
    const turn = await prepared(config);
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 10, db: harness.db });
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 5, db: harness.db });

    expect(doStreamCalls).toHaveLength(1);
    expect(lastPromptText()).toContain("Preference order — a strong bias against creating new skills");
    expect(lastPromptText()).not.toContain(MEMORY_REVIEW_PROMPT.slice(0, 40));

    const rows = (await harness.db.query(
      "SELECT steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ steps_since_skill: number }> };
    expect(rows.rows[0].steps_since_skill).toBe(0);
  });

  it("whitelists exactly the memory and skill tools", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true, MEMORY_ENABLED: true });
    const turn = await prepared(config);
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 15, db: harness.db });
    expect(lastToolNames()).toEqual(["memory", "skill_manage", "skill_view"]);
  });

  it("uses the combined prompt when both counters fire in one request", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true, MEMORY_ENABLED: true });
    const turn = await prepared(config);
    await harness.db.query(
      "INSERT INTO agent_review_state (user_id, turns_since_memory, steps_since_skill) VALUES ($1, 9, 14)",
      ["u1"],
    );
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 1, db: harness.db });

    expect(doStreamCalls).toHaveLength(1);
    const text = lastPromptText();
    expect(text).toContain("Memory captures");
    expect(text).toContain("Preference order — a strong bias against creating new skills");
  });

  it("still counts steps but never runs a skill review when SELF_SKILLS_ENABLED is off", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: false });
    const turn = await prepared(config);
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 30, db: harness.db });
    expect(doStreamCalls).toHaveLength(0);
  });

  it("reuses the turn's exact system string (warm prefix cache)", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true });
    const turn = await prepared(config);
    doStreamCalls.length = 0;
    await maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 15, db: harness.db });
    const call = doStreamCalls.at(-1) as { prompt: Array<{ role: string; content: unknown }> };
    const system = call.prompt.find((m) => m.role === "system");
    expect(system?.content).toBe(turn.system);
  });

  it("swallows a failing review so the user response is never affected", async () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://x", SELF_SKILLS_ENABLED: true });
    const turn = await prepared(config);
    const brokenDb = {
      async query() {
        throw new Error("db down");
      },
      async end() {},
    };
    await expect(
      maybeRunReview({ config, userId: "u1", prepared: turn, messages: [], stepCount: 20, db: brokenDb }),
    ).resolves.toBeUndefined();
  });
});
```

> The `db` field on `MaybeRunReviewInput` is a **test seam Phase 2 adds**: `db?: TraceQueryable`, defaulting to `getSelfImproveDb(config)`. Phase 1's production call site in `src/routes/chat.ts` passes no `db` and is unaffected.

- [ ] Run `npx vitest run test/selfskills-review.test.ts` — see it fail.
- [ ] Modify `src/ai/selfimprove/review.ts`. Add imports:

```ts
import { generateText, stepCountIs, type ToolSet } from "ai";
import { selectReviewPrompt } from "../skills/prompts.js";
import { getSharedLearnedSkillStore } from "../skills/learnedStore.js";
import { createSkillRunContext } from "../skills/runContext.js";
import { getSelfSkillTools } from "../skills/tool.js";
import type { TraceQueryable } from "../../tracing/traceStore.js";
```

Add the seam to the input interface:

```ts
export interface MaybeRunReviewInput {
  config: Config;
  userId: string | undefined;
  prepared: PreparedChatTurn;
  messages: Array<Record<string, unknown>>;
  stepCount: number;
  /** Test seam. Production callers omit it and get getSelfImproveDb(config). */
  db?: TraceQueryable;
}
```

Replace the body of `maybeRunReview` with:

```ts
export async function maybeRunReview(input: MaybeRunReviewInput): Promise<void> {
  const { config, userId, prepared, messages, stepCount } = input;
  try {
    // No userId: an anonymous request has no memory to review, and the
    // showcase runner and every headless entry point land here.
    if (!userId) return;
    if (!config.MEMORY_ENABLED && !config.SELF_SKILLS_ENABLED) return;

    const db = input.db ?? getSelfImproveDb(config);
    if (!db) return;

    // Increment and threshold check in ONE transaction: two concurrent
    // requests must not both see "9 turns" and both fire.
    const counters = await withTransaction(db, (tx) =>
      bumpAndCheckCounters(tx, userId, { turns: 1, steps: stepCount }),
    );

    // The counters keep accumulating while a flag is off, so flipping the
    // flag on does not need a fresh user to start firing — but a disabled
    // subsystem never runs a review.
    const due = {
      memoryDue: counters.memoryDue && config.MEMORY_ENABLED,
      skillDue: counters.skillDue && config.SELF_SKILLS_ENABLED,
    };
    const reviewPrompt = selectReviewPrompt(due);
    if (!reviewPrompt) return;

    const tools: ToolSet = {};
    if (config.MEMORY_ENABLED) {
      Object.assign(
        tools,
        getMemoryTools({ db, userId, origin: "background_review" }),
      );
    }
    if (config.SELF_SKILLS_ENABLED) {
      const store = getSharedLearnedSkillStore(config);
      if (store) {
        Object.assign(
          tools,
          getSelfSkillTools({
            store,
            // A FRESH run context: read-before-write must be satisfied inside
            // this review run, not by whatever the design turn happened to
            // load. skill_view is offered here and only here.
            runContext: createSkillRunContext(),
            db,
            userId,
            origin: "background_review",
            includeView: true,
          }),
        );
      }
    }
    if (Object.keys(tools).length === 0) return;

    // Same model and the turn's EXACT system string, so the review reuses the
    // warm prefix cache. The review's own transcript is never persisted into
    // any user-visible session: a persisted review prompt turns the agent into
    // "the curator" on the next turn.
    await generateText({
      model: prepared.model,
      system: prepared.system,
      messages: [
        ...prepared.modelMessages,
        { role: "user", content: reviewPrompt },
      ],
      tools,
      stopWhen: stepCountIs(8),
    });
  } catch (err) {
    console.error("[selfimprove] review run failed:", (err as Error).message);
  }
}
```

(`messages` stays in the input for Phase 1's logging hook; if Phase 1 does not use it, keep the parameter — the chat route passes it and `PreparedChatTurn.modelMessages` is what the review replays.)

- [ ] Run `npx vitest run test/selfskills-review.test.ts` — pass.
- [ ] Run `npx vitest run test/chat-route.test.ts test/chat-trace.test.ts` — pass (the route's `onFinish` call site is unchanged).
- [ ] Commit: `feat(selfskills): background review fires on the skill counter with skill tools`

---

### Task 11: Documentation

**Files**
- Modify: `CLAUDE.md`
- Modify: `.env.example`

**Interfaces**
- Consumes: nothing. Produces: no code.

**Steps**

- [ ] Add `SELF_SKILLS_ENABLED=false` to `.env.example` under the self-improvement block Phase 1 added, with the comment `# Phase 2: lets the agent write its own skills into agent_skills. Off until verified live.`
- [ ] Add a subsection to `CLAUDE.md` after the trace-analysis section:

```md
### Self-authored skills (`src/ai/skills/`, phase 2)

With `SELF_SKILLS_ENABLED=true` and `TRACE_DATABASE_URL` set, the agent
maintains its own skill library in `agent_skills` (global, not per-user).
`prepareChatTurn` merges those rows into the system prompt's skills catalog
marked `(learned)` and `load_skill` resolves them, bumping `use_count`.
`skill_manage` (create/patch/delete) is offered in normal turns; the
background review run (`maybeRunReview`, fires every 15 accumulated tool
steps) additionally gets `skill_view`. Guards: curated `src/skills/*.md` are
read-only to the tool, a name may not collide with a curated skill or a
`penTools` name, `description` ≤60 chars, `body` ≤200 lines, and patch/delete
require the skill to have been read in the same run. Learned skills are NOT
slash-invocable — `/name` stays curated-only. Every write lands in
`agent_selfimprove_audit`. `skill_manage`/`skill_view` are turn-time
backend-executed tools, NOT `penTools`, so the cross-repo tool contract is
untouched. Spec:
`docs/superpowers/specs/2026-08-11-self-improvement-loop-spec.md`.
```

- [ ] Commit: `docs(selfskills): document phase 2 in CLAUDE.md and .env.example`

---

### Task 12: Final verification

**Files**
- Modify: none expected. Test: the whole suite.

**Steps**

- [ ] Run the **full** suite: `npx vitest run` — all files green. **Check the reported file count** matches the number of `test/*.test.ts` files: `npm test -- run` is a name *filter*, not a run command, and silently runs ~2 files while looking green.
- [ ] Run `npm run lint` — 0 errors.
- [ ] Run `npm run build` — clean `tsc`.
- [ ] Run `npx vitest run --coverage` — thresholds in `vitest.config.ts` (statements 89 / branches 80 / functions 89 / lines 90) still pass. If a new module drags a number under its floor, add tests — **never lower a threshold**.
- [ ] Confirm the contract is untouched: `npx vitest run test/tools-contract.test.ts` passes with **no edit** to its hardcoded name list, and `git diff --stat main -- src/ai/tools.ts` is empty.
- [ ] Manual smoke, against a real Postgres:

  1. `export TRACE_DATABASE_URL=...`, `export SELF_SKILLS_ENABLED=true`, `export MEMORY_ENABLED=true`, then `npm run dev`. Startup migrations apply `010_agent_skills.sql`; confirm with
     `psql "$TRACE_DATABASE_URL" -c "select name from schema_migrations order by name desc limit 3"` → `010_agent_skills.sql` is listed.
  2. In the editor at `/app`, run one long design session with the same browser profile (so `pen.userId` is stable): ask for a screen, then **correct the agent's style twice** — e.g. "stop writing labels in Title Case, use sentence case" and "don't add a drop shadow to every card". Keep going until the turn has taken more than 15 tool steps in total (the browser network tab's `/api/chat` requests each carry a step count; the counter is cumulative across requests, so two medium turns are enough).
  3. Wait ~15s after the last response finishes (the review is fire-and-forget), then:
     `psql "$TRACE_DATABASE_URL" -c "select name, description, use_count, created_at from agent_skills order by created_at desc"`
     → expect **at least one row**, `created_by = 'agent'`, `state = 'active'`, a kebab-case class-level name (e.g. `honoring-user-style-corrections`), description ≤60 chars. A name like `fix-title-case-2026-08-11` means the ladder/name rule in `SKILL_REVIEW_PROMPT` was weakened — re-check the string is verbatim.
     `psql "$TRACE_DATABASE_URL" -c "select origin, subsystem, action, payload from agent_selfimprove_audit where subsystem='skill' order by created_at desc limit 5"`
     → expect `origin = 'background_review'`, `subsystem = 'skill'`, `action` in `create|patch|delete`, payload carrying `name` (+ `bodyLines` on create, `absorbedInto` on delete).
     `psql "$TRACE_DATABASE_URL" -c "select user_id, turns_since_memory, steps_since_skill from agent_review_state"`
     → `steps_since_skill` reset to a small number (whatever accumulated since the review fired), not still ≥15.
  4. Start a **new chat** in the same browser profile and send any message. In `pen-editor`'s network tab, or with `ENABLE_AGENT_LOGGING=true` and the dumped session log, find the system prompt and confirm the "Available Skills" catalog now contains
     `` - `<the-new-skill>` — <its description> (learned) `` plus the legend sentence "Skills marked `(learned)` are ones you wrote yourself…".
  5. Ask the agent to "load the <the-new-skill> skill" and confirm it returns the body, then
     `psql "$TRACE_DATABASE_URL" -c "select name, use_count, last_used_at from agent_skills"` → `use_count = 1`, `last_used_at` set.
  6. Guard check: ask the agent to "rewrite the prototype skill to stop using Phosphor icons". Expect a refusal from `skill_manage` naming `src/skills/prototype.md` as git-owned, **and** `git status` clean — no file on disk changed.
  7. Kill-switch check: restart with `SELF_SKILLS_ENABLED=false`, send a message, and confirm the system prompt has no `(learned)` entries and `skill_manage` is not in the tool list.
- [ ] Commit any fixes found by the smoke, then finish the branch per `superpowers:finishing-a-development-branch`.

---

## Self-review

**Spec coverage.** `agent_skills` DDL — Task 1, copied field-for-field from the spec's locked block. `skill_manage` create/patch/delete with `absorbed_into` — Task 7. Validation (kebab-case, description ≤60, body ≤200 lines, curated + `penTools` collision) — Task 2 (pure) enforced in Task 7 (wiring). `skill_view` for the review run — Task 6, `includeView` true only in Task 10's runner. Guards: curated read-only (Tasks 2 + 7, error names the git-owned path), read-before-write in an in-memory run context (Task 5's `SkillRunContext`, fresh per review run in Task 10). Catalog merge with `(learned)` — Tasks 4 + 8. `load_skill` resolving learned + `use_count` bump — Task 5. Review runner with `steps_since_skill` / threshold 15 and the skill + combined prompts — Tasks 9 + 10. Audit logging — Task 7, asserted on parameters. `SELF_SKILLS_ENABLED` checked in `prepareChatTurn` (Task 8) *and* `maybeRunReview` (Task 10). Learned skills global, not per-user — no `user_id` column anywhere in Task 1. Not slash-invocable — asserted in Task 8. No `penTools` change — asserted in Tasks 7 and 12. Tests: Vitest, PGlite for DB (Tasks 1, 3, 10), `MockLanguageModelV3` for the LLM (Task 10).

**Placeholder scan.** No "TBD", no "similar to Task N", no "add validation here". Every file is given as complete code or as an exact replacement of a named block. The one conditional in the plan is Task 6's `it.todo`, which is explicitly created and explicitly restored in Task 7 — a TDD sequencing device, not an unfinished instruction.

**Type consistency.** `LearnedSkill` is defined once (Task 3) and imported everywhere else. `SkillRunContext` once (Task 5). `SelfSkillToolDeps` is declared in Task 6 with `includeView`, and Task 7 adds `skill_manage` to the same factory without changing that interface. `SkillCatalogEntry.learned?: boolean` (Task 4) is what Task 8 produces. `AuditOrigin`/`writeAudit`/`withTransaction`/`bumpAndCheckCounters`/`getMemoryTools`/`MEMORY_REVIEW_PROMPT` are consumed exactly as declared in "Depends on Phase 1". `PreparedChatTurn` gains exactly one field (`learnedSkillNames: string[]`) and `MaybeRunReviewInput` exactly one optional test seam (`db?: TraceQueryable`). Every relative import in every snippet ends in `.js`.
