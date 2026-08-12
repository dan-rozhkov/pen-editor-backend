# Phase 1 — Persistent per-user memory (self-improvement loop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the design agent persistent, per-user memory in Postgres that is written by the model itself through a backend-executed `memory` tool, injected into every turn's system prompt, and refreshed by a background review pass that runs after the user's response has already streamed.

**Architecture:** The frontend generates a stable anonymous `pen.userId` in `localStorage` and sends it in the `/api/chat` body; the route resolves a `MemoryStore` (same Postgres pool pattern as `raw_traces`) and hands `userId` + store to `prepareChatTurn`, which renders the user's memory snapshot into the system prompt and injects a turn-time, backend-executed `memory` tool — exactly the mechanism `getSkillTools()` uses for `load_skill`, so nothing touches `penTools` or the cross-repo tool contract. After the stream finishes, `onFinish` fire-and-forgets `maybeRunReview()`, which bumps per-user counters in `agent_review_state` and, every 10 user turns, replays the conversation to the same model with only the `memory` tool and a review prompt attached. Every successful write lands in `agent_selfimprove_audit`.

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: NodeNext`), Fastify 5, Vercel AI SDK v6 (`ai`), zod 3, `pg`, Vitest, PGlite (`@electric-sql/pglite`, dev-dep) for real-engine SQL tests. Frontend: React 19 + `@ai-sdk/react` (`pen-editor` repo).

## Global Constraints

- **Char limits are on the serialized joined form** (entries joined with `"\n§\n"`): `memory` = **2200**, `user` = **1375**. Characters, not tokens. Budget is checked on the **final** state of a batch only.
- **Table DDL is locked** by `docs/superpowers/specs/2026-08-11-self-improvement-loop-spec.md` → "Storage". Phase 1 creates exactly `agent_memory`, `agent_review_state`, `agent_selfimprove_audit`; `agent_skills` is phase 2 and must NOT be created here.
- **Every read-modify-write runs `SELECT … FOR UPDATE` inside a transaction.** A failed read aborts the write — never rewrite from a view you did not actually read.
- **Env flags:** `MEMORY_ENABLED` (zod, default `false`, same `"true"/"1"`-only transform as `ENABLE_AGENT_LOGGING`) is the kill switch, checked in `prepareChatTurn` tool assembly and in `maybeRunReview`. Postgres comes from the existing `TRACE_DATABASE_URL` — no second URL. `SELF_SKILLS_ENABLED` is phase 2; do not add it.
- **Missing `userId` → memory silently disabled for that request.** The showcase runner passes none and must keep working unchanged.
- **Relative imports MUST carry the `.js` extension** (`import { loadConfig } from "../config.js"`), even in `.ts` source.
- **No `penTools` changes in this phase** → no cross-repo contract work, no `toolRegistry.ts` edit, no `tools-contract.test.ts` churn. The backend-first merge rule does not apply here; the one frontend change (`userId`) is independent and can land in either order.
- Review intervals: `MEMORY_REVIEW_INTERVAL = 10` (user turns). `SKILL_REVIEW_INTERVAL` is phase 2 — phase 1 only *accumulates* `steps_since_skill`.
- Review runs are **never persisted** into any user-visible session (no trace row, no message history mutation).

---

### Task 1: `MEMORY_ENABLED` config flag

**Files**
- Modify: `pen-editor-backend/src/config.ts` (add to `envSchema`, after `MCP_AUTH_TOKEN`)
- Modify: `pen-editor-backend/test/helpers.ts` (`makeConfig`)
- Test: `pen-editor-backend/test/load-config.test.ts` (append a case)

**Interfaces**
- Produces: `Config["MEMORY_ENABLED"]: boolean`

**Steps**
- [ ] Add a failing test to `test/load-config.test.ts`, inside the existing `describe("loadConfig")`:

```ts
  it("defaults MEMORY_ENABLED to false and honors only true/1", () => {
    process.env = { OPENROUTER_API_KEY: "key" } as NodeJS.ProcessEnv;
    expect(loadConfig().MEMORY_ENABLED).toBe(false);

    for (const [value, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["false", false],
      ["0", false],
      ["", false],
    ] as [string, boolean][]) {
      process.env = {
        OPENROUTER_API_KEY: "key",
        MEMORY_ENABLED: value,
      } as NodeJS.ProcessEnv;
      expect(loadConfig().MEMORY_ENABLED).toBe(expected);
    }
  });
```

- [ ] Run `npm test -- test/load-config.test.ts` in `pen-editor-backend` — expect a failure on `MEMORY_ENABLED` being `undefined`.
- [ ] Add to `envSchema` in `src/config.ts`, immediately after the `MCP_AUTH_TOKEN` entry:

```ts
  // --- Self-improvement loop (phase 1: persistent per-user memory) ---
  // Kill switch for the memory snapshot + `memory` tool + background review.
  // Same "true"/"1"-only transform as ENABLE_AGENT_LOGGING: z.coerce.boolean()
  // would treat "false" as true. Default false until verified live.
  MEMORY_ENABLED: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.toLowerCase();
      return s === "true" || s === "1";
    }),
```

- [ ] Add `MEMORY_ENABLED: false,` to the object literal in `test/helpers.ts` → `makeConfig`, right after `MCP_AUTH_TOKEN: undefined,`.
- [ ] Run `npm test -- test/load-config.test.ts` — expect pass.
- [ ] Commit: `feat(config): add MEMORY_ENABLED kill switch for persistent agent memory`

---

### Task 2: migration `009_agent_memory.sql` + a reusable PGlite harness

**Files**
- Create: `pen-editor-backend/src/analysis/migrations/009_agent_memory.sql`
- Modify: `pen-editor-backend/test/pgliteShowcaseHelpers.ts` (generalize; keep `createPgliteShowcaseHarness` working)
- Test: `pen-editor-backend/test/memory-migration.test.ts`

**Interfaces**
- Produces:
```ts
export interface PgliteQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
export interface PgliteHarness {
  db: TraceQueryable;                 // pool-shaped: query/end
  pool: {
    connect(): Promise<PgliteQueryClient>;
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    end(): Promise<void>;
  };
  reset(): Promise<void>;             // truncates the tables passed at creation
  close(): Promise<void>;
}
export function createPgliteHarness(truncateTables: string[]): Promise<PgliteHarness>;
export function createPgliteShowcaseHarness(): Promise<PgliteShowcaseHarness>;
```
- Consumes: `migrate()` from `../src/analysis/migrate.js`, the real files in `src/analysis/migrations/`.

**Steps**
- [ ] Write the failing test `test/memory-migration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness([
    "agent_memory",
    "agent_review_state",
    "agent_selfimprove_audit",
  ]);
});

afterAll(async () => {
  await harness.close();
});

