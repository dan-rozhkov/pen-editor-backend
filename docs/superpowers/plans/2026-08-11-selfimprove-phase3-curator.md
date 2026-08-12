# Self-Improvement Loop — Phase 3: Deterministic Skills Curator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**

Ship `npm run skills:curate` — a deterministic, LLM-free maintenance pass over the `agent_skills` table that ages unused learned skills `active → stale → archived`, so the system-prompt catalog stops growing forever. The run is read-only unless `--apply` is passed, it snapshots the whole table into `agent_selfimprove_audit` before touching anything, and it never deletes a row.

**Architecture**

`src/selfimprove/curate.ts` holds all of the logic as pure/injectable seams: flag parsing, classification of a snapshot of rows against an injected `now`, one transactional `curateSkills(client, {apply})` that reads `SELECT … FOR UPDATE`, writes the audit snapshot, then updates states, and a `formatCurateReport` that renders the stdout report. `src/selfimprove/curateRun.ts` is a wiring-only entrypoint in the exact shape of the showcase CLIs (`pinRun.ts`/`themeRun.ts`): parse flags → `openSelfImproveContext` (env + pool + migrations) → one call → print → close, guarded by the shared `runAsScript` tail. Tests run the real SQL against PGlite, so an illegal-but-parseable query cannot pass.

**Tech Stack**

- TypeScript 5.7, strict, ESM (`moduleResolution: NodeNext`)
- `pg` (shared pool from `src/tracing/traceStore.ts` → `createPgPool`), migrations via `src/analysis/migrate.ts`
- `zod` v3 for DB-row parsing
- Vitest + `@electric-sql/pglite` (real Postgres engine) for DB tests
- `tsx` for the CLI script entry

**Global Constraints**

- **Never DELETE.** The curator only ever `UPDATE`s `agent_skills.state`. No `DELETE`, no `TRUNCATE`, no row removal of any kind, in any code path.
- **`--apply` is required to mutate.** Default (no flag) is a dry run that writes nothing — not to the skills table, not to the audit table. This is deliberately inverted from the usual CLI default; the spec forbids mutate-by-default.
- **Snapshot before mutation.** Before the first `UPDATE` in an `--apply` run, the full `agent_skills` table is inserted into `agent_selfimprove_audit` as ONE row: `{origin: 'curator', subsystem: 'skill', action: 'snapshot', payload: <all rows>}`, inside the same transaction.
- **Thresholds 30/90 days.** `active` + unused ≥30 days (and created ≥30 days ago) → `stale`. `stale` + unused ≥90 days total → `archived`. No other thresholds, no config knob, no env var.
- **`.js` imports.** Every relative TypeScript import carries the `.js` extension (NodeNext + ESM).

**Depends on Phases 1-2 — exact consumed interfaces**

This plan consumes, and does not re-create, the following:

1. **`agent_skills` table** (phase 2 migration), DDL locked by the spec:
   `name text PK`, `description text`, `body text`, `created_by text`, `state text NOT NULL DEFAULT 'active'` (`'active'|'stale'|'archived'`), `use_count int NOT NULL DEFAULT 0`, `view_count int NOT NULL DEFAULT 0`, `last_used_at timestamptz` (nullable), `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`.
   The curator reads `name, state, use_count, last_used_at, created_at` (and snapshots `*`), and writes only `state` + `updated_at`.
2. **`agent_selfimprove_audit` table** (phase 1 migration): `id bigserial PK`, `user_id text NOT NULL`, `origin text NOT NULL`, `subsystem text NOT NULL`, `action text NOT NULL`, `payload jsonb NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. The curator inserts with `origin='curator'`, `subsystem='skill'`, `action='snapshot'`.
   `user_id` is `NOT NULL` and the curator is global (learned skills are not per-user, per spec) → it writes the sentinel `CURATOR_AUDIT_USER_ID = "system"`. There is no auth system; this is not and cannot collide with a real client-generated uuid.
3. **Phase-2 learned-skill store** (the module backing the system-prompt catalog and `load_skill` resolution). Phase 3 does not change it — Task 6 only *asserts* that its state filter excludes `'archived'`, and fixes it there if it does not.
4. **Migration runner** `migrate(client, dir?)` from `src/analysis/migrate.ts`, and the phase-1/phase-2 `.sql` files living in `src/analysis/migrations/`. Phase 3 adds **no migration of its own** — it needs no schema change.
5. **Shared script tail** `runAsScript(moduleUrl, tag, main)` from `src/showcase/cli.ts`. (Reused as-is across directories; moving it to a neutral `src/cli.ts` is a Deferred note, not this phase's work.)

**Locked design decisions (do not re-litigate mid-implementation)**

- **One transition per run, per skill.** Classification runs against a single snapshot read *before* any write, so an `active` skill unused for 200 days becomes `stale` in this run and `archived` only in a later run. Archiving is always preceded by at least one run's worth of stale grace. This is what makes the report honest (each line is one state change) and the pass rerunnable.
- **Classification happens in TS against an injected `now`**, not in SQL `now()`. The learned-skill table is tens of rows, the read is already a `FOR UPDATE` snapshot, and an injected clock is what makes the thresholds testable without sleeping or freezing the DB clock.
- **Day granularity.** `daysUnused` is `floor((now - COALESCE(last_used_at, created_at)) / 1 day)`; the boundary is `>= 30` / `>= 90`. Sub-second differences at the boundary are immaterial and deliberately not modelled.
- **`use_count` and `view_count` do not affect classification.** Recency is the only signal — a skill used 500 times but not in 90 days is dead weight in the catalog.

**Deferred (explicitly NOT in this phase)**

- **Pinning.** There is no `pinned` column in the spec DDL and this plan does not add one. If a skill must be exempt from aging, that needs a spec amendment + a phase-2 migration; do not invent schema here.
- LLM-driven consolidation (spec non-goal; Hermes' worst incident source).
- An `unarchive` / restore command, and a second audit row recording the transitions themselves (the snapshot plus the printed report is sufficient forensics for now).
- Scheduling (cron/Render job). The CLI is run by hand.

---

### Task 1: Extract a reusable PGlite harness

The showcase suite already boots PGlite and applies the real migrations, but its helper truncates showcase tables by name. Phase 3 needs the same boot with different tables. Generalize first so there is exactly one copy of the PGlite adapter.

**Files**

- `pen-editor-backend/test/pgliteHarness.ts` (new)
- `pen-editor-backend/test/pgliteShowcaseHelpers.ts` (rewired to delegate)

**Interfaces**

```ts
export interface PgliteHarness {
  db: TraceQueryable;
  reset(): Promise<void>;
  close(): Promise<void>;
}
export function createPgliteHarness(truncateTables: string[]): Promise<PgliteHarness>;
```

**Steps**

- [ ] Create `test/pgliteHarness.ts` with the generic harness (the adapter + migration copy logic moved verbatim out of `pgliteShowcaseHelpers.ts`):

```ts
// Real-Postgres-engine backing for DB tests. PGlite runs the actual Postgres
// planner/executor, so it catches queries that are syntactically fine but
// semantically illegal (an ambiguous column after a JOIN, a FOR UPDATE on a
// grouped read) — the class of bug a hand-written fake pool can never see.
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

// `001_init.sql` starts with `CREATE EXTENSION IF NOT EXISTS vector;` —
// pgvector is not one of the extensions PGlite ships, so that statement fails
// outright, and `002_insights.sql` only exists to add a table referencing
// `001`'s `session_summaries`. Nothing showcase- or selfimprove-related has an
// FK to either, so excluding these two by name — while applying every other
// migration file's exact, unmodified bytes — gets a real schema for what these
// suites exercise without hand-rolling a DDL substitute.
const SKIP_MIGRATIONS = new Set(["001_init.sql", "002_insights.sql"]);

// `migrate()` issues both plain multi-statement SQL (always `client.query(sql)`
// with no params) and parameterized single statements (always with a `params`
// array, even `[]`). PGlite's `query()` uses the extended protocol, which — like
// real Postgres — rejects multiple statements in one prepare; its `exec()` uses
// the simple protocol, which allows them but takes no params. Dispatching on
// "was `params` passed at all" reproduces `pg.Pool.query`'s behavior without
// forking any call site.
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

export interface PgliteHarness {
  db: TraceQueryable;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Boots a fresh in-memory PGlite instance and applies the real migrations
 * against it once. `reset()` clears the named tables between tests without
 * paying migration cost again. */
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

  const truncate = `TRUNCATE TABLE ${truncateTables.join(", ")} RESTART IDENTITY CASCADE`;

  return {
    db,
    async reset() {
      await pglite.exec(truncate);
    },
    async close() {
      await pglite.close();
    },
  };
}
```

- [ ] Replace the whole body of `test/pgliteShowcaseHelpers.ts` with a delegation:

```ts
// Showcase-specific view of the shared PGlite harness (see pgliteHarness.ts).
// Kept as its own module so `showcase-store-pglite.test.ts` keeps naming the
// tables it owns in exactly one place.
import { createPgliteHarness, type PgliteHarness } from "./pgliteHarness.js";

export type PgliteShowcaseHarness = PgliteHarness;

export function createPgliteShowcaseHarness(): Promise<PgliteShowcaseHarness> {
  return createPgliteHarness(["showcase_screens", "showcase_app_likes"]);
}
```

- [ ] Run the existing PGlite suite — it must stay green, unchanged:
  `cd pen-editor-backend && npx vitest run test/showcase-store-pglite.test.ts`
- [ ] Run lint: `cd pen-editor-backend && npm run lint`
- [ ] Commit: `git add test/pgliteHarness.ts test/pgliteShowcaseHelpers.ts && git commit -m "test: extract reusable PGlite harness"`

---

### Task 2: Classification logic (pure, TDD)

**Files**

- `pen-editor-backend/test/selfimprove-curate.test.ts` (new)
- `pen-editor-backend/src/selfimprove/curate.ts` (new)

**Interfaces**

```ts
export const SKILL_STATES: readonly ["active", "stale", "archived"];
export type SkillState = (typeof SKILL_STATES)[number];
export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;
export const CURATOR_AUDIT_USER_ID = "system";

export interface AgentSkillRow {
  name: string;
  state: SkillState;
  use_count: number;
  last_used_at: Date | null;
  created_at: Date;
}
export interface CurateTransition {
  name: string;
  from: SkillState;
  to: SkillState;
  daysUnused: number;
  useCount: number;
}

export function daysUnused(row: AgentSkillRow, now: Date): number;
export function classifySkills(rows: AgentSkillRow[], now: Date): CurateTransition[];
```

**Steps**

- [ ] Write the failing test file `test/selfimprove-curate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_AFTER_DAYS,
  STALE_AFTER_DAYS,
  classifySkills,
  daysUnused,
  type AgentSkillRow,
} from "../src/selfimprove/curate.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

function row(overrides: Partial<AgentSkillRow> & { name: string }): AgentSkillRow {
  return {
    state: "active",
    use_count: 0,
    last_used_at: null,
    created_at: daysAgo(200),
    ...overrides,
  };
}

describe("daysUnused", () => {
  it("counts from last_used_at when the skill has been used", () => {
    expect(daysUnused(row({ name: "a", last_used_at: daysAgo(12) }), NOW)).toBe(12);
  });

  it("falls back to created_at when the skill was never used", () => {
    expect(
      daysUnused(row({ name: "a", last_used_at: null, created_at: daysAgo(7) }), NOW),
    ).toBe(7);
  });
});