describe("009_agent_memory.sql", () => {
  it("creates the three phase-1 tables with their defaults", async () => {
    await harness.pool.query(
      "INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)",
      ["u1", "memory"],
    );
    const memory = (await harness.pool.query(
      "SELECT entries, updated_at FROM agent_memory WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ entries: unknown; updated_at: unknown }> };
    expect(memory.rows[0].entries).toEqual([]);
    expect(memory.rows[0].updated_at).toBeTruthy();

    await harness.pool.query(
      "INSERT INTO agent_review_state (user_id) VALUES ($1)",
      ["u1"],
    );
    const state = (await harness.pool.query(
      "SELECT turns_since_memory, steps_since_skill FROM agent_review_state WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ turns_since_memory: number; steps_since_skill: number }> };
    expect(state.rows[0].turns_since_memory).toBe(0);
    expect(state.rows[0].steps_since_skill).toBe(0);

    await harness.pool.query(
      `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      ["u1", "foreground", "memory", "add", JSON.stringify({ n: 1 })],
    );
    const audit = (await harness.pool.query(
      "SELECT id, payload FROM agent_selfimprove_audit WHERE user_id = $1",
      ["u1"],
    )) as { rows: Array<{ id: string; payload: unknown }> };
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload).toEqual({ n: 1 });
  });

  it("rejects a target outside ('memory','user')", async () => {
    await expect(
      harness.pool.query(
        "INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)",
        ["u2", "skills"],
      ),
    ).rejects.toThrow();
  });

  it("does not create the phase-2 agent_skills table", async () => {
    const res = (await harness.pool.query(
      "SELECT to_regclass('public.agent_skills') AS reg",
      [],
    )) as { rows: Array<{ reg: string | null }> };
    expect(res.rows[0].reg).toBeNull();
  });
});
```

- [ ] Run `npm test -- test/memory-migration.test.ts` — expect failure (no `createPgliteHarness` export).
- [ ] Create `src/analysis/migrations/009_agent_memory.sql` (DDL verbatim from the spec's Storage section, phase-1 tables only):

```sql
-- Phase 1 of the self-improvement loop: per-user persistent memory.
-- Per-user scoping is the one place we deliberately improve on Hermes, which
-- shares a single memory file across every user of a deployment.
CREATE TABLE IF NOT EXISTS agent_memory (
  user_id    text NOT NULL,
  target     text NOT NULL CHECK (target IN ('memory','user')),
  entries    jsonb NOT NULL DEFAULT '[]',   -- string[]
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target)
);

-- Counters are cumulative per user, not per session: a user who only ever
-- sends two-message sessions must still reach the review threshold.
CREATE TABLE IF NOT EXISTS agent_review_state (
  user_id            text PRIMARY KEY,
  turns_since_memory int NOT NULL DEFAULT 0,
  steps_since_skill  int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Every autonomous write is audited from day one.
CREATE TABLE IF NOT EXISTS agent_selfimprove_audit (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  origin     text NOT NULL,                -- 'foreground' | 'background_review' | 'curator'
  subsystem  text NOT NULL,                -- 'memory' | 'skill'
  action     text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_selfimprove_audit_user_idx
  ON agent_selfimprove_audit (user_id, created_at DESC);
```

- [ ] Generalize `test/pgliteShowcaseHelpers.ts`. Keep the file's existing header comment, `SKIP_MIGRATIONS`, `MIGRATIONS_DIR` and `adaptPglite` exactly as they are, and replace the exported harness section (from `export interface PgliteShowcaseHarness` to the end of the file) with:

```ts
export interface PgliteQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

// Pool-shaped view over the single PGlite instance. PGlite is one connection,
// so BEGIN/COMMIT issued through `connect()` can never straddle two clients —
// which is exactly what makes it a valid stand-in for the `SELECT … FOR UPDATE`
// transactions the memory store runs against a real pg.Pool.
export interface PglitePool {
  connect(): Promise<PgliteQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface PgliteHarness {
  db: TraceQueryable;
  pool: PglitePool;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Boots a fresh in-memory PGlite instance and applies the real migrations
 * against it once. `reset()` truncates `truncateTables` without paying the
 * migration cost again. */
export async function createPgliteHarness(
  truncateTables: string[],
): Promise<PgliteHarness> {
  const pglite = new PGlite();
  const db = adaptPglite(pglite);

  const allFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const files = allFiles.filter((f) => !SKIP_MIGRATIONS.has(f));
  const dir = await mkdtemp(join(tmpdir(), "pglite-migrations-"));
  for (const file of files) {
    await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  await migrate(db, dir);

  const client: PgliteQueryClient = {
    query: (sql, params) => db.query(sql, params) as Promise<{ rows: unknown[] }>,
    release: () => {},
  };

  return {
    db,
    pool: {
      connect: async () => client,
      query: (sql, params) => db.query(sql, params) as Promise<{ rows: unknown[] }>,
      end: () => db.end(),
    },
    async reset() {
      if (truncateTables.length === 0) return;
      await pglite.exec(
        `TRUNCATE TABLE ${truncateTables.join(", ")} RESTART IDENTITY CASCADE`,
      );
    },
    async close() {
      await pglite.close();
    },
  };
}

export type PgliteShowcaseHarness = PgliteHarness;

export function createPgliteShowcaseHarness(): Promise<PgliteShowcaseHarness> {
  return createPgliteHarness(["showcase_screens", "showcase_app_likes"]);
}
```

- [ ] Run `npm test -- test/memory-migration.test.ts test/showcase-store-pglite.test.ts` — both green (the showcase suite proves the generalization is behavior-preserving).
- [ ] Commit: `feat(db): add agent_memory/agent_review_state/agent_selfimprove_audit migration`

---

### Task 3: pure memory operations (`applyMemoryOperations`)

**Files**
- Create: `pen-editor-backend/src/ai/memory/types.ts`
- Create: `pen-editor-backend/src/ai/memory/apply.ts`
- Test: `pen-editor-backend/test/memory-apply.test.ts`

**Interfaces**
- Produces (`types.ts`):
```ts
export type MemoryTarget = "memory" | "user";
export const MEMORY_SEPARATOR = "\n§\n";
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
export interface MemoryUsage { current: number; limit: number }
export interface MemorySnapshot { memory: string[]; user: string[] }
export interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
}
```
- Produces (`apply.ts`):
```ts
export function serializeEntries(entries: string[]): string;
export function usageOf(entries: string[], target: MemoryTarget): MemoryUsage;
export type MemoryApplyOutcome =
  | { ok: true; entries: string[]; usage: MemoryUsage }
  | {
      ok: false;
      kind: "over_capacity" | "no_match" | "ambiguous" | "invalid";
      message: string;
      usage: MemoryUsage;
      currentEntries: string[];
    };
export function applyMemoryOperations(
  entries: string[],
  operations: MemoryOperation[],
  target: MemoryTarget,
): MemoryApplyOutcome;
```

**Steps**
- [ ] Write the failing test `test/memory-apply.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyMemoryOperations, serializeEntries, usageOf } from "../src/ai/memory/apply.js";
import { MEMORY_LIMITS } from "../src/ai/memory/types.js";

describe("serializeEntries / usageOf", () => {
  it("joins with the record separator and measures characters", () => {
    expect(serializeEntries(["a", "b"])).toBe("a\n§\nb");
    expect(usageOf(["a", "b"], "user")).toEqual({ current: 5, limit: 1375 });
    expect(usageOf([], "memory")).toEqual({ current: 0, limit: 2200 });
  });
});

describe("applyMemoryOperations", () => {
  it("appends an add and reports the new usage", () => {
    const out = applyMemoryOperations([], [{ action: "add", content: "User prefers concise responses" }], "user");
    expect(out).toEqual({
      ok: true,
      entries: ["User prefers concise responses"],
      usage: { current: 30, limit: 1375 },
    });
  });

  it("applies a whole batch atomically in order", () => {
    const out = applyMemoryOperations(
      ["old note", "keep me"],
      [
        { action: "remove", old_text: "old note" },
        { action: "add", content: "new note" },
        { action: "replace", old_text: "keep me", content: "kept" },
      ],
      "memory",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["kept", "new note"]);
  });

  it("rejects an ambiguous old_text without mutating anything", () => {
    const out = applyMemoryOperations(
      ["user likes blue", "user likes blue buttons"],
      [{ action: "remove", old_text: "likes blue" }],
      "user",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("ambiguous");
      expect(out.message).toContain("matches 2 entries");
      expect(out.currentEntries).toEqual(["user likes blue", "user likes blue buttons"]);
    }
  });

  it("reports no_match when old_text matches nothing", () => {
    const out = applyMemoryOperations(["a"], [{ action: "remove", old_text: "zzz" }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("no_match");
  });

  it("rejects an empty add as invalid", () => {
    const out = applyMemoryOperations([], [{ action: "add", content: "   " }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("invalid");
  });

  it("checks the budget on the FINAL state only", () => {
    const filler = "x".repeat(MEMORY_LIMITS.user - 10);
    // Intermediate state is over budget, final state is not.
    const out = applyMemoryOperations(
      [filler],
      [
        { action: "add", content: "y".repeat(100) },
        { action: "remove", old_text: filler },
      ],
      "user",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.entries).toEqual(["y".repeat(100)]);
  });

  it("rejects an over-capacity final state and reports pre-batch usage", () => {
    const existing = "x".repeat(1370);
    const out = applyMemoryOperations([existing], [{ action: "add", content: "y".repeat(50) }], "user");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.kind).toBe("over_capacity");
      expect(out.usage).toEqual({ current: 1370, limit: 1375 });
      expect(out.message).toContain("50 chars");
      expect(out.currentEntries).toEqual([existing]);
    }
  });
});
```

- [ ] Run `npm test -- test/memory-apply.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/memory/types.ts`:

```ts
/** Which of the two always-in-prompt stores an operation targets. */
export type MemoryTarget = "memory" | "user";

/** Entries are stored as a jsonb string[], but every budget check is made on
 * this joined form — the separator's characters count against the limit. */
export const MEMORY_SEPARATOR = "\n§\n";

/** Characters, not tokens. Ported from Hermes verbatim: the char budget IS
 * the selection mechanism — there is no embedding retrieval and no TTL. */
export const MEMORY_LIMITS: Record<MemoryTarget, number> = {
  memory: 2200,
  user: 1375,
};

export interface MemoryUsage {
  current: number;
  limit: number;
}

export interface MemorySnapshot {
  memory: string[];
  user: string[];
}

export interface MemoryOperation {
  action: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
}

export const EMPTY_MEMORY_SNAPSHOT: MemorySnapshot = { memory: [], user: [] };
```

- [ ] Create `src/ai/memory/apply.ts`:

```ts
import {
  MEMORY_LIMITS,
  MEMORY_SEPARATOR,
  type MemoryOperation,
  type MemoryTarget,
  type MemoryUsage,
} from "./types.js";

export function serializeEntries(entries: string[]): string {
  return entries.join(MEMORY_SEPARATOR);
}

export function usageOf(entries: string[], target: MemoryTarget): MemoryUsage {
  return { current: serializeEntries(entries).length, limit: MEMORY_LIMITS[target] };
}

export type MemoryApplyOutcome =
  | { ok: true; entries: string[]; usage: MemoryUsage }
  | {
      ok: false;
      kind: "over_capacity" | "no_match" | "ambiguous" | "invalid";
      message: string;
      usage: MemoryUsage;
      currentEntries: string[];
    };

function findUnique(
  entries: string[],
  oldText: string,
): { index: number } | { matches: number[] } {
  const matches = entries
    .map((entry, index) => (entry.includes(oldText) ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length === 1) return { index: matches[0] };
  return { matches };
}

// Pure: takes the entries as they were actually read under FOR UPDATE and
// returns either the full replacement array or a typed failure. The whole
// batch is atomic — a single failing operation leaves `entries` untouched —
// and the budget is checked once, on the FINAL state, so a batch may pass
// through an intermediate state that is over the limit (consolidate + add in
// one call is the documented way out of a full store).
export function applyMemoryOperations(
  entries: string[],
  operations: MemoryOperation[],
  target: MemoryTarget,
): MemoryApplyOutcome {
  const before = [...entries];
  const fail = (
    kind: "over_capacity" | "no_match" | "ambiguous" | "invalid",
    message: string,
  ): MemoryApplyOutcome => ({
    ok: false,
    kind,
    message,
    usage: usageOf(before, target),
    currentEntries: before,
  });

  let next = [...entries];
  let addedChars = 0;

  for (const op of operations) {
    if (op.action === "add") {
      const content = op.content?.trim();
      if (!content) return fail("invalid", "An 'add' operation requires non-empty 'content'.");
      next = [...next, content];
      addedChars += content.length;
      continue;
    }

    const oldText = op.old_text?.trim();
    if (!oldText) {
      return fail(
        "invalid",
        `A '${op.action}' operation requires 'old_text' — a substring that uniquely identifies the entry.`,
      );
    }
    const found = findUnique(next, oldText);
    if ("matches" in found) {
      if (found.matches.length === 0) {
        return fail(
          "no_match",
          `No memory entry contains "${oldText}". Nothing was changed.`,
        );
      }
      const candidates = found.matches.map((i) => `- ${next[i]}`).join("\n");
      return fail(
        "ambiguous",
        `"${oldText}" matches ${found.matches.length} entries; use a longer, unique substring. Candidates:\n${candidates}`,
      );
    }

    if (op.action === "remove") {
      next = next.filter((_, i) => i !== found.index);
      continue;
    }

    const content = op.content?.trim();
    if (!content) {
      return fail("invalid", "A 'replace' operation requires non-empty 'content'.");
    }
    next = next.map((entry, i) => (i === found.index ? content : entry));
    addedChars += content.length;
  }

  const finalUsage = usageOf(next, target);
  if (finalUsage.current > finalUsage.limit) {
    const before_ = usageOf(before, target);
    return {
      ok: false,
      kind: "over_capacity",
      message: `Memory at ${before_.current}/${before_.limit} chars. Adding this entry (${addedChars} chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), then retry this add — all in this turn.`,
      usage: before_,
      currentEntries: before,
    };
  }

  return { ok: true, entries: next, usage: finalUsage };
}
```

- [ ] Run `npm test -- test/memory-apply.test.ts` — expect pass.
- [ ] Commit: `feat(memory): pure batch operations with final-state budget checking`

---

### Task 4: snapshot rendering

**Files**
- Create: `pen-editor-backend/src/ai/memory/render.ts`
- Test: `pen-editor-backend/test/memory-render.test.ts`

**Interfaces**
- Consumes: `MemorySnapshot`, `MemoryTarget`, `MEMORY_LIMITS`, `MEMORY_SEPARATOR` from `./types.js`; `usageOf` from `./apply.js`.
- Produces:
```ts
export function renderMemoryBlock(target: MemoryTarget, entries: string[]): string;
export function renderMemorySnapshot(snapshot: MemorySnapshot): string;
```

**Steps**
- [ ] Write the failing test `test/memory-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMemoryBlock, renderMemorySnapshot } from "../src/ai/memory/render.js";

const RULE = "═".repeat(46);

describe("renderMemoryBlock", () => {
  it("renders the header, the usage gauge and the separated entries", () => {
    const block = renderMemoryBlock("memory", ["first note", "second note"]);
    expect(block).toBe(
      [
        RULE,
        "MEMORY (your personal notes) [1% — 23/2,200 chars]",
        RULE,
        "first note\n§\nsecond note",
      ].join("\n"),
    );
  });

  it("uses the USER PROFILE header for the user target", () => {
    expect(renderMemoryBlock("user", ["Name: Dan"])).toContain(
      "USER PROFILE (who the user is) [1% — 9/1,375 chars]",
    );
  });

  it("groups thousands in both numbers", () => {
    const block = renderMemoryBlock("memory", ["x".repeat(1474)]);
    expect(block).toContain("[67% — 1,474/2,200 chars]");
  });

  it("renders nothing for an empty target", () => {
    expect(renderMemoryBlock("memory", [])).toBe("");
  });
});

describe("renderMemorySnapshot", () => {
  it("renders user profile first, then memory, separated by a blank line", () => {
    const out = renderMemorySnapshot({ user: ["Name: Dan"], memory: ["Uses zsh"] });
    expect(out.indexOf("USER PROFILE")).toBeLessThan(out.indexOf("MEMORY (your personal notes)"));
    expect(out).toContain("\n\n");
  });

  it("returns an empty string when both targets are empty", () => {
    expect(renderMemorySnapshot({ user: [], memory: [] })).toBe("");
  });
});
```

- [ ] Run `npm test -- test/memory-render.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/memory/render.ts`:

```ts
import { usageOf, serializeEntries } from "./apply.js";
import type { MemorySnapshot, MemoryTarget } from "./types.js";

const RULE = "═".repeat(46);

const HEADERS: Record<MemoryTarget, string> = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
};

// The usage gauge is deliberately visible to the model: it is the only signal
// it gets that consolidation is due, since there is no eviction policy.
export function renderMemoryBlock(target: MemoryTarget, entries: string[]): string {
  if (entries.length === 0) return "";
  const { current, limit } = usageOf(entries, target);
  const percent = Math.round((current / limit) * 100);
  const gauge = `[${percent}% — ${current.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars]`;
  return [RULE, `${HEADERS[target]} ${gauge}`, RULE, serializeEntries(entries)].join("\n");
}

// User profile first: who the user is frames how to read the agent's own
// notes. Loaded once per request and never re-read mid-turn — the tool's
// success response is terminal precisely because this block is already stale
// the moment a write lands.
export function renderMemorySnapshot(snapshot: MemorySnapshot): string {
  return [
    renderMemoryBlock("user", snapshot.user),
    renderMemoryBlock("memory", snapshot.memory),
  ]
    .filter(Boolean)
    .join("\n\n");
}
```

- [ ] Run `npm test -- test/memory-render.test.ts` — expect pass.
- [ ] Commit: `feat(memory): render the per-user memory snapshot block`

---

### Task 5: prompt texts (`MEMORY_GUIDANCE`, tool description, review prompt)

**Files**
- Create: `pen-editor-backend/src/ai/memory/prompts.ts`
- Test: `pen-editor-backend/test/memory-prompts.test.ts`

**Interfaces**
- Produces:
```ts
export const MEMORY_GUIDANCE: string;
export const MEMORY_TOOL_DESCRIPTION: string;
export const MEMORY_REVIEW_PROMPT: string;
export const MEMORY_WRITE_SAVED: string;
export const MEMORY_CIRCUIT_BREAKER: string;
```

**Steps**
- [ ] Write the failing test `test/memory-prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MEMORY_CIRCUIT_BREAKER,
  MEMORY_GUIDANCE,
  MEMORY_REVIEW_PROMPT,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_WRITE_SAVED,
} from "../src/ai/memory/prompts.js";

describe("memory prompts", () => {
  it("keeps the anti-staleness and declarative-facts rules in the guidance", () => {
    expect(MEMORY_GUIDANCE).toContain("If a fact will be stale in a week, it does not belong in memory.");
    expect(MEMORY_GUIDANCE).toContain("Write memories as declarative facts, not instructions to yourself.");
    expect(MEMORY_GUIDANCE).toContain("Do NOT save task progress");
  });

  it("keeps the HOW/WHEN/IF FULL/TARGETS/SKIP blocks in the tool description", () => {
    for (const marker of ["HOW:", "WHEN:", "IF FULL:", "TARGETS:", "SKIP:"]) {
      expect(MEMORY_TOOL_DESCRIPTION).toContain(marker);
    }
    expect(MEMORY_TOOL_DESCRIPTION).toContain("one batch call finishes the update, so don't repeat it");
  });

  it("tells the review run it may only call the memory tool", () => {
    expect(MEMORY_REVIEW_PROMPT).toContain("You can only call the memory tool.");
    expect(MEMORY_REVIEW_PROMPT).toContain("Nothing to save.");
  });

  it("keeps the terminal success line and the circuit-breaker line", () => {
    expect(MEMORY_WRITE_SAVED).toBe("Write saved. This update is complete — do not repeat it.");
    expect(MEMORY_CIRCUIT_BREAKER).toContain("Stop retrying memory calls");
  });
});
```

- [ ] Run `npm test -- test/memory-prompts.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/memory/prompts.ts` (texts ported from Hermes verbatim — do not paraphrase when editing later):

```ts
// Stable tier of the system prompt: appended right after CORE_PROMPT, before
// the skills catalog, and ONLY when the memory tool is actually present. It
// must sit above the snapshot itself so the varying part (the entries) stays
// at the end of the cached prefix.
export const MEMORY_GUIDANCE = `You have persistent memory across sessions. Save durable facts using the memory tool: user preferences, environment details, tool quirks, and stable conventions. Memory is injected into every turn, so keep it compact and focused on facts that will still matter later.
Prioritize what reduces future user steering — the most valuable memory is one that prevents the user from having to correct or remind you again. User preferences and recurring corrections matter more than procedural task details.
Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory. Specifically: do not record 'fixed bug X', 'Phase N done', file counts, or any artifact that will be stale in 7 days. If a fact will be stale in a week, it does not belong in memory.
Write memories as declarative facts, not instructions to yourself. 'User prefers concise responses' ✓ — 'Always respond concisely' ✗. Imperative phrasing gets re-read as a directive in later sessions and can cause repeated work or override the user's current request.`;

// Behavioral guidance lives in the tool schema description by design: it is
// re-read at the moment of the call, where the model is actually deciding.
export const MEMORY_TOOL_DESCRIPTION = `Save durable facts to persistent memory that survive across sessions. Memory is injected into every future turn, so keep entries compact and high-signal.
HOW: make ALL your changes in ONE call via an 'operations' array. The batch applies atomically and the char limit is checked only on the FINAL result. The response reports current/limit chars and confirms completion; one batch call finishes the update, so don't repeat it.
WHEN: save proactively when the user states a preference, correction, or personal detail, or you learn a stable fact about their environment, conventions, or workflow. Priority: user preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves.
IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.
TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).
SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state.`;

// Trailing user message of the background review run. Never persisted into a
// user-visible session: a stored review prompt turns the agent into "the
// curator" on the next real turn.
export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say 'Nothing to save.' and stop.

You can only call the memory tool. Other tools will be denied at runtime — do not attempt them.`;

// Terminal by design: the success response does NOT echo the entries, or the
// model re-reads its own write as new information and writes it again.
export const MEMORY_WRITE_SAVED =
  "Write saved. This update is complete — do not repeat it.";

export const MEMORY_CIRCUIT_BREAKER =
  "Stop retrying memory calls — leave memory unchanged for now and continue with your reply to the user. The fact can be saved in a later turn.";
```

- [ ] Run `npm test -- test/memory-prompts.test.ts` — expect pass.
- [ ] Commit: `feat(memory): add MEMORY_GUIDANCE, tool description and review prompt`

---

### Task 6: `MemoryStore` (Postgres, FOR UPDATE, counters, audit)

**Files**
- Create: `pen-editor-backend/src/ai/memory/store.ts`
- Test: `pen-editor-backend/test/memory-store-pglite.test.ts`

**Interfaces**
- Consumes: `createPgPool` from `../../tracing/traceStore.js`, `Config`, `applyMemoryOperations`, types from Task 3.
- Produces:
```ts
export interface MemoryQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
export interface MemoryPool {
  connect(): Promise<MemoryQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
export type AuditOrigin = "foreground" | "background_review" | "curator";
export interface AuditEntry {
  userId: string;
  origin: AuditOrigin;
  subsystem: "memory" | "skill";
  action: string;
  payload: Record<string, unknown>;
}
export interface ReviewCounters {
  turnsSinceMemory: number;
  stepsSinceSkill: number;
  memoryReviewDue: boolean;
}
export interface MemoryStore {
  loadSnapshot(userId: string): Promise<MemorySnapshot>;
  applyOperations(input: {
    userId: string;
    target: MemoryTarget;
    operations: MemoryOperation[];
    origin: AuditOrigin;
  }): Promise<MemoryApplyOutcome>;
  bumpCounters(input: {
    userId: string;
    turns: number;
    steps: number;
    memoryInterval: number;
  }): Promise<ReviewCounters>;
  writeAudit(entry: AuditEntry): Promise<void>;
  close(): Promise<void>;
}
export const MEMORY_REVIEW_INTERVAL = 10;
export function createMemoryStore(config: Config, pool?: MemoryPool): MemoryStore | null;
```

**Steps**
- [ ] Write the failing test `test/memory-store-pglite.test.ts` (PGlite, real engine — the fake-DB lesson from the showcase filters applies: SQL must run against a real planner):

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../src/ai/memory/store.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { makeConfig } from "./helpers.js";

let harness: PgliteHarness;
let store: MemoryStore;

beforeAll(async () => {
  harness = await createPgliteHarness([
    "agent_memory",
    "agent_review_state",
    "agent_selfimprove_audit",
  ]);
  const created = createMemoryStore(
    makeConfig({ TRACE_DATABASE_URL: "postgres://unused" }),
    harness.pool,
  );
  expect(created).not.toBeNull();
  store = created!;
});

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

describe("createMemoryStore", () => {
  it("returns null without TRACE_DATABASE_URL", () => {
    expect(createMemoryStore(makeConfig())).toBeNull();
  });
});

describe("loadSnapshot / applyOperations", () => {
  it("returns an empty snapshot for an unknown user", async () => {
    expect(await store.loadSnapshot("nobody")).toEqual({ memory: [], user: [] });
  });

  it("persists an add and reads it back on both targets independently", async () => {
    const out = await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "User prefers concise responses" }],
      origin: "foreground",
    });
    expect(out.ok).toBe(true);

    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "Repo uses ESM with .js import extensions" }],
      origin: "foreground",
    });

    expect(await store.loadSnapshot("u1")).toEqual({
      user: ["User prefers concise responses"],
      memory: ["Repo uses ESM with .js import extensions"],
    });
  });

  it("scopes memory per user", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "A" }],
      origin: "foreground",
    });
    expect(await store.loadSnapshot("u2")).toEqual({ memory: [], user: [] });
  });

  it("leaves the row untouched when the batch fails", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "add", content: "keep" }],
      origin: "foreground",
    });
    const out = await store.applyOperations({
      userId: "u1",
      target: "user",
      operations: [{ action: "remove", old_text: "missing" }],
      origin: "foreground",
    });
    expect(out.ok).toBe(false);
    expect((await store.loadSnapshot("u1")).user).toEqual(["keep"]);
  });

  it("audits every successful write and nothing else", async () => {
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "add", content: "note" }],
      origin: "background_review",
    });
    await store.applyOperations({
      userId: "u1",
      target: "memory",
      operations: [{ action: "remove", old_text: "nope" }],
      origin: "background_review",
    });

    const rows = (await harness.pool.query(
      "SELECT origin, subsystem, action, payload FROM agent_selfimprove_audit WHERE user_id = $1",
      ["u1"],
    )) as {
      rows: Array<{ origin: string; subsystem: string; action: string; payload: Record<string, unknown> }>;
    };
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].origin).toBe("background_review");
    expect(rows.rows[0].subsystem).toBe("memory");
    expect(rows.rows[0].action).toBe("add");
    expect(rows.rows[0].payload).toMatchObject({ target: "memory", entryCount: 1 });
  });
});

describe("bumpCounters", () => {
  it("accumulates across requests and fires + resets exactly at the threshold", async () => {
    let last = { turnsSinceMemory: 0, stepsSinceSkill: 0, memoryReviewDue: false };
    for (let i = 0; i < 3; i++) {
      last = await store.bumpCounters({ userId: "u1", turns: 1, steps: 2, memoryInterval: 3 });
    }
    expect(last).toEqual({ turnsSinceMemory: 3, stepsSinceSkill: 6, memoryReviewDue: true });

    const after = await store.bumpCounters({ userId: "u1", turns: 1, steps: 1, memoryInterval: 3 });
    expect(after.turnsSinceMemory).toBe(1);
    expect(after.memoryReviewDue).toBe(false);
    // steps_since_skill is phase 2's counter — the memory reset must not clear it.
    expect(after.stepsSinceSkill).toBe(7);
  });
});
```

- [ ] Run `npm test -- test/memory-store-pglite.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/memory/store.ts`:

```ts
import type { Config } from "../../config.js";
import { createPgPool } from "../../tracing/traceStore.js";
import { applyMemoryOperations, type MemoryApplyOutcome } from "./apply.js";
import {
  EMPTY_MEMORY_SNAPSHOT,
  type MemoryOperation,
  type MemorySnapshot,
  type MemoryTarget,
} from "./types.js";