describe("classifySkills", () => {
  it("leaves a fresh, never-used skill alone", () => {
    const rows = [row({ name: "fresh", created_at: daysAgo(3) })];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("leaves an old skill alone while it is still being used", () => {
    const rows = [
      row({ name: "in-use", created_at: daysAgo(200), last_used_at: daysAgo(5) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("stales an active skill unused for 30+ days", () => {
    const rows = [
      row({ name: "rusty", created_at: daysAgo(80), last_used_at: daysAgo(31), use_count: 4 }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "rusty", from: "active", to: "stale", daysUnused: 31, useCount: 4 },
    ]);
  });

  it("stales an active never-used skill once it is 30+ days old", () => {
    const rows = [row({ name: "stillborn", created_at: daysAgo(31), last_used_at: null })];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "stillborn", from: "active", to: "stale", daysUnused: 31, useCount: 0 },
    ]);
  });

  it("does not stale a skill unused for fewer than 30 days", () => {
    const rows = [row({ name: "recent", created_at: daysAgo(90), last_used_at: daysAgo(29) })];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("takes only one step per run — a 200-day-idle active skill goes to stale, not archived", () => {
    const rows = [row({ name: "ancient", created_at: daysAgo(400), last_used_at: daysAgo(200) })];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "ancient", from: "active", to: "stale", daysUnused: 200, useCount: 0 },
    ]);
  });

  it("archives a stale skill unused for 90+ days", () => {
    const rows = [
      row({ name: "dead", state: "stale", created_at: daysAgo(400), last_used_at: daysAgo(91) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "dead", from: "stale", to: "archived", daysUnused: 91, useCount: 0 },
    ]);
  });

  it("archives a stale never-used skill 90+ days after creation", () => {
    const rows = [
      row({ name: "never", state: "stale", created_at: daysAgo(120), last_used_at: null }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "never", from: "stale", to: "archived", daysUnused: 120, useCount: 0 },
    ]);
  });

  it("keeps a stale skill stale below the 90-day mark", () => {
    const rows = [
      row({ name: "resting", state: "stale", created_at: daysAgo(200), last_used_at: daysAgo(45) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("ignores use_count entirely — popularity does not stop the clock", () => {
    const rows = [
      row({
        name: "once-loved",
        state: "stale",
        use_count: 500,
        created_at: daysAgo(400),
        last_used_at: daysAgo(120),
      }),
    ];
    expect(classifySkills(rows, NOW).map((t) => t.to)).toEqual(["archived"]);
  });

  it("never transitions an already archived skill", () => {
    const rows = [
      row({ name: "gone", state: "archived", created_at: daysAgo(900), last_used_at: daysAgo(800) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("classifies a mixed table in input order", () => {
    const rows = [
      row({ name: "fresh", created_at: daysAgo(2) }),
      row({ name: "rusty", created_at: daysAgo(80), last_used_at: daysAgo(45) }),
      row({ name: "dead", state: "stale", created_at: daysAgo(400), last_used_at: daysAgo(100) }),
    ];
    expect(classifySkills(rows, NOW).map((t) => [t.name, t.to])).toEqual([
      ["rusty", "stale"],
      ["dead", "archived"],
    ]);
  });

  it("pins the thresholds the spec locks", () => {
    expect(STALE_AFTER_DAYS).toBe(30);
    expect(ARCHIVE_AFTER_DAYS).toBe(90);
  });
});
```

- [ ] Run it and see it fail (module does not exist):
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Create `src/selfimprove/curate.ts` with the classification half:

```ts
import { z } from "zod";

// Deterministic skills curator (phase 3 of the self-improvement loop). No LLM
// is involved anywhere in this module by design — the spec's non-goals name
// LLM-driven consolidation as the upstream project's worst incident source.
//
// Ageing rule, from the spec's locked Curator section:
//   active, unused >= 30 days (and created >= 30 days ago) -> stale
//   stale,  unused >= 90 days total                        -> archived
// and archived rows are never deleted, only dropped from the catalog.
//
// Classification runs against a snapshot read taken BEFORE any write, so a
// skill takes at most one step per run: something idle for 200 days becomes
// stale now and archived on a later run. Archiving is always preceded by at
// least one run's worth of stale grace, and every report line is exactly one
// state change.

export const SKILL_STATES = ["active", "stale", "archived"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;

/** `agent_selfimprove_audit.user_id` is NOT NULL, but learned skills are
 * global (spec: "not per-user"), so a curator run belongs to no user. This
 * sentinel is not a client-generated uuid and cannot collide with one. */
export const CURATOR_AUDIT_USER_ID = "system";

const DAY_MS = 86_400_000;

/** The columns classification needs. Unknown keys are stripped, so the same
 * schema parses rows read with `SELECT *` (which is what the audit snapshot
 * stores). */
export const agentSkillRowSchema = z.object({
  name: z.string(),
  state: z.enum(SKILL_STATES),
  use_count: z.coerce.number().int(),
  last_used_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

export type AgentSkillRow = z.infer<typeof agentSkillRowSchema>;

export interface CurateTransition {
  name: string;
  from: SkillState;
  to: SkillState;
  daysUnused: number;
  useCount: number;
}

/** Whole days since the skill was last useful: its `last_used_at`, or its
 * `created_at` when it was never used at all. */
export function daysUnused(row: AgentSkillRow, now: Date): number {
  const since = (row.last_used_at ?? row.created_at).getTime();
  return Math.floor((now.getTime() - since) / DAY_MS);
}

export function classifySkills(rows: AgentSkillRow[], now: Date): CurateTransition[] {
  const transitions: CurateTransition[] = [];

  for (const row of rows) {
    const idle = daysUnused(row, now);
    const ageDays = Math.floor((now.getTime() - row.created_at.getTime()) / DAY_MS);

    if (row.state === "active") {
      // The `created_at` half of the condition is what keeps a skill created
      // yesterday out of the sweep: it has never been used, so its idle age is
      // its own age, and without this it would be born stale.
      if (idle >= STALE_AFTER_DAYS && ageDays >= STALE_AFTER_DAYS) {
        transitions.push({
          name: row.name,
          from: "active",
          to: "stale",
          daysUnused: idle,
          useCount: row.use_count,
        });
      }
      continue;
    }

    if (row.state === "stale" && idle >= ARCHIVE_AFTER_DAYS) {
      transitions.push({
        name: row.name,
        from: "stale",
        to: "archived",
        daysUnused: idle,
        useCount: row.use_count,
      });
    }
  }

  return transitions;
}
```

- [ ] Run the test again — all green:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Commit: `git add src/selfimprove/curate.ts test/selfimprove-curate.test.ts && git commit -m "feat(selfimprove): classify learned skills for curation"`

---

### Task 3: The stdout report

No silent success: a run that changes nothing must say so on its own line.

**Files**

- `pen-editor-backend/test/selfimprove-curate.test.ts` (append)
- `pen-editor-backend/src/selfimprove/curate.ts` (append)

**Interfaces**

```ts
export interface CurateResult {
  scanned: number;
  applied: boolean;
  transitions: CurateTransition[];
}
export function formatCurateReport(result: CurateResult): string;
```

**Steps**

- [ ] Append to `test/selfimprove-curate.test.ts`:

```ts
import { formatCurateReport, type CurateResult } from "../src/selfimprove/curate.js";

function result(overrides: Partial<CurateResult> = {}): CurateResult {
  return { scanned: 0, applied: false, transitions: [], ...overrides };
}

describe("formatCurateReport", () => {
  it("says 0 transitions explicitly when nothing qualifies", () => {
    const text = formatCurateReport(result({ scanned: 12 }));
    expect(text).toContain("scanned 12");
    expect(text).toContain("0 transitions");
    expect(text).not.toContain("→");
  });

  it("names the dry run and how to make it write", () => {
    const text = formatCurateReport(result({ scanned: 3 }));
    expect(text).toContain("dry run");
    expect(text).toContain("--apply");
  });

  it("does not claim to be a dry run when applied", () => {
    const text = formatCurateReport(result({ scanned: 3, applied: true }));
    expect(text).not.toContain("dry run");
  });

  it("prints one line per skill with the transition and the idle days", () => {
    const text = formatCurateReport(
      result({
        scanned: 4,
        applied: true,
        transitions: [
          { name: "rusty", from: "active", to: "stale", daysUnused: 31, useCount: 4 },
          { name: "dead", from: "stale", to: "archived", daysUnused: 120, useCount: 0 },
        ],
      }),
    );
    const lines = text.split("\n");
    expect(lines.some((l) => l.includes("rusty") && l.includes("active → stale") && l.includes("31d"))).toBe(true);
    expect(lines.some((l) => l.includes("dead") && l.includes("stale → archived") && l.includes("120d"))).toBe(true);
  });

  it("totals the transitions by target state", () => {
    const text = formatCurateReport(
      result({
        scanned: 9,
        applied: true,
        transitions: [
          { name: "a", from: "active", to: "stale", daysUnused: 40, useCount: 1 },
          { name: "b", from: "active", to: "stale", daysUnused: 50, useCount: 2 },
          { name: "c", from: "stale", to: "archived", daysUnused: 95, useCount: 0 },
        ],
      }),
    );
    expect(text).toContain("3 transitions");
    expect(text).toContain("2 → stale");
    expect(text).toContain("1 → archived");
  });
});
```

- [ ] Run and see the new block fail:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Append to `src/selfimprove/curate.ts`:

```ts
export interface CurateResult {
  /** How many `agent_skills` rows the run looked at. */
  scanned: number;
  /** True when the run was allowed to write (`--apply`). */
  applied: boolean;
  transitions: CurateTransition[];
}

/** The whole stdout report. A run that changes nothing prints an explicit
 * "0 transitions" line — a curator that succeeds silently is indistinguishable
 * from a curator that is broken. */
export function formatCurateReport(result: CurateResult): string {
  const lines: string[] = [];
  const mode = result.applied ? "applying" : "dry run — pass --apply to write";
  lines.push(`[curate] scanned ${result.scanned} learned skill(s) (${mode})`);

  if (result.transitions.length === 0) {
    lines.push("[curate] 0 transitions — no skill qualifies for stale or archived");
    return lines.join("\n");
  }

  const width = Math.max(...result.transitions.map((t) => t.name.length));
  for (const t of result.transitions) {
    lines.push(
      `[curate] ${t.name.padEnd(width)}  ${t.from} → ${t.to}  ${t.daysUnused}d unused, used ${t.useCount}x`,
    );
  }

  const toStale = result.transitions.filter((t) => t.to === "stale").length;
  const toArchived = result.transitions.filter((t) => t.to === "archived").length;
  lines.push(
    `[curate] ${result.transitions.length} transitions: ${toStale} → stale, ${toArchived} → archived`,
  );
  if (!result.applied) {
    lines.push("[curate] nothing was written");
  }
  return lines.join("\n");
}
```

- [ ] Run and see green:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Commit: `git add -u && git commit -m "feat(selfimprove): curator report formatting"`

---

### Task 4: Flag parsing (`--apply` required to mutate)

**Files**

- `pen-editor-backend/test/selfimprove-curate.test.ts` (append)
- `pen-editor-backend/src/selfimprove/curate.ts` (append)

**Interfaces**

```ts
export interface CurateFlags { apply: boolean; }
export function parseCurateFlags(argv: string[]): CurateFlags;
```

**Steps**

- [ ] Append to `test/selfimprove-curate.test.ts`:

```ts
import { parseCurateFlags } from "../src/selfimprove/curate.js";

describe("parseCurateFlags", () => {
  it("defaults to a dry run with no flags at all", () => {
    expect(parseCurateFlags([])).toEqual({ apply: false });
  });

  it("mutates only when --apply is given", () => {
    expect(parseCurateFlags(["--apply"])).toEqual({ apply: true });
  });

  it("accepts --dry-run as an explicit spelling of the default", () => {
    expect(parseCurateFlags(["--dry-run"])).toEqual({ apply: false });
  });

  it("rejects --apply together with --dry-run", () => {
    expect(() => parseCurateFlags(["--apply", "--dry-run"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects unknown arguments instead of silently ignoring them", () => {
    expect(() => parseCurateFlags(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseCurateFlags(["--limit=5"])).toThrow(/unknown argument/);
  });
});
```

- [ ] Run and see the new block fail:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Append to `src/selfimprove/curate.ts`:

```ts
export interface CurateFlags {
  apply: boolean;
}

const KNOWN_FLAGS = new Set(["--apply", "--dry-run"]);

/** `npm run skills:curate` is read-only unless `--apply` is passed. That is
 * inverted from the usual CLI default on purpose (the spec forbids
 * mutate-by-default), and `--dry-run` is accepted purely so spelling the
 * default out loud is not an error. Unknown arguments throw rather than being
 * ignored: a typo'd flag that silently does something else is exactly the
 * failure mode this CLI cannot afford. */
export function parseCurateFlags(argv: string[]): CurateFlags {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  }
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return { apply };
}
```

- [ ] Run and see green:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate.test.ts`
- [ ] Commit: `git add -u && git commit -m "feat(selfimprove): curator flag parsing"`

---

### Task 5: `curateSkills` against real Postgres (PGlite)

**Files**

- `pen-editor-backend/test/selfimprove-curate-pglite.test.ts` (new)
- `pen-editor-backend/src/selfimprove/curate.ts` (append)

**Interfaces**

```ts
export interface CuratorClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface CurateOptions { apply: boolean; now?: Date; }
export function curateSkills(client: CuratorClient, options: CurateOptions): Promise<CurateResult>;
```

**Steps**

- [ ] Write the failing DB test `test/selfimprove-curate-pglite.test.ts`:

```ts
// The curator's SQL runs against a real Postgres engine here (PGlite), not a
// hand-written fake: `SELECT … FOR UPDATE`, `= ANY($1::text[])` and a jsonb
// snapshot insert are all things a JS interpreter of the query would happily
// accept while real Postgres rejects them.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteHarness.js";
import { curateSkills, type CuratorClient } from "../src/selfimprove/curate.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

let harness: PgliteHarness;
let client: CuratorClient;

interface SeedSkill {
  name: string;
  state?: string;
  useCount?: number;
  lastUsedAt?: string | null;
  createdAt?: string;
}

async function seed(skill: SeedSkill): Promise<void> {
  await client.query(
    `INSERT INTO agent_skills
       (name, description, body, created_by, state, use_count, last_used_at, created_at)
     VALUES ($1, $2, $3, 'agent', $4, $5, $6, $7)`,
    [
      skill.name,
      `desc for ${skill.name}`,
      `# ${skill.name}\n\nbody`,
      skill.state ?? "active",
      skill.useCount ?? 0,
      skill.lastUsedAt ?? null,
      skill.createdAt ?? daysAgo(365),
    ],
  );
}

async function statesByName(): Promise<Record<string, string>> {
  const { rows } = await client.query("SELECT name, state FROM agent_skills", []);
  const out: Record<string, string> = {};
  for (const row of rows as { name: string; state: string }[]) {
    out[row.name] = row.state;
  }
  return out;
}

async function auditRows(): Promise<
  { origin: string; subsystem: string; action: string; user_id: string; payload: unknown }[]
> {
  const { rows } = await client.query(
    "SELECT user_id, origin, subsystem, action, payload FROM agent_selfimprove_audit ORDER BY id",
    [],
  );
  return rows as {
    origin: string;
    subsystem: string;
    action: string;
    user_id: string;
    payload: unknown;
  }[];
}

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_skills", "agent_selfimprove_audit"]);
  client = harness.db as unknown as CuratorClient;
});

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness.close();
});

describe("curateSkills", () => {
  it("reports transitions but writes nothing without --apply", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    const result = await curateSkills(client, { apply: false, now: NOW });

    expect(result.scanned).toBe(3);
    expect(result.applied).toBe(false);
    expect(result.transitions.map((t) => [t.name, t.to])).toEqual([
      ["dead", "archived"],
      ["rusty", "stale"],
    ]);
    expect(await statesByName()).toEqual({ fresh: "active", rusty: "active", dead: "stale" });
    expect(await auditRows()).toEqual([]);
  });

  it("applies the transitions and leaves everything else alone with --apply", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });
    await seed({ name: "in-use", createdAt: daysAgo(200), lastUsedAt: daysAgo(1) });

    const result = await curateSkills(client, { apply: true, now: NOW });

    expect(result.applied).toBe(true);
    expect(await statesByName()).toEqual({
      fresh: "active",
      rusty: "stale",
      dead: "archived",
      "in-use": "active",
    });
  });

  it("writes exactly one pre-mutation snapshot row before touching any state", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    await curateSkills(client, { apply: true, now: NOW });

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].origin).toBe("curator");
    expect(audit[0].subsystem).toBe("skill");
    expect(audit[0].action).toBe("snapshot");
    expect(audit[0].user_id).toBe("system");

    // The snapshot must show the world BEFORE the update — that is the whole
    // point of taking it first. Post-mutation states here would mean the
    // snapshot is useless for recovery.
    const payload = audit[0].payload as { name: string; state: string }[];
    expect(payload).toHaveLength(2);
    const snapshotStates = Object.fromEntries(payload.map((r) => [r.name, r.state]));
    expect(snapshotStates).toEqual({ rusty: "active", dead: "stale" });
  });

  it("snapshots the full row, not just the classified columns", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });

    await curateSkills(client, { apply: true, now: NOW });

    const payload = (await auditRows())[0].payload as Record<string, unknown>[];
    expect(payload[0]).toMatchObject({
      name: "rusty",
      description: "desc for rusty",
      created_by: "agent",
    });
    expect(payload[0].body).toContain("# rusty");
  });

  it("writes no audit row when there is nothing to change", async () => {
    await seed({ name: "fresh", createdAt: daysAgo(2) });

    const result = await curateSkills(client, { apply: true, now: NOW });

    expect(result.transitions).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it("never deletes a row — archived skills stay in the table", async () => {
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });

    await curateSkills(client, { apply: true, now: NOW });

    const { rows } = await client.query("SELECT count(*)::int AS n FROM agent_skills", []);
    expect((rows as { n: number }[])[0].n).toBe(1);
    expect(await statesByName()).toEqual({ dead: "archived" });
  });

  it("takes one step per run: active → stale now, archived only on a later run", async () => {
    await seed({ name: "ancient", createdAt: daysAgo(500), lastUsedAt: daysAgo(300) });

    await curateSkills(client, { apply: true, now: NOW });
    expect(await statesByName()).toEqual({ ancient: "stale" });

    await curateSkills(client, { apply: true, now: NOW });
    expect(await statesByName()).toEqual({ ancient: "archived" });

    // Third run has nothing left to do, and does not touch the audit log again.
    const third = await curateSkills(client, { apply: true, now: NOW });
    expect(third.transitions).toEqual([]);
    expect(await auditRows()).toHaveLength(2);
  });

  it("bumps updated_at only on the rows it transitions", async () => {
    await seed({ name: "rusty", createdAt: daysAgo(200), lastUsedAt: daysAgo(45) });
    await seed({ name: "fresh", createdAt: daysAgo(2) });
    await client.query("UPDATE agent_skills SET updated_at = $1", [daysAgo(200)]);

    await curateSkills(client, { apply: true, now: NOW });

    const { rows } = await client.query(
      "SELECT name, updated_at FROM agent_skills ORDER BY name",
      [],
    );
    const byName = Object.fromEntries(
      (rows as { name: string; updated_at: Date | string }[]).map((r) => [
        r.name,
        new Date(r.updated_at).getTime(),
      ]),
    );
    const oldMark = new Date(daysAgo(200)).getTime();
    expect(byName.fresh).toBe(oldMark);
    expect(byName.rusty).toBeGreaterThan(oldMark);
  });
});
```

- [ ] Run and see it fail (`curateSkills` is not exported yet):
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate-pglite.test.ts`
- [ ] Append to `src/selfimprove/curate.ts`:

```ts
/** Just enough of `pg.PoolClient` / the PGlite test adapter to run the
 * curator. It must be a single *connection*, not a pool: the whole run is one
 * transaction, and a pool would scatter BEGIN/UPDATE/COMMIT across clients. */
export interface CuratorClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface CurateOptions {
  /** False (the default for the CLI) makes the whole run read-only. */
  apply: boolean;
  /** Injected clock; defaults to wall time. Tests pin it. */
  now?: Date;
}

/** One curation pass. Reads the whole table under `FOR UPDATE`, classifies it
 * in memory, and — only with `apply` — writes the pre-mutation snapshot and
 * then the state updates, all inside a single transaction.
 *
 * The read is `SELECT *` and the snapshot stores those raw rows: a snapshot
 * that only kept the columns the classifier looks at would not be a snapshot.
 * Classification parses the same rows through a schema that strips the rest.
 *
 * Reading the whole table is deliberate. Learned skills are tens of rows, not
 * millions, and doing the ageing arithmetic in TS against an injected clock is
 * what makes the thresholds testable without freezing the database clock. */
export async function curateSkills(
  client: CuratorClient,
  options: CurateOptions,
): Promise<CurateResult> {
  const now = options.now ?? new Date();

  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT * FROM agent_skills ORDER BY name FOR UPDATE`,
      [],
    );
    // A failed read must abort the write — never rewrite from a view you did
    // not actually read (the spec's concurrency invariant). A parse error
    // throws here, before anything is written, and the catch below rolls back.
    const parsed = rows.map((row) => agentSkillRowSchema.parse(row));
    const transitions = classifySkills(parsed, now);

    if (options.apply && transitions.length > 0) {
      await client.query(
        `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
         VALUES ($1, 'curator', 'skill', 'snapshot', $2::jsonb)`,
        [CURATOR_AUDIT_USER_ID, JSON.stringify(rows)],
      );

      for (const target of ["stale", "archived"] as const) {
        const names = transitions.filter((t) => t.to === target).map((t) => t.name);
        if (names.length === 0) continue;
        await client.query(
          `UPDATE agent_skills
              SET state = $1, updated_at = now()
            WHERE name = ANY($2::text[])`,
          [target, names],
        );
      }
    }

    await client.query("COMMIT");
    return { scanned: parsed.length, applied: options.apply, transitions };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