/** Every user turn counts; the review fires (and the counter resets) at 10. */
export const MEMORY_REVIEW_INTERVAL = 10;

// A checked-out client is required, not optional: `SELECT … FOR UPDATE` only
// holds a lock for the transaction that took it, and BEGIN/COMMIT issued
// through a pool can land on different clients (this is exactly the trap
// documented in showcase/store.ts's pinScreen).
export interface MemoryQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface MemoryPool {
  connect(): Promise<MemoryQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export type AuditOrigin = "foreground" | "background_review" | "curator";

export interface AuditEntry {
  userId: string;
  origin: AuditOrigin;
  subsystem: "memory" | "skill";
  action: string;
  payload: Record<string, unknown>;
}

export interface ReviewCounters {
  turnsSinceMemory: number;
  stepsSinceSkill: number;
  memoryReviewDue: boolean;
}

export interface MemoryStore {
  loadSnapshot(userId: string): Promise<MemorySnapshot>;
  applyOperations(input: {
    userId: string;
    target: MemoryTarget;
    operations: MemoryOperation[];
    origin: AuditOrigin;
  }): Promise<MemoryApplyOutcome>;
  bumpCounters(input: {
    userId: string;
    turns: number;
    steps: number;
    memoryInterval: number;
  }): Promise<ReviewCounters>;
  writeAudit(entry: AuditEntry): Promise<void>;
  close(): Promise<void>;
}

function toEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function createMemoryStore(
  config: Config,
  pool?: MemoryPool,
): MemoryStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: MemoryPool = pool ?? (createPgPool(config.TRACE_DATABASE_URL) as unknown as MemoryPool);

  const writeAudit = async (entry: AuditEntry): Promise<void> => {
    await db.query(
      `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [entry.userId, entry.origin, entry.subsystem, entry.action, JSON.stringify(entry.payload)],
    );
  };

  return {
    async loadSnapshot(userId) {
      const result = (await db.query(
        "SELECT target, entries FROM agent_memory WHERE user_id = $1",
        [userId],
      )) as { rows: Array<{ target: MemoryTarget; entries: unknown }> };
      const snapshot: MemorySnapshot = { ...EMPTY_MEMORY_SNAPSHOT };
      for (const row of result.rows) {
        if (row.target === "memory" || row.target === "user") {
          snapshot[row.target] = toEntries(row.entries);
        }
      }
      return snapshot;
    },

    async applyOperations({ userId, target, operations, origin }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Materialize the row first: FOR UPDATE locks nothing on a row that
        // does not exist yet, so two concurrent first-writes would both read
        // an empty list and one would silently lose its entry.
        await client.query(
          `INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)
           ON CONFLICT (user_id, target) DO NOTHING`,
          [userId, target],
        );
        const read = (await client.query(
          "SELECT entries FROM agent_memory WHERE user_id = $1 AND target = $2 FOR UPDATE",
          [userId, target],
        )) as { rows: Array<{ entries: unknown }> };
        const current = toEntries(read.rows[0]?.entries);

        const outcome = applyMemoryOperations(current, operations, target);
        if (!outcome.ok) {
          await client.query("ROLLBACK");
          return outcome;
        }

        await client.query(
          "UPDATE agent_memory SET entries = $3::jsonb, updated_at = now() WHERE user_id = $1 AND target = $2",
          [userId, target, JSON.stringify(outcome.entries)],
        );
        await client.query(
          `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            userId,
            origin,
            "memory",
            operations.map((op) => op.action).join("+"),
            JSON.stringify({
              target,
              operations,
              entryCount: outcome.entries.length,
              usage: outcome.usage,
            }),
          ],
        );
        await client.query("COMMIT");
        return outcome;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction is already dead; the original error is what matters.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async bumpCounters({ userId, turns, steps, memoryInterval }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO agent_review_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
          [userId],
        );
        await client.query(
          "SELECT user_id FROM agent_review_state WHERE user_id = $1 FOR UPDATE",
          [userId],
        );
        const updated = (await client.query(
          `UPDATE agent_review_state
              SET turns_since_memory = turns_since_memory + $2,
                  steps_since_skill  = steps_since_skill + $3,
                  updated_at = now()
            WHERE user_id = $1
        RETURNING turns_since_memory, steps_since_skill`,
          [userId, turns, steps],
        )) as { rows: Array<{ turns_since_memory: number; steps_since_skill: number }> };

        const turnsSinceMemory = Number(updated.rows[0].turns_since_memory);
        const stepsSinceSkill = Number(updated.rows[0].steps_since_skill);
        const memoryReviewDue = turnsSinceMemory >= memoryInterval;

        // Reset inside the same transaction that observed the threshold, so
        // two concurrent requests can never both fire the review.
        if (memoryReviewDue) {
          await client.query(
            "UPDATE agent_review_state SET turns_since_memory = 0 WHERE user_id = $1",
            [userId],
          );
        }
        await client.query("COMMIT");
        return { turnsSinceMemory, stepsSinceSkill, memoryReviewDue };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // See applyOperations.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    writeAudit,

    close: () => db.end(),
  };
}
```

- [ ] Run `npm test -- test/memory-store-pglite.test.ts` — expect pass.
- [ ] Commit: `feat(memory): MemoryStore with FOR UPDATE writes, counters and audit`

---

### Task 7: the backend-executed `memory` tool

**Files**
- Create: `pen-editor-backend/src/ai/memory/tool.ts`
- Test: `pen-editor-backend/test/memory-tool.test.ts`

**Interfaces**
- Consumes: `MemoryStore`, `AuditOrigin` (Task 6); prompts (Task 5); `MemoryTarget`, `MemoryOperation` (Task 3).
- Produces:
```ts
export interface MemoryToolContext {
  store: MemoryStore;
  userId: string;
  origin: AuditOrigin;
  failures: { count: number };
}
export const MEMORY_MAX_FAILURES = 3;
export function createMemoryToolContext(
  store: MemoryStore,
  userId: string,
  origin: AuditOrigin,
): MemoryToolContext;
export function getMemoryTools(ctx: MemoryToolContext): Record<string, unknown>;
```
- Tool result shapes (what the model sees):
  - success `{ ok: true, message: MEMORY_WRITE_SAVED, usage: { current, limit } }`
  - over capacity `{ ok: false, error: string, current_entries: string[], usage: { current, limit } }`
  - other failure `{ ok: false, error: string, usage: { current, limit } }`
  - circuit breaker `{ ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER }`

**Steps**
- [ ] Write the failing test `test/memory-tool.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createMemoryToolContext, getMemoryTools } from "../src/ai/memory/tool.js";
import { MEMORY_CIRCUIT_BREAKER, MEMORY_TOOL_DESCRIPTION, MEMORY_WRITE_SAVED } from "../src/ai/memory/prompts.js";
import type { MemoryApplyOutcome } from "../src/ai/memory/apply.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

function fakeStore(outcomes: MemoryApplyOutcome[]): {
  store: MemoryStore;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const store = {
    loadSnapshot: vi.fn(async () => ({ memory: [], user: [] })),
    applyOperations: vi.fn(async (input: unknown) => {
      calls.push(input);
      return outcomes.shift() ?? { ok: true, entries: [], usage: { current: 0, limit: 1375 } };
    }),
    bumpCounters: vi.fn(),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
  return { store, calls };
}

interface MemoryTool {
  description: string;
  execute: (input: unknown) => Promise<Record<string, unknown>>;
}

function toolOf(store: MemoryStore) {
  const ctx = createMemoryToolContext(store, "u1", "foreground");
  return { ctx, memory: getMemoryTools(ctx).memory as unknown as MemoryTool };
}

describe("memory tool", () => {
  it("carries the Hermes tool description", () => {
    const { memory } = toolOf(fakeStore([]).store);
    expect(memory.description).toBe(MEMORY_TOOL_DESCRIPTION);
  });

  it("returns the terminal success line without echoing entries", async () => {
    const { store } = fakeStore([
      { ok: true, entries: ["a"], usage: { current: 1, limit: 1375 } },
    ]);
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "User prefers concise responses" }],
    });
    expect(result).toEqual({
      ok: true,
      message: MEMORY_WRITE_SAVED,
      usage: { current: 1, limit: 1375 },
    });
    expect(JSON.stringify(result)).not.toContain("\"a\"");
  });

  it("passes the target, operations and origin to the store", async () => {
    const { store, calls } = fakeStore([]);
    const { memory } = toolOf(store);
    await memory.execute({
      target: "memory",
      operations: [{ action: "remove", old_text: "old" }],
    });
    expect(calls[0]).toEqual({
      userId: "u1",
      target: "memory",
      operations: [{ action: "remove", old_text: "old" }],
      origin: "foreground",
    });
  });

  it("returns current_entries and the consolidate instruction when over capacity", async () => {
    const { store } = fakeStore([
      {
        ok: false,
        kind: "over_capacity",
        message: "Memory at 1370/1375 chars. Adding this entry (50 chars) would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into shorter ones or 'remove' stale or less important entries (see current_entries below), then retry this add — all in this turn.",
        usage: { current: 1370, limit: 1375 },
        currentEntries: ["one", "two"],
      },
    ]);
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Consolidate now");
    expect(result.current_entries).toEqual(["one", "two"]);
    expect(result.usage).toEqual({ current: 1370, limit: 1375 });
  });

  it("trips the circuit breaker after 3 failed calls in one request", async () => {
    const failure: MemoryApplyOutcome = {
      ok: false,
      kind: "no_match",
      message: "No memory entry contains \"zzz\". Nothing was changed.",
      usage: { current: 0, limit: 1375 },
      currentEntries: [],
    };
    const { store } = fakeStore([failure, failure, failure]);
    const { memory } = toolOf(store);
    const call = () =>
      memory.execute({ target: "user", operations: [{ action: "remove", old_text: "zzz" }] });

    await call();
    await call();
    await call();
    const fourth = await call();

    expect(fourth).toEqual({ ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER });
  });

  it("turns a store throw into a model-readable error instead of failing the turn", async () => {
    const store = {
      applyOperations: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    } as unknown as MemoryStore;
    const { memory } = toolOf(store);
    const result = await memory.execute({
      target: "user",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Memory is temporarily unavailable");
  });
});
```

- [ ] Run `npm test -- test/memory-tool.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/memory/tool.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import {
  MEMORY_CIRCUIT_BREAKER,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_WRITE_SAVED,
} from "./prompts.js";
import type { AuditOrigin, MemoryStore } from "./store.js";
import type { MemoryOperation, MemoryTarget } from "./types.js";

/** After this many failed memory calls in ONE request the tool stops the
 * model rather than letting it burn the whole step budget retrying. */
export const MEMORY_MAX_FAILURES = 3;

export interface MemoryToolContext {
  store: MemoryStore;
  userId: string;
  origin: AuditOrigin;
  // Per-request, mutable: a fresh context is built for every turn (and for
  // every review run), so the counter can never leak across requests.
  failures: { count: number };
}

export function createMemoryToolContext(
  store: MemoryStore,
  userId: string,
  origin: AuditOrigin,
): MemoryToolContext {
  return { store, userId, origin, failures: { count: 0 } };
}

const memoryInputSchema = z.object({
  target: z
    .enum(["memory", "user"])
    .describe(
      "'user' = who the user is (name, role, preferences, style). 'memory' = your own notes (environment, conventions, tool quirks, lessons).",
    ),
  operations: z
    .array(
      z.object({
        action: z.enum(["add", "replace", "remove"]),
        content: z
          .string()
          .optional()
          .describe("The new entry text. Required for 'add' and 'replace'."),
        old_text: z
          .string()
          .optional()
          .describe(
            "A substring that uniquely identifies the entry to change. Required for 'replace' and 'remove'; an ambiguous substring is rejected with the candidates listed.",
          ),
      }),
    )
    .min(1)
    .max(20)
    .describe("All changes for this call, applied atomically and in order."),
});

type MemoryInput = { target: MemoryTarget; operations: MemoryOperation[] };

export function getMemoryTools(ctx: MemoryToolContext): Record<string, unknown> {
  const memory = tool({
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: memoryInputSchema,
    execute: async ({ target, operations }: MemoryInput) => {
      if (ctx.failures.count >= MEMORY_MAX_FAILURES) {
        return { ok: false, done: true, error: MEMORY_CIRCUIT_BREAKER };
      }

      let outcome;
      try {
        outcome = await ctx.store.applyOperations({
          userId: ctx.userId,
          target,
          operations,
          origin: ctx.origin,
        });
      } catch (err) {
        ctx.failures.count += 1;
        console.error("[memory] write failed:", err);
        return {
          ok: false,
          error:
            "Memory is temporarily unavailable (storage error). Continue with your reply; the fact can be saved in a later turn.",
        };
      }

      if (outcome.ok) {
        return { ok: true, message: MEMORY_WRITE_SAVED, usage: outcome.usage };
      }

      ctx.failures.count += 1;
      // Only the over-capacity path echoes the entries: that error is the one
      // the model is expected to fix in the same turn, and it cannot
      // consolidate what it cannot see.
      if (outcome.kind === "over_capacity") {
        return {
          ok: false,
          error: outcome.message,
          current_entries: outcome.currentEntries,
          usage: outcome.usage,
        };
      }
      return { ok: false, error: outcome.message, usage: outcome.usage };
    },
  });

  return { memory };
}
```

- [ ] Run `npm test -- test/memory-tool.test.ts` — expect pass.
- [ ] Commit: `feat(memory): backend-executed memory tool with circuit breaker`

---

### Task 8: snapshot + guidance in `buildSystemPrompt` and `prepareChatTurn`

**Files**
- Modify: `pen-editor-backend/src/ai/system-prompt.ts` (`buildSystemPrompt`, lines 9–24)
- Modify: `pen-editor-backend/src/ai/chatTurn.ts` (`PrepareChatTurnInput`/`PreparedChatTurn` lines 70–87, body lines 182–237)
- Test: `pen-editor-backend/test/memory-chat-turn.test.ts`

**Interfaces**
- Produces:
```ts
export interface SystemPromptMemory {
  memoryGuidance?: boolean;   // include MEMORY_GUIDANCE (only when the tool is present)
  memorySnapshot?: string;    // rendered block; empty string = omit
}
export function buildSystemPrompt(
  canvasContext?: string,
  skills?: SkillCatalogEntry[],
  memory?: SystemPromptMemory,
): string;

export interface PrepareChatTurnInput {
  config: Config;
  messages: Array<Record<string, unknown>>;
  canvasContext?: string;
  modelOverride?: string;
  userId?: string;
  memoryStore?: MemoryStore | null;
}
export interface PreparedChatTurn {
  /* …existing fields unchanged… */
  memoryInjected: boolean;
}
```

**Steps**
- [ ] Write the failing test `test/memory-chat-turn.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { MEMORY_GUIDANCE } from "../src/ai/memory/prompts.js";
import type { MemoryStore } from "../src/ai/memory/store.js";
import type { MemorySnapshot } from "../src/ai/memory/types.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