```

- [ ] Run and see green:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate-pglite.test.ts test/selfimprove-curate.test.ts`
- [ ] Commit: `git add -u && git add test/selfimprove-curate-pglite.test.ts && git commit -m "feat(selfimprove): transactional curator pass with pre-mutation snapshot"`

---

### Task 6: Assert archived skills leave the catalog and `load_skill`

Archiving is only meaningful if the catalog and `load_skill` stop seeing the row. Phase 2 owns that filter; phase 3 pins it with a test and fixes it if the filter turns out to cover only `'stale'`.

**Files**

- `pen-editor-backend/test/selfimprove-curate-pglite.test.ts` (append)
- phase-2's learned-skill store module (touch **only** if the filter is wrong)

**Interfaces (phase 2, consumed)**

The two phase-2 seams this test exercises:
- the query that feeds the system-prompt skills catalog (learned half), and
- the query that resolves a learned skill by name for `load_skill`.

**Steps**

- [ ] Read phase-2's landed code before writing the test: locate the module under `src/selfimprove/` (or `src/ai/`) that reads `agent_skills` for the catalog and for `load_skill`, and note the exact exported names and shapes. Grep is enough:
  `cd pen-editor-backend && grep -rn "agent_skills" src/ --include=*.ts`
- [ ] Adapt the import line and the two call names in the test below to what phase 2 actually exports. Everything else in the test stands as written — it asserts behavior, not naming.
- [ ] Append to `test/selfimprove-curate-pglite.test.ts` (import at the top of the file with the rest):