function storeWith(snapshot: MemorySnapshot): MemoryStore {
  return {
    loadSnapshot: vi.fn(async () => snapshot),
    applyOperations: vi.fn(),
    bumpCounters: vi.fn(),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("prepareChatTurn — memory injection", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("injects the snapshot and the memory tool when enabled with a userId", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("make the header bigger")],
      userId: "u1",
      memoryStore: storeWith({ user: ["User prefers concise responses"], memory: [] }),
      canvasContext: "{}",
    });

    expect(turn.memoryInjected).toBe(true);
    expect(turn.tools.memory).toBeDefined();
    expect(turn.system).toContain(MEMORY_GUIDANCE);
    expect(turn.system).toContain("USER PROFILE (who the user is)");
    expect(turn.system).toContain("User prefers concise responses");
    // Order: guidance → skills catalog → snapshot → canvas context.
    expect(turn.system.indexOf(MEMORY_GUIDANCE)).toBeLessThan(
      turn.system.indexOf("## Available Skills"),
    );
    expect(turn.system.indexOf("## Available Skills")).toBeLessThan(
      turn.system.indexOf("USER PROFILE (who the user is)"),
    );
    expect(turn.system.indexOf("USER PROFILE (who the user is)")).toBeLessThan(
      turn.system.indexOf("## Current Canvas Context"),
    );
  });

  it("still injects the tool and guidance when the user has no entries yet", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: storeWith({ user: [], memory: [] }),
    });
    expect(turn.memoryInjected).toBe(true);
    expect(turn.tools.memory).toBeDefined();
    expect(turn.system).toContain(MEMORY_GUIDANCE);
    expect(turn.system).not.toContain("USER PROFILE (who the user is)");
  });

  it("stays off without a userId (the showcase runner path)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = storeWith({ user: ["x"], memory: [] });
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      memoryStore: store,
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
    expect(turn.system).not.toContain(MEMORY_GUIDANCE);
    expect(store.loadSnapshot).not.toHaveBeenCalled();
  });

  it("stays off when MEMORY_ENABLED is false", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig(),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: storeWith({ user: ["x"], memory: [] }),
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
  });

  it("degrades to a normal turn when the snapshot read throws", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = {
      loadSnapshot: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as MemoryStore;
    const turn = await prepareChatTurn({
      config: makeConfig({ MEMORY_ENABLED: true }),
      messages: [userMessage("hi")],
      userId: "u1",
      memoryStore: store,
    });
    expect(turn.memoryInjected).toBe(false);
    expect(turn.tools.memory).toBeUndefined();
    expect(turn.system.length).toBeGreaterThan(0);
  });
});
```

- [ ] Run `npm test -- test/memory-chat-turn.test.ts` — expect failure (`memoryInjected` undefined).
- [ ] In `src/ai/system-prompt.ts`, add the import at the top and replace `buildSystemPrompt` (lines 9–24):

```ts
import { MEMORY_GUIDANCE } from "./memory/prompts.js";

export interface SystemPromptMemory {
  /** Include MEMORY_GUIDANCE — only ever true when the memory tool is
   * actually in the tool set for this turn. Guidance without the tool is an
   * instruction the model cannot follow. */
  memoryGuidance?: boolean;
  /** Pre-rendered snapshot block (see ai/memory/render.ts). Empty = omit. */
  memorySnapshot?: string;
}

export function buildSystemPrompt(
  canvasContext?: string,
  skills: SkillCatalogEntry[] = [],
  memory: SystemPromptMemory = {},
): string {
  const parts: string[] = [CORE_PROMPT];

  // Stable tier: sits directly after the core prompt so the cached prefix
  // grows by a fixed block, while the per-user snapshot below stays near the
  // varying tail alongside the canvas context.
  if (memory.memoryGuidance) {
    parts.push(`\n## Persistent Memory\n\n${MEMORY_GUIDANCE}`);
  }

  if (skills.length > 0) {
    parts.push(renderSkillCatalog(skills));
  }

  if (memory.memorySnapshot) {
    parts.push(`\n${memory.memorySnapshot}`);
  }

  if (canvasContext) {
    parts.push(`\n## Current Canvas Context\n\n${canvasContext}`);
  }

  return parts.join("\n");
}
```

- [ ] In `src/ai/chatTurn.ts`, add imports after the existing `./skills.js` import block:

```ts
import { renderMemorySnapshot } from "./memory/render.js";
import { createMemoryToolContext, getMemoryTools } from "./memory/tool.js";
import type { MemoryStore } from "./memory/store.js";
```

- [ ] Extend the interfaces (lines 70–87):

```ts
export interface PrepareChatTurnInput {
  config: Config;
  messages: Array<Record<string, unknown>>;
  canvasContext?: string;
  modelOverride?: string;
  /** Client-generated stable anonymous id. Absent → memory is disabled for
   * this turn (the showcase runner and every headless entry point). */
  userId?: string;
  memoryStore?: MemoryStore | null;
}
```
and add to `PreparedChatTurn`:
```ts
  /** True when both the snapshot and the `memory` tool were added to this
   * turn — the review runner uses it to decide whether a review is possible
   * at all. */
  memoryInjected: boolean;
```

- [ ] In the body, replace the `const model = createModel(...)` → `const system = buildSystemPrompt(...)` section (lines 182–187) with:

```ts
  const model = createModel(config, modelOverride);
  const skillCatalog = getAllSkills().map((s) => ({
    name: s.name,
    description: s.description,
  }));

  // Memory is per-user and opt-in twice over: the kill switch AND a userId.
  // A snapshot read that fails must degrade to an ordinary turn rather than
  // failing the user's request — losing memory for one turn is recoverable,
  // losing the turn is not.
  const memoryStore = input.memoryStore ?? null;
  const memoryEligible = Boolean(config.MEMORY_ENABLED && input.userId && memoryStore);
  let memorySnapshotBlock = "";
  let memoryInjected = false;
  if (memoryEligible && memoryStore && input.userId) {
    try {
      memorySnapshotBlock = renderMemorySnapshot(await memoryStore.loadSnapshot(input.userId));
      memoryInjected = true;
    } catch (err) {
      console.error("[memory] snapshot read failed; continuing without memory:", err);
    }
  }

  const system = buildSystemPrompt(canvasContext, skillCatalog, {
    memoryGuidance: memoryInjected,
    memorySnapshot: memorySnapshotBlock,
  });
```

- [ ] In the tool-assembly block (lines 216–226), add the memory tool after `getSkillTools()`:

```ts
  const mcpTools = await getMCPTools(config);
  const tools = {
    ...penTools,
    ...getWebTools(config),
    ...mcpTools,
    ...getSkillTools(),
  } as ToolSet;
  if (memoryInjected && memoryStore && input.userId) {
    Object.assign(
      tools,
      getMemoryTools(createMemoryToolContext(memoryStore, input.userId, "foreground")),
    );
  }
```

- [ ] Add `memoryInjected,` to the returned object at the end of `prepareChatTurn`.
- [ ] Run `npm test -- test/memory-chat-turn.test.ts test/chat-turn.test.ts test/system-prompt.test.ts` — expect all green.
- [ ] Commit: `feat(memory): inject the snapshot, guidance and memory tool into the turn`

---

### Task 9: `userId` in the chat route + `MemoryStore` wiring in `buildApp`

**Files**
- Modify: `pen-editor-backend/src/routes/chat.ts` (`chatBodySchema` line 79, `chatRoutes` signature line 87, `prepareChatTurn` call line 138)
- Modify: `pen-editor-backend/src/app.ts` (`BuildAppOptions`, the `traceStore` block, the `chatRoutes` call)
- Test: `pen-editor-backend/test/memory-chat-route.test.ts`

**Interfaces**
- Produces:
```ts
export async function chatRoutes(
  app: FastifyInstance,
  config: Config,
  traceStore?: TraceStore | null,
  memoryStore?: MemoryStore | null,
): Promise<void>;

export interface BuildAppOptions {
  /* …existing… */
  // Test seam: `undefined` = create from config, `null` = explicitly disabled.
  memoryStore?: MemoryStore | null;
}
```

**Steps**
- [ ] Write the failing test `test/memory-chat-route.test.ts` (copy the mock/server harness style of `test/chat-route.test.ts`):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));
vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

const capturedPrompts: string[] = [];

function mockModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown }) => {
      capturedPrompts.push(JSON.stringify(options.prompt));
      return {
        stream: simulateReadableStream({ chunks: textStreamChunks("ok"), chunkDelayInMs: null }),
      };
    },
  });
}

function fakeMemoryStore(): MemoryStore & { loadSnapshot: ReturnType<typeof vi.fn> } {
  return {
    loadSnapshot: vi.fn(async () => ({ user: ["User prefers concise responses"], memory: [] })),
    applyOperations: vi.fn(),
    bumpCounters: vi.fn(async () => ({
      turnsSinceMemory: 1,
      stepsSinceSkill: 1,
      memoryReviewDue: false,
    })),
    writeAudit: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as MemoryStore & { loadSnapshot: ReturnType<typeof vi.fn> };
}

let app: FastifyInstance;
let url: string;
let store: ReturnType<typeof fakeMemoryStore>;

beforeAll(async () => {
  await loadSkills();
});

beforeEach(() => {
  holders.model = mockModel();
  capturedPrompts.length = 0;
});

async function start(memoryEnabled: boolean) {
  store = fakeMemoryStore();
  app = await buildApp(makeConfig({ MEMORY_ENABLED: memoryEnabled }), {
    logger: false,
    traceStore: null,
    showcaseStore: null,
    memoryStore: store,
  });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
}

afterAll(async () => {
  await app?.close();
});

async function postChat(body: unknown): Promise<string> {
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

describe("POST /api/chat — userId plumbing", () => {
  it("loads the caller's memory snapshot for a request carrying a userId", async () => {
    await start(true);
    await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      userId: "user-abc",
    });
    expect(store.loadSnapshot).toHaveBeenCalledWith("user-abc");
    await app.close();
  });

  it("works unchanged without a userId and never reads memory", async () => {
    await start(true);
    const body = await postChat({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    expect(body).toContain("data: [DONE]");
    expect(store.loadSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a userId over 64 characters with 400", async () => {
    await start(true);
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        userId: "x".repeat(65),
      }),
    });
    expect(res.status).toBe(400);
    await app.close();
  });
});
```

- [ ] Run `npm test -- test/memory-chat-route.test.ts` — expect failure (`loadSnapshot` never called / unknown option).
- [ ] In `src/routes/chat.ts`: add `import { createMemoryToolContext } from "../ai/memory/tool.js";` is **not** needed here; add only
```ts
import type { MemoryStore } from "../ai/memory/store.js";
```
- [ ] Extend `chatBodySchema` (line 79) with the locked field:

```ts
const chatBodySchema = z.object({
  id: z.string().max(200).optional(),
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
  // Client-generated stable anonymous id (localStorage `pen.userId`). Absent
  // → every memory feature is silently off for this request, which is what
  // keeps the showcase runner and any older client working untouched.
  userId: z.string().min(1).max(64).optional(),
});
```

- [ ] Change the `chatRoutes` signature and destructuring:

```ts
export async function chatRoutes(
  app: FastifyInstance,
  config: Config,
  traceStore: TraceStore | null = null,
  memoryStore: MemoryStore | null = null,
) {
```
and in the handler add `userId,` to the destructured `parsed.data`.

- [ ] Pass both through to `prepareChatTurn` (line 138) and capture `memoryInjected`:

```ts
    const {
      model,
      system,
      modelMessages,
      tools,
      taskPolicy,
      selectedModelId,
      systemPromptHash,
      memoryInjected,
    } = await prepareChatTurn({
      config,
      messages,
      canvasContext,
      modelOverride,
      userId,
      memoryStore,
    });
```
(`memoryInjected` is consumed by Task 10; add `void memoryInjected;` temporarily only if the `noUnusedLocals` build complains before Task 10 lands — otherwise land Tasks 9 and 10 back to back.)

- [ ] In `src/app.ts`: add
```ts
import { createMemoryStore, type MemoryStore } from "./ai/memory/store.js";
```
add to `BuildAppOptions`:
```ts
  // Test seam: inject a fake memory store. `undefined` = create from config,
  // `null` = explicitly disabled.
  memoryStore?: MemoryStore | null;
```
and replace the `await chatRoutes(app, config, traceStore);` line with:

```ts
  const memoryStore =
    options.memoryStore !== undefined
      ? options.memoryStore
      : createMemoryStore(config);
  if (memoryStore) {
    app.addHook("onClose", async () => {
      await memoryStore.close();
    });
  }
  await chatRoutes(app, config, traceStore, memoryStore);
```

- [ ] Run `npm test -- test/memory-chat-route.test.ts test/chat-route.test.ts test/chat-trace.test.ts` — expect green.
- [ ] Commit: `feat(chat): accept userId and wire the memory store into the route`

---

### Task 10: background memory review in `onFinish`

**Files**
- Create: `pen-editor-backend/src/ai/selfimprove/review.ts`
- Modify: `pen-editor-backend/src/routes/chat.ts` (`onFinish`, lines 206–241)
- Test: `pen-editor-backend/test/memory-review.test.ts`

**Interfaces**
- Consumes: `MemoryStore`, `MEMORY_REVIEW_INTERVAL` (Task 6); `createMemoryToolContext`/`getMemoryTools` (Task 7); `MEMORY_REVIEW_PROMPT` (Task 5); `createModel` from `../provider.js`; `logSession` from `../../logging.js`.
- Produces:
```ts
export interface MaybeRunReviewInput {
  config: Config;
  store: MemoryStore | null;
  userId: string | undefined;
  system: string;
  modelMessages: ModelMessage[];
  assistantText: string;
  stepCount: number;
  modelOverride?: string;
}
export type ReviewOutcome = "disabled" | "not-due" | "ran";
export async function maybeRunReview(input: MaybeRunReviewInput): Promise<ReviewOutcome>;
export function runReviewSafe(input: MaybeRunReviewInput): void;
```

**Steps**
- [ ] Write the failing test `test/memory-review.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { makeConfig } from "./helpers.js";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import type { MemoryStore } from "../src/ai/memory/store.js";

const holders = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const capturedCalls: Array<{ prompt: unknown; tools: unknown }> = [];

function reviewModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown; tools?: unknown }) => {
      capturedCalls.push({ prompt: options.prompt, tools: options.tools });
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) };
    },
  });
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function fakeStore(memoryReviewDue: boolean): MemoryStore {
  return {
    loadSnapshot: vi.fn(async () => ({ memory: [], user: [] })),
    applyOperations: vi.fn(async () => ({
      ok: true as const,
      entries: ["x"],
      usage: { current: 1, limit: 1375 },
    })),
    bumpCounters: vi.fn(async () => ({
      turnsSinceMemory: memoryReviewDue ? 10 : 1,
      stepsSinceSkill: 3,
      memoryReviewDue,
    })),
    writeAudit: vi.fn(),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

const MESSAGES: ModelMessage[] = [{ role: "user", content: "I only ever want short answers" }];

function input(overrides: Record<string, unknown> = {}) {
  return {
    config: makeConfig({ MEMORY_ENABLED: true }),
    store: fakeStore(true),
    userId: "u1",
    system: "SYSTEM PROMPT",
    modelMessages: MESSAGES,
    assistantText: "Understood.",
    stepCount: 3,
    ...overrides,
  };
}

describe("maybeRunReview", () => {
  it("does nothing without a userId, without a store, or with MEMORY_ENABLED off", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textChunks("Nothing to save."));

    expect(await maybeRunReview(input({ userId: undefined }))).toBe("disabled");
    expect(await maybeRunReview(input({ store: null }))).toBe("disabled");
    expect(
      await maybeRunReview(input({ config: makeConfig({ MEMORY_ENABLED: false }) })),
    ).toBe("disabled");
    expect(capturedCalls).toHaveLength(0);
  });

  it("bumps the counters but does not run the review before the threshold", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textChunks("Nothing to save."));
    const store = fakeStore(false);

    expect(await maybeRunReview(input({ store }))).toBe("not-due");
    expect(store.bumpCounters).toHaveBeenCalledWith({
      userId: "u1",
      turns: 1,
      steps: 3,
      memoryInterval: 10,
    });
    expect(capturedCalls).toHaveLength(0);
  });

  it("replays the conversation with the review prompt and only the memory tool", async () => {
    capturedCalls.length = 0;
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    holders.model = reviewModel(textChunks("Nothing to save."));

    expect(await maybeRunReview(input())).toBe("ran");
    expect(capturedCalls).toHaveLength(1);

    const prompt = capturedCalls[0].prompt as Array<{ role: string; content: unknown }>;
    expect(prompt[0].role).toBe("system");
    expect(JSON.stringify(prompt)).toContain("I only ever want short answers");
    expect(JSON.stringify(prompt)).toContain("Understood.");
    expect(JSON.stringify(prompt[prompt.length - 1])).toContain(MEMORY_REVIEW_PROMPT);

    const tools = capturedCalls[0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["memory"]);
  });

  it("swallows a review failure so it can never affect the user response", async () => {
    const { maybeRunReview } = await import("../src/ai/selfimprove/review.js");
    const store = {
      bumpCounters: vi.fn(async () => {
        throw new Error("db down");
      }),
    } as unknown as MemoryStore;
    await expect(maybeRunReview(input({ store }))).resolves.toBe("disabled");
  });
});
```

- [ ] Run `npm test -- test/memory-review.test.ts` — expect module-not-found failure.
- [ ] Create `src/ai/selfimprove/review.ts`:

```ts
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { Config } from "../../config.js";
import { logSession } from "../../logging.js";
import { createModel } from "../provider.js";
import { MEMORY_REVIEW_PROMPT } from "../memory/prompts.js";
import { MEMORY_REVIEW_INTERVAL, type MemoryStore } from "../memory/store.js";
import { createMemoryToolContext, getMemoryTools } from "../memory/tool.js";

const REVIEW_MAX_STEPS = 8;

export interface MaybeRunReviewInput {
  config: Config;
  store: MemoryStore | null;
  userId: string | undefined;
  /** The turn's exact system string — reused verbatim to keep the provider's
   * prefix cache warm for the review run. */
  system: string;
  modelMessages: ModelMessage[];
  /** The assistant text the user just received; appended so the review sees
   * the complete exchange, not just the request. */
  assistantText: string;
  stepCount: number;
  modelOverride?: string;
}

export type ReviewOutcome = "disabled" | "not-due" | "ran";

// Fire-and-forget from the chat route's onFinish. The user's response has
// already streamed by the time this runs, so every failure path here is a
// log line and nothing more.
//
// The review transcript is NEVER persisted into a user-visible session: a
// stored review prompt turns the agent into "the curator" on the next real
// turn (Hermes learned this the hard way). It also never triggers itself —
// this function is called from the chat route only.
export async function maybeRunReview(
  input: MaybeRunReviewInput,
): Promise<ReviewOutcome> {
  const { config, store, userId } = input;
  if (!config.MEMORY_ENABLED || !userId || !store) return "disabled";

  try {
    const counters = await store.bumpCounters({
      userId,
      turns: 1,
      steps: input.stepCount,
      memoryInterval: MEMORY_REVIEW_INTERVAL,
    });
    if (!counters.memoryReviewDue) return "not-due";

    const messages: ModelMessage[] = [...input.modelMessages];
    if (input.assistantText.trim()) {
      messages.push({ role: "assistant", content: input.assistantText });
    }
    messages.push({ role: "user", content: MEMORY_REVIEW_PROMPT });

    const ctx = createMemoryToolContext(store, userId, "background_review");
    const result = await generateText({
      model: createModel(config, input.modelOverride),
      system: input.system,
      messages,
      // Whitelist only: any other tool the model reaches for does not exist
      // in this run and is rejected by the SDK.
      tools: getMemoryTools(ctx) as ToolSet,
      stopWhen: stepCountIs(REVIEW_MAX_STEPS),
    });

    if (config.ENABLE_AGENT_LOGGING) {
      await logSession({
        sessionId: `memory-review-${Date.now()}`,
        timestamp: new Date().toISOString(),
        model: input.modelOverride ?? config.OPENROUTER_MODEL,
        systemPrompt: input.system,
        messages: messages as unknown[],
        steps: result.steps.map((step, i) => ({
          stepNumber: i,
          text: step.text,
          toolCalls: step.toolCalls.map((tc: Record<string, unknown>) => ({
            toolName: String(tc.toolName ?? ""),
            args: (tc.input ?? {}) as Record<string, unknown>,
          })),
          toolResults: step.toolResults.map((tr: Record<string, unknown>) => ({
            toolName: String(tr.toolName ?? ""),
            result: tr.output,
          })),
          finishReason: step.finishReason,
          usage: {
            inputTokens: step.usage.inputTokens ?? 0,
            outputTokens: step.usage.outputTokens ?? 0,
          },
        })),
        totalUsage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      }).catch((err) => console.error("[review] failed to write review log:", err));
    }

    return "ran";
  } catch (err) {
    console.error("[review] memory review failed:", err);
    return "disabled";
  }
}

/** Call site for onFinish: guards both a rejected promise and a synchronous
 * throw, exactly like writeRawTraceSafe. */
export function runReviewSafe(input: MaybeRunReviewInput): void {
  try {
    maybeRunReview(input).catch((err) => {
      console.error("[review] memory review failed:", err);
    });
  } catch (err) {
    console.error("[review] memory review failed:", err);
  }
}
```