```ts
// Phase-2 seams — rename these two imports to match what phase 2 landed; the
// assertions below do not depend on the names.
import {
  listLearnedSkills,
  getLearnedSkill,
} from "../src/selfimprove/skillStore.js";

describe("archived skills disappear from the agent's view", () => {
  it("is excluded from the catalog listing while active and stale are not", async () => {
    await seed({ name: "alive", state: "active" });
    await seed({ name: "resting", state: "stale" });
    await seed({ name: "gone", state: "archived" });

    const catalog = await listLearnedSkills(client);

    expect(catalog.map((s) => s.name).sort()).toEqual(["alive", "resting"]);
  });

  it("is not resolvable by name (load_skill cannot load it)", async () => {
    await seed({ name: "gone", state: "archived" });
    await seed({ name: "alive", state: "active" });

    expect(await getLearnedSkill(client, "alive")).toBeTruthy();
    expect(await getLearnedSkill(client, "gone")).toBeFalsy();
  });

  it("is what a curator run actually produces end to end", async () => {
    await seed({ name: "dead", state: "stale", createdAt: daysAgo(400), lastUsedAt: daysAgo(100) });
    expect(await listLearnedSkills(client)).toHaveLength(1);

    await curateSkills(client, { apply: true, now: NOW });

    expect(await listLearnedSkills(client)).toEqual([]);
    expect(await getLearnedSkill(client, "dead")).toBeFalsy();
  });
});
```