- [ ] Run `npm test -- test/memory-review.test.ts` — expect pass.
- [ ] Wire it into `src/routes/chat.ts`. Add the import:
```ts
import { runReviewSafe } from "../ai/selfimprove/review.js";
```
and append to the `onFinish({ usage, steps })` body, after the `if (traceStore) { … }` block:

```ts
        // Fire-and-forget: the response has already streamed. Only ever runs
        // with MEMORY_ENABLED + a userId + a store — the showcase runner and
        // every headless entry point never reach it.
        if (memoryInjected && userId) {
          runReviewSafe({
            config,
            store: memoryStore,
            userId,
            system,
            modelMessages,
            assistantText: steps.map((s) => s.text).join("\n").trim(),
            stepCount: steps.length,
            modelOverride,
          });
        }
```

- [ ] Run the full backend suite: `npm test` — expect green.
- [ ] Commit: `feat(memory): background memory review after each finished turn`

---

### Task 11: `pen.userId` in the frontend (separate repo, separate commit)

**Files** (all paths in `/Users/daniilrozhkov/prj/pen-editor-app/pen-editor`)
- Create: `pen-editor/src/lib/userId.ts`
- Modify: `pen-editor/src/hooks/useDesignChat.ts` (`buildCanvasContext`, the return object at the end of the function)
- Test: `pen-editor/src/lib/__tests__/userId.test.ts`
- Test: `pen-editor/src/hooks/__tests__/useDesignChat.test.ts` (append one case to `describe("buildCanvasContext")`)

**Interfaces**
- Produces: `export function getUserId(): string;` — a UUID persisted at `localStorage["pen.userId"]`.
- Consumed by: `buildCanvasContext(sessionId?)`, whose return object gains `userId: string`; it is the `DefaultChatTransport` `body`, so the field lands in the `/api/chat` JSON body.

**Steps**
- [ ] Write the failing test `pen-editor/src/lib/__tests__/userId.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { getUserId } from "@/lib/userId";

describe("getUserId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates a uuid on first run and persists it", () => {
    const id = getUserId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(localStorage.getItem("pen.userId")).toBe(id);
  });

  it("returns the same id on every later call", () => {
    expect(getUserId()).toBe(getUserId());
  });

  it("reuses an id already in localStorage", () => {
    localStorage.setItem("pen.userId", "existing-id");
    expect(getUserId()).toBe("existing-id");
  });
});
```

- [ ] Append to `describe("buildCanvasContext")` in `pen-editor/src/hooks/__tests__/useDesignChat.test.ts`:

```ts
  it("carries a stable userId in the request body", () => {
    const first = (buildCanvasContext() as { userId: string }).userId;
    expect(first).toBeTruthy();
    expect((buildCanvasContext() as { userId: string }).userId).toBe(first);
    expect(localStorage.getItem("pen.userId")).toBe(first);
  });
```

- [ ] Run `npm test -- userId` in `pen-editor` — expect failure (module not found).
- [ ] Create `pen-editor/src/lib/userId.ts`:

```ts
// A stable, client-generated anonymous id. It is NOT auth: it exists only so
// the backend can scope the agent's persistent memory to one person's browser
// instead of sharing one memory store across every visitor. Sent as `userId`
// in the /api/chat body; the backend treats an absent id as "memory off".
const USER_ID_KEY = "pen.userId";

// Private-mode Safari and locked-down embeddings throw on localStorage. A
// per-process fallback keeps memory working for the life of the tab without
// ever handing two different browsers the same id (a constant like
// "anonymous" would merge their memories).
let fallbackId: string | undefined;

export function getUserId(): string {
  try {
    const existing = localStorage.getItem(USER_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, created);
    return created;
  } catch {
    fallbackId ??= crypto.randomUUID();
    return fallbackId;
  }
}
```

- [ ] In `pen-editor/src/hooks/useDesignChat.ts`, add the import next to the other `@/lib` imports:
```ts
import { getUserId } from "@/lib/userId";
```
and add one field to the object `buildCanvasContext` returns, after `model: resolveModel(model),`:
```ts
    userId: getUserId(),
```

- [ ] Run `npm test -- userId useDesignChat` in `pen-editor` — expect green.
- [ ] Run `npm run lint && npm run build` in `pen-editor`.
- [ ] Commit **in the `pen-editor` repo**: `feat(chat): send a stable anonymous userId with every chat request`

---

### Task 12: full verification + manual smoke

**Files**
- No source changes; this task only runs and records verification.

**Steps**
- [ ] `cd /Users/daniilrozhkov/prj/pen-editor-app/pen-editor-backend && npm test` — every test file runs (check the file count in the summary; `npm test -- run` would silently filter by name and look green, see `npm-test-run-footgun`).
- [ ] `npm run lint` in `pen-editor-backend` — 0 errors.
- [ ] `npm run build` in `pen-editor-backend` — clean `tsc`; confirm `dist/analysis/migrations/009_agent_memory.sql` exists afterwards (the build step copies the migrations directory).
- [ ] `cd ../pen-editor && npm test && npm run lint && npm run build` — green.
- [ ] Manual smoke — **memory written by a real model turn**:
  1. In `pen-editor-backend/.env` set `MEMORY_ENABLED=true`, a real `OPENROUTER_API_KEY`, and `TRACE_DATABASE_URL` pointing at the dev Postgres.
  2. `npm run dev` in `pen-editor-backend`; watch the startup log for `[startup] applied migrations: 009_agent_memory.sql` (first run only).
  3. `npm run dev` in `pen-editor`; open the editor at `/app` (not `/` — that is the showcase gallery).
  4. In the chat, send: `Запомни: я предпочитаю короткие ответы без вступлений.` The agent should call the `memory` tool once and reply without repeating the call.
  5. Verify the write:
     ```sql
     SELECT user_id, target, entries, updated_at FROM agent_memory ORDER BY updated_at DESC LIMIT 5;
     SELECT origin, subsystem, action, payload FROM agent_selfimprove_audit ORDER BY created_at DESC LIMIT 5;
     ```
     Expect one `agent_memory` row with `target = 'user'` whose `entries` contains a **declarative** fact (e.g. `User prefers concise responses without preamble`), and one audit row with `origin = 'foreground'`, `subsystem = 'memory'`, `action = 'add'`. The `user_id` must equal `localStorage.getItem("pen.userId")` in the browser console.
  6. Send a second, unrelated message (`Сделай заголовок крупнее`) and confirm in the DevTools Network tab that the `/api/chat` request body carries `userId`, and that the model's reply reflects the stored preference (short, no preamble).
  7. Counter + review: run
     ```sql
     SELECT * FROM agent_review_state;
     ```
     after each message — `turns_since_memory` increments by 1 per request and resets to 0 on the tenth, at which point a second `agent_selfimprove_audit` row may appear with `origin = 'background_review'` (only if the review found something worth saving; "Nothing to save." is a valid outcome and writes no row).
  8. Kill switch: set `MEMORY_ENABLED=false`, restart `npm run dev`, send a message — no `memory` tool in the turn, no new `agent_memory`/`agent_review_state` rows, chat otherwise unchanged.
  9. Backward compatibility: `npm run showcase:generate -- --dry-run=/tmp/showcase-smoke` still completes (no `userId` → no memory work, no new rows).
- [ ] Commit any doc touch-ups (e.g. a "Persistent memory" paragraph in `pen-editor-backend/CLAUDE.md` describing `MEMORY_ENABLED`, the three tables and the review interval): `docs: describe the phase-1 persistent memory loop`

---

## Self-review

**Spec coverage** — every locked interface in the spec's phase-1 scope is implemented: identity (Tasks 9, 11), the three tables verbatim (Task 2), `FOR UPDATE` read-modify-write with abort-on-failed-read (Task 6), char limits 2200/1375 on the `\n§\n`-joined form with a final-state-only budget check (Task 3), the snapshot render with the exact header/gauge format injected after the skills catalog and before `## Current Canvas Context` (Tasks 4, 8), the `memory` tool with `add`/`replace`/`remove` + atomic `operations`, unique-substring matching, no `read` action, terminal non-echoing success, over-capacity error carrying `current_entries` + usage, and the 3-failure circuit breaker (Task 7), `MEMORY_GUIDANCE` in the stable prompt tier only when the tool is present (Tasks 5, 8), `maybeRunReview` from `onFinish` with counters, `MEMORY_REVIEW_INTERVAL = 10`, whitelist tools, `stepCountIs(8)`, never persisted (Task 10), `MEMORY_ENABLED` kill switch checked in both places (Tasks 1, 8, 10), audit rows for every write from day one (Tasks 6, 7), `ENABLE_AGENT_LOGGING` dumping review transcripts (Task 10). Explicitly out of scope and absent: `agent_skills`, `skill_manage`, `SELF_SKILLS_ENABLED`, the curator CLI.

**Placeholder scan** — no "TBD", no "similar to Task N", no "add error handling": every code block above is complete enough to type in, including the failing tests and the exact commands.

**Type consistency** — `MemoryTarget`/`MemoryOperation`/`MemoryUsage`/`MemorySnapshot` are declared once in `src/ai/memory/types.ts` and imported everywhere else. `MemoryApplyOutcome` is produced by `applyMemoryOperations` (Task 3), returned unchanged by `MemoryStore.applyOperations` (Task 6), and consumed by the tool (Task 7). `AuditOrigin` is declared in `store.ts` and used by both the store and `createMemoryToolContext`. `MemoryStore` is the single store type threaded through `app.ts` → `chatRoutes` → `prepareChatTurn` → `maybeRunReview`. `PreparedChatTurn.memoryInjected: boolean` is produced in Task 8 and consumed in Tasks 9–10. `buildSystemPrompt`'s third parameter is optional, so every existing call site and test compiles unchanged.