- [ ] Run it:
  `cd pen-editor-backend && npx vitest run test/selfimprove-curate-pglite.test.ts`
- [ ] If it fails because phase 2 filters only `state = 'active'` — fine, adjust this test's first case to match phase 2's deliberate semantics (stale may or may not be catalogued; that is phase 2's call), but the **archived** assertions must pass unchanged.
- [ ] If it fails because phase 2 does not filter `state` at all, or filters in a way that lets `'archived'` through: fix the phase-2 query in place (add `AND state <> 'archived'` to both the catalog listing and the by-name resolution), rerun, and note the fix in the commit message.
- [ ] Run the full suite so a phase-2 edit cannot break phase-2's own tests:
  `cd pen-editor-backend && npm test`
- [ ] Commit: `git add -u && git commit -m "test(selfimprove): pin that archived skills leave the catalog and load_skill"`

---

### Task 7: The CLI entrypoint

**Files**

- `pen-editor-backend/src/selfimprove/context.ts` (new)
- `pen-editor-backend/src/selfimprove/curateRun.ts` (new)
- `pen-editor-backend/package.json` (scripts)
- `pen-editor-backend/vitest.config.ts` (coverage exclude)

**Interfaces**

```ts
export interface SelfImproveContext {
  config: Config;
  client: pg.PoolClient;
  close(): Promise<void>;
}
export function openSelfImproveContext(tag: string): Promise<SelfImproveContext>;
```

**Steps**

- [ ] Create `src/selfimprove/context.ts`:

```ts
import type pg from "pg";
import { loadConfig, type Config } from "../config.js";
import { createPgPool } from "../tracing/traceStore.js";
import { migrate } from "../analysis/migrate.js";

// Env + Postgres wiring for the self-improvement CLIs, mirroring
// src/showcase/context.ts. It hands back a single checked-out *client*, not the
// pool: every curator run is one transaction, and BEGIN/UPDATE/COMMIT scattered
// across pooled clients is a transaction that silently isn't one.
//
// Exits the process on missing configuration rather than throwing: this is a
// CLI, and the line naming the variable you forgot beats a stack trace.
export interface SelfImproveContext {
  config: Config;
  client: pg.PoolClient;
  close(): Promise<void>;
}

export async function openSelfImproveContext(tag: string): Promise<SelfImproveContext> {
  const config = loadConfig();

  if (!config.TRACE_DATABASE_URL) {
    console.error(`[${tag}] TRACE_DATABASE_URL is required`);
    process.exit(1);
  }

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const client = await pool.connect();

  const applied = await migrate(client);
  if (applied.length) {
    console.log(`[${tag}] applied migrations: ${applied.join(", ")}`);
  }

  return {
    config,
    client,
    async close() {
      client.release();
      await pool.end();
    },
  };
}
```

- [ ] Create `src/selfimprove/curateRun.ts`:

```ts
import { openSelfImproveContext } from "./context.js";
import {
  curateSkills,
  formatCurateReport,
  parseCurateFlags,
  type CurateFlags,
  type CuratorClient,
} from "./curate.js";
import { runAsScript } from "../showcase/cli.js";

// CLI entrypoint for `npm run skills:curate` — the deterministic phase-3
// curator. Wiring only: flags in, one call into curate.ts, report out. Same
// shape as the showcase entrypoints (pinRun.ts et al), including the
// runAsScript tail that keeps an import from connecting to Postgres.
//
// Read-only by default. `--apply` is what makes it write, and nothing else.
function parseOrExit(argv: string[]): CurateFlags {
  try {
    return parseCurateFlags(argv);
  } catch (err) {
    console.error(`[curate] ${(err as Error).message}`);
    console.error("[curate] usage: npm run skills:curate -- [--apply]");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const flags = parseOrExit(process.argv.slice(2));
  const ctx = await openSelfImproveContext("curate");
  try {
    const result = await curateSkills(ctx.client as unknown as CuratorClient, {
      apply: flags.apply,
    });
    console.log(formatCurateReport(result));
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "curate", main);
```

- [ ] If `tsc` accepts `ctx.client` directly as a `CuratorClient` (pg's `query` overload is structurally compatible), drop the `as unknown as` cast — prefer no cast. Verify with the build step below and keep whichever compiles clean.
- [ ] Add the script to `package.json`, next to the showcase entries:

```json
    "skills:curate": "tsx --env-file=.env src/selfimprove/curateRun.ts",
```

- [ ] Add the two wiring-only modules to the coverage exclude list in `vitest.config.ts`, alongside the showcase entrypoints (the coverage thresholds are a non-regression gate — never lower them to make this pass):

```ts
        // self-improvement curator entrypoint: flags in, context out, one call
        // into the tested module. Its logic (parseCurateFlags/classifySkills/
        // curateSkills/formatCurateReport in src/selfimprove/curate.ts) is
        // unit-tested, against real Postgres for the SQL half.
        "src/selfimprove/curateRun.ts",
        // the env + pool + migrate wiring that entrypoint uses: reads env,
        // connects, exits the process on missing config — same exemption as
        // src/showcase/context.ts.
        "src/selfimprove/context.ts",
```

- [ ] Type-check the whole thing: `cd pen-editor-backend && npm run build`
- [ ] Confirm the script guard works — importing the entrypoint must not connect:
  `cd pen-editor-backend && node -e "import('./dist/selfimprove/curateRun.js').then(() => console.log('imported without connecting'))"`
- [ ] Commit: `git add -u && git add src/selfimprove/context.ts src/selfimprove/curateRun.ts && git commit -m "feat(selfimprove): npm run skills:curate entrypoint"`

---

### Task 8: Final verification

**Steps**

- [ ] Full unit suite (check the *file count* in the summary — `npm test -- run` is a name filter, not a runner; do not use it):
  `cd pen-editor-backend && npm test`
- [ ] Coverage gate (thresholds must still pass without being lowered):
  `cd pen-editor-backend && npm run test:coverage`
- [ ] Lint: `cd pen-editor-backend && npm run lint`
- [ ] Build: `cd pen-editor-backend && npm run build`
- [ ] Duplication gate (the new `context.ts` resembles `src/showcase/context.ts`; if jscpd flags it, extract the shared env-check + migrate bootstrap into one helper rather than deleting the check):
  `cd pen-editor-backend && npm run check:dup`
- [ ] Manual smoke, against a scratch Postgres (or the dev database), step by step:
  - [ ] Seed one skill that must age and one that must not:

```sql
INSERT INTO agent_skills (name, description, body, created_by, state, use_count, last_used_at, created_at)
VALUES
  ('smoke-rusty', 'smoke test skill', '# smoke', 'agent', 'active', 3, now() - interval '45 days', now() - interval '200 days'),
  ('smoke-fresh', 'smoke test skill', '# smoke', 'agent', 'active', 1, now() - interval '1 day',   now() - interval '2 days');
```

  - [ ] Dry run: `cd pen-editor-backend && npm run skills:curate`
        Expect a `scanned N` line, a `smoke-rusty  active → stale  45d unused` line, a `1 transitions: 1 → stale, 0 → archived` line, and `nothing was written`. No `smoke-fresh` line.
  - [ ] Verify the dry run really wrote nothing:
        `SELECT name, state FROM agent_skills WHERE name LIKE 'smoke-%';` → both still `active`;
        `SELECT count(*) FROM agent_selfimprove_audit WHERE origin = 'curator';` → unchanged.
  - [ ] Apply: `cd pen-editor-backend && npm run skills:curate -- --apply`
  - [ ] Verify the state moved and nothing was deleted:
        `SELECT name, state FROM agent_skills WHERE name LIKE 'smoke-%';` → `smoke-rusty` = `stale`, `smoke-fresh` = `active`, two rows still present.
  - [ ] Verify the snapshot row, and that it captured the *pre*-mutation state:
        `SELECT origin, subsystem, action, user_id, jsonb_array_length(payload) FROM agent_selfimprove_audit ORDER BY id DESC LIMIT 1;` → `curator | skill | snapshot | system | <row count>`;
        `SELECT jsonb_path_query(payload, '$[*] ? (@.name == "smoke-rusty").state') FROM agent_selfimprove_audit ORDER BY id DESC LIMIT 1;` → `"active"`.
  - [ ] Verify catalog exclusion for real: archive the row by hand
        (`UPDATE agent_skills SET state='archived' WHERE name='smoke-rusty';`), start `npm run dev`, and confirm the skills catalog in the system prompt no longer lists it and `load_skill` cannot resolve it (a `/api/chat` request with `ENABLE_AGENT_LOGGING=true` shows the assembled prompt).
  - [ ] Clean up: `DELETE FROM agent_skills WHERE name LIKE 'smoke-%';` (the curator itself never deletes — this is the human doing it).
- [ ] Re-run `npm run skills:curate` on a table with nothing to do and confirm the explicit `0 transitions — no skill qualifies for stale or archived` line appears. Silence is a bug.

---

### Self-review

- [ ] **Spec coverage.** Walk the spec's Curator paragraph line by line against the implementation: CLI name `npm run skills:curate` ✓ entry `src/selfimprove/curateRun.ts` ✓ `runAsScript` pattern ✓ `active` unused ≥30d → `stale` ✓ `stale` unused ≥90d → `archived` ✓ archived dropped from catalog ✓ never DELETE ✓ prints a report ✓ mutating run requires `--apply` ✓ snapshot to `agent_selfimprove_audit` with `origin: 'curator'` before any mutation ✓.
- [ ] **No invented schema.** `git diff` must show zero new files under `src/analysis/migrations/` and no `ALTER TABLE` anywhere. In particular: no `pinned` column — the spec DDL has none and pinning stays in Deferred.
- [ ] **Placeholder scan.** `grep -rn "TODO\|FIXME\|XXX\|placeholder\|<your" src/selfimprove/ test/selfimprove-*.ts` returns nothing.
- [ ] **Type consistency.** `SkillState` is the single source for the three state strings; no bare `"active"` / `"stale"` / `"archived"` string literal appears in `src/selfimprove/curate.ts` outside `SKILL_STATES`, the classifier's own comparisons, and the two SQL literals. `CurateResult`/`CurateTransition` are used identically by `curateSkills` and `formatCurateReport` (no structurally-similar duplicate interface).
- [ ] **No LLM anywhere.** `grep -rn "generateText\|streamText\|createModel\|openrouter" src/selfimprove/curate.ts src/selfimprove/curateRun.ts src/selfimprove/context.ts` returns nothing — phase 3 is deterministic by definition.
- [ ] **Import hygiene.** Every relative import in the new files ends in `.js`; `npm run build` is the proof.
