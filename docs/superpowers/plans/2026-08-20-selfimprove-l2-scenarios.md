# L2 Scenario Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the self-improvement loop a layer of cross-session evidence — recurring scenarios mined offline from `session_insights` — so a background review decides "save or not" from confirmed repetition instead of a single conversation.

**Architecture:** A new table `agent_scenarios` is filled by the existing offline analysis run (`npm run analyze`) with one extra LLM pass over L1 insight atoms, deduplicated against existing rows by title-embedding cosine similarity. `maybeRunReview` gains a third due-source: an unresolved scenario at/above the confirmation threshold makes a review due and rides into the review's **user** message (never the system prompt) as evidence. A four-state machine with an offer counter guarantees a scenario is offered at most twice.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` extensions on relative imports), Fastify, Vercel AI SDK (`generateObject`/`generateText`), Postgres via `pg`, PGlite for SQL-level tests, Vitest, zod.

**Spec:** `docs/specs/2026-08-20-selfimprove-l2-scenarios-design.md`

## Global Constraints

- **Never put scenarios in the system prompt.** `maybeRunReview` reuses `input.system` verbatim to keep the provider prefix cache warm. Scenario text goes into the review's user message, exactly where the fresh memory snapshot already goes (`src/ai/selfimprove/review.ts`, `reviewPrompt = ${reviewPromptBase}\n\nCurrent memory contents…`).
- **Max 2 scenarios per review run** (`MAX_SCENARIOS_PER_REVIEW = 2`). Attribution of a save is by run, not by scenario; the cap is what makes it accurate enough.
- **`confirmations` counts distinct `session_id`s**, never atoms. Three complaints in one session are one confirmation.
- **A scenario is offered at most twice.** `offer_count` increments at offer time; a second offer that produced no write sets `rejected` forever.
- **No new LLM call in the `/api/chat` hot path.** Extraction runs only in `src/analysis/run.ts`.
- **No pgvector for this table.** PGlite (used by the SQL tests) cannot `CREATE EXTENSION vector` — `test/pgliteShowcaseHelpers.ts` skips `001_init.sql`/`002_insights.sql` for exactly this reason. Scenario embeddings are stored as `jsonb` (a plain `number[]`) and cosine similarity is computed in JS over a handful of rows. This is a storage-level deviation from the spec's `vector(768)` line; the spec has been amended to match.
- **Both new migrations must survive the PGlite harness**, which applies every migration except `001`/`002`. `013` therefore uses `ALTER TABLE IF EXISTS`, and `014` must not reference `session_summaries` or `raw_traces` with a foreign key.
- Backend ESM rule: every relative import ends in `.js`, even from `.ts`.
- Verification per task: `npm run lint`, `npm test`, `npm run build` from `/Users/daniilrozhkov/prj/pen-backend-l2`. **`npm test -- run` is a trap** — `run` is read as a filename filter and silently runs ~2 files. Use plain `npm test`.
- All work happens in the worktree `/Users/daniilrozhkov/prj/pen-backend-l2` (branch `selfimprove-l2-scenarios`). Never `git stash`/`git reset`; never touch files outside the worktree.

---

### Task 1: Schema — `raw_traces.user_id` and `agent_scenarios`

**Files:**
- Create: `src/analysis/migrations/013_trace_user_id.sql`
- Create: `src/analysis/migrations/014_agent_scenarios.sql`
- Test: `test/scenarios-migration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `agent_scenarios` (columns below) and the nullable `user_id` column on `raw_traces` / `session_summaries`, both relied on by every later task.

- [ ] **Step 1: Write the failing test**

`test/scenarios-migration.test.ts` (model it on `test/agent-skills-migration.test.ts`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness([]);
});
afterAll(async () => {
  await harness.close();
});

describe("014_agent_scenarios", () => {
  it("accepts a user-scoped row and rejects a scope/user_id mismatch", async () => {
    await harness.db.query(
      `INSERT INTO agent_scenarios (scope, user_id, kind, title, recipe, session_ids, embedding)
       VALUES ('user', 'u1', 'correction', 't', 'r', ARRAY['s1'], '[0.1,0.2]'::jsonb)`,
      [],
    );
    await expect(
      harness.db.query(
        `INSERT INTO agent_scenarios (scope, user_id, kind, title, recipe, session_ids)
         VALUES ('user', NULL, 'correction', 't', 'r', ARRAY['s1'])`,
        [],
      ),
    ).rejects.toThrow();
  });

  it("defaults a fresh row to open with one confirmation and no offers", async () => {
    const { rows } = await harness.db.query(
      `INSERT INTO agent_scenarios (scope, kind, title, recipe, session_ids)
       VALUES ('global', 'workflow', 't2', 'r2', ARRAY['s2'])
       RETURNING state, confirmations, offer_count`,
      [],
    );
    expect(rows[0]).toMatchObject({ state: "open", confirmations: 1, offer_count: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/scenarios-migration.test.ts`
Expected: FAIL — `relation "agent_scenarios" does not exist`.

- [ ] **Step 3: Write the migrations**

`src/analysis/migrations/013_trace_user_id.sql`:

```sql
-- L2 scenarios are per-user, but raw_traces only ever stored session_id.
-- Nullable on purpose: existing rows and sessions without a shape-valid
-- client userId stay NULL and roll up into scope='global' scenarios.
-- IF EXISTS: the PGlite test harness skips 001_init.sql (no pgvector), so
-- these tables are absent there and this migration must be a no-op, not a
-- hard failure.
ALTER TABLE IF EXISTS raw_traces        ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS session_summaries ADD COLUMN IF NOT EXISTS user_id TEXT;
```

`src/analysis/migrations/014_agent_scenarios.sql`:

```sql
-- L2 of the memory pyramid: a pattern confirmed by SEVERAL sessions, sitting
-- between L1 atoms (session_insights) and L3 (agent_memory / agent_skills).
-- Deliberately NOT a pgvector column: PGlite (test harness) has no vector
-- extension, the row count here is in the dozens, and cosine over a jsonb
-- number[] in JS is both cheap and unit-testable. No FK to session_summaries:
-- raw traces expire after TRACE_RAW_TTL_DAYS and a scenario must outlive its
-- evidence, holding session ids as plain text.
CREATE TABLE IF NOT EXISTS agent_scenarios (
  id             BIGSERIAL PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('user','global')),
  user_id        TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('correction','error','preference','workflow')),
  title          TEXT NOT NULL,
  recipe         TEXT NOT NULL,
  confirmations  INTEGER NOT NULL DEFAULT 1,
  session_ids    TEXT[] NOT NULL,
  embedding      JSONB,
  state          TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','offered','distilled','rejected')),
  offer_count    INTEGER NOT NULL DEFAULT 0,
  distilled_into JSONB,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  offered_at     TIMESTAMPTZ,
  CONSTRAINT agent_scenarios_user_scope
    CHECK ((scope = 'user') = (user_id IS NOT NULL))
);

-- The review's due-check: scope+user, then state, then the threshold.
CREATE INDEX IF NOT EXISTS agent_scenarios_due_idx
  ON agent_scenarios (scope, user_id, state, confirmations DESC);

-- The analysis run's dedup read: all live rows of one bucket.
CREATE INDEX IF NOT EXISTS agent_scenarios_bucket_idx
  ON agent_scenarios (scope, user_id, state);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/scenarios-migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/migrations/013_trace_user_id.sql src/analysis/migrations/014_agent_scenarios.sql test/scenarios-migration.test.ts
git commit -m "Add agent_scenarios table and trace user_id columns"
```

---

### Task 2: Carry `userId` from the chat route into traces and summaries

**Files:**
- Modify: `src/tracing/traceStore.ts` (`RawTraceRow` type + the INSERT)
- Modify: `src/routes/chat.ts` (`buildTraceRow`)
- Modify: `src/analysis/assemble.ts` (`RawTraceDbRow`, `AssembledSession`)
- Modify: `src/analysis/run.ts` (session_summaries INSERT)
- Test: `test/chat-trace.test.ts` (extend), `test/assemble.test.ts` (extend)

**Interfaces:**
- Consumes: `013_trace_user_id.sql` from Task 1.
- Produces: `RawTraceRow.userId?: string | null`, `RawTraceDbRow.user_id?: string | null`, `AssembledSession.userId: string | null` — Task 4 reads `session_summaries.user_id`.

- [ ] **Step 1: Write the failing tests**

In `test/assemble.test.ts` add:

```ts
it("takes user_id from the session's rows, null when absent", () => {
  const base = { model: "m", agent_mode: "edits", stream_error: null, input_tokens: 0, output_tokens: 0 };
  const withUser = assembleSession([
    { id: 1, session_id: "s", created_at: new Date(1), payload: { messages: [] }, user_id: "u1", ...base },
  ]);
  expect(withUser.userId).toBe("u1");
  const without = assembleSession([
    { id: 1, session_id: "s", created_at: new Date(1), payload: { messages: [] }, ...base },
  ]);
  expect(without.userId).toBeNull();
});
```

In `test/chat-trace.test.ts`, extend the existing captured-row assertion so the written row carries `userId` from the request body (the suite already posts a body and captures `writeRawTrace`'s argument — assert `row.userId === "<the posted userId>"`, and `null`/`undefined` when the body has none or an implausible one).

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/assemble.test.ts test/chat-trace.test.ts`
Expected: FAIL — `userId` is `undefined` on the assembled session / trace row.

- [ ] **Step 3: Implement**

`src/tracing/traceStore.ts` — add `userId?: string | null` to `RawTraceRow` and widen the INSERT:

```ts
      await db.query(
        `INSERT INTO raw_traces
           (session_id, user_id, model, agent_mode, payload, stream_error, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          row.sessionId,
          row.userId ?? null,
          row.model,
          row.agentMode,
          JSON.stringify(row.payload),
          row.streamError,
          row.inputTokens,
          row.outputTokens,
        ],
      );
```

`src/routes/chat.ts` — in `buildTraceRow`, next to `sessionId: traceSessionId`, add `userId: userId ?? null` (the already-validated `const userId` from `isPlausibleUserId`, so an implausible client value never lands in the trace).

`src/analysis/assemble.ts` — add `user_id?: string | null` to `RawTraceDbRow`, `userId: string | null` to `AssembledSession`, and in `assembleSession`'s return:

```ts
    // First non-null wins: one session is one client, and later rows of a
    // session can only lose the id (an older client tab), never change it.
    userId: sorted.find((r) => r.user_id)?.user_id ?? null,
```

`src/analysis/run.ts` — extend the `session_summaries` INSERT with the column and bind:

```ts
          `INSERT INTO session_summaries
             (session_id, user_id, user_goal, summary, outcome, tool_errors, frustration,
              model, agent_mode, step_count, embedding, pii_check_passed)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::vector,$12)
           ON CONFLICT (session_id) DO NOTHING`,
          [
            session_id,
            session.userId,
            summary.user_goal,
            /* …the remaining binds shift by one, unchanged in order… */
          ],
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/assemble.test.ts test/chat-trace.test.ts test/analysis-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm test && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/tracing/traceStore.ts src/routes/chat.ts src/analysis/assemble.ts src/analysis/run.ts test/assemble.test.ts test/chat-trace.test.ts
git commit -m "Carry the anonymous userId into raw traces and session summaries"
```

---

### Task 3: `src/analysis/scenarios.ts` — atoms, extraction, dedup (pure + mocked LLM)

**Files:**
- Create: `src/analysis/scenarios.ts`
- Test: `test/scenarios.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (types only).
- Produces, relied on by Task 4:
  - `type ScenarioKind = "correction" | "error" | "preference" | "workflow"`
  - `interface InsightRowForScenarios { session_id: string; user_id: string | null; errors: unknown[]; corrections: unknown[]; memory_requests: unknown[] }`
  - `interface ScenarioAtom { sessionId: string; kind: ScenarioKind; text: string }`
  - `interface ScenarioBucket { scope: "user" | "global"; userId: string | null; atoms: ScenarioAtom[] }`
  - `function bucketAtoms(rows: InsightRowForScenarios[]): ScenarioBucket[]`
  - `interface ExtractedScenario { kind: ScenarioKind; title: string; recipe: string; session_ids: string[] }`
  - `function extractScenarios(model: LanguageModel, atoms: ScenarioAtom[]): Promise<ExtractedScenario[]>`
  - `function cosine(a: number[], b: number[]): number`
  - `interface ExistingScenario { id: number; embedding: number[] | null; session_ids: string[] }`
  - `function findDuplicate(embedding: number[] | null, existing: ExistingScenario[], maxDistance?: number): ExistingScenario | null`
  - `function mergeSessionIds(existing: string[], incoming: string[]): string[]`
  - `const SCENARIO_DEDUP_MAX_DISTANCE = 0.15`
  - `const MIN_BUCKET_ATOMS = 2`

- [ ] **Step 1: Write the failing tests**

`test/scenarios.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  bucketAtoms, cosine, findDuplicate, mergeSessionIds, extractScenarios,
  SCENARIO_DEDUP_MAX_DISTANCE,
} from "../src/analysis/scenarios.js";

const row = (session_id: string, user_id: string | null, corrections: unknown[]) => ({
  session_id, user_id, errors: [], corrections, memory_requests: [],
});

describe("bucketAtoms", () => {
  it("splits by user and puts unattributed sessions in the global bucket", () => {
    const buckets = bucketAtoms([
      row("s1", "u1", [{ what_agent_did: "asked questions", what_user_wanted: "a draft", agent_complied: false }]),
      row("s2", "u1", [{ what_agent_did: "asked questions", what_user_wanted: "a draft", agent_complied: false }]),
      row("s3", null, [{ what_agent_did: "used stock photos", what_user_wanted: "generated art", agent_complied: true }]),
    ]);
    expect(buckets.map((b) => [b.scope, b.userId, b.atoms.length])).toEqual([
      ["user", "u1", 2],
      ["global", null, 1],
    ]);
  });

  it("drops a bucket that cannot show repetition (single atom, single session)", () => {
    const buckets = bucketAtoms([row("s1", "u9", [{ what_agent_did: "a", what_user_wanted: "b", agent_complied: true }])]);
    expect(buckets.find((b) => b.userId === "u9")).toBeUndefined();
  });
});

describe("cosine", () => {
  it("is 1 for identical and 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("returns 0 for a zero vector instead of NaN", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe("findDuplicate", () => {
  const existing = [{ id: 7, embedding: [1, 0], session_ids: ["s1"] }];
  it("matches a near-identical title embedding", () => {
    expect(findDuplicate([0.99, 0.01], existing)?.id).toBe(7);
  });
  it("does not match a distant one", () => {
    expect(findDuplicate([0, 1], existing)).toBeNull();
  });
  it("never matches when the candidate has no embedding", () => {
    expect(findDuplicate(null, existing)).toBeNull();
  });
  it("uses the documented distance threshold", () => {
    expect(SCENARIO_DEDUP_MAX_DISTANCE).toBe(0.15);
  });
});

describe("mergeSessionIds", () => {
  it("unions without duplicates and keeps order stable", () => {
    expect(mergeSessionIds(["s1", "s2"], ["s2", "s3"])).toEqual(["s1", "s2", "s3"]);
  });
});

describe("extractScenarios", () => {
  it("returns only scenarios whose session_ids exist among the atoms", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        content: [{ type: "text", text: JSON.stringify({ scenarios: [
          { kind: "correction", title: "starts with questions", recipe: "show a draft first", session_ids: ["s1", "s2"] },
          { kind: "workflow", title: "hallucinated session", recipe: "x", session_ids: ["nope"] },
        ] }) }],
        warnings: [],
      }),
    });
    const out = await extractScenarios(model, [
      { sessionId: "s1", kind: "correction", text: "a" },
      { sessionId: "s2", kind: "correction", text: "b" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].session_ids).toEqual(["s1", "s2"]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/scenarios.test.ts`
Expected: FAIL — module `src/analysis/scenarios.js` not found.

- [ ] **Step 3: Implement `src/analysis/scenarios.ts`**

```ts
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { scrubPii } from "./pii.js";

export type ScenarioKind = "correction" | "error" | "preference" | "workflow";

/** One L1 fact, tagged with the session it came from — the unit of grouping.
 * Sessions are the unit of CONFIRMATION (see confirmationsOf), atoms are the
 * unit of evidence; conflating them is how one angry conversation would fake
 * a "recurring" pattern. */
export interface ScenarioAtom {
  sessionId: string;
  kind: ScenarioKind;
  text: string;
}

export interface InsightRowForScenarios {
  session_id: string;
  user_id: string | null;
  errors: Array<{ tool?: string; error?: string; recovered?: boolean }>;
  corrections: Array<{ what_agent_did?: string; what_user_wanted?: string; agent_complied?: boolean }>;
  memory_requests: Array<{ quote?: string; honored?: boolean }>;
}

export interface ScenarioBucket {
  scope: "user" | "global";
  userId: string | null;
  atoms: ScenarioAtom[];
}

/** A bucket below this cannot show repetition, so it is not worth an LLM call. */
export const MIN_BUCKET_ATOMS = 2;

/** Cosine DISTANCE (1 - similarity) under which two titles are the same
 * scenario. Tuned conservatively: a false merge silently inflates
 * confirmations, which is the one number the whole trigger rests on. */
export const SCENARIO_DEDUP_MAX_DISTANCE = 0.15;

function atomsOf(row: InsightRowForScenarios): ScenarioAtom[] {
  const atoms: ScenarioAtom[] = [];
  for (const e of row.errors ?? []) {
    if (e.recovered) continue; // a recovered error taught the agent nothing new
    atoms.push({ sessionId: row.session_id, kind: "error", text: `tool ${e.tool}: ${e.error}` });
  }
  for (const c of row.corrections ?? []) {
    atoms.push({
      sessionId: row.session_id,
      kind: "correction",
      text: `agent did: ${c.what_agent_did} / user wanted: ${c.what_user_wanted}`,
    });
  }
  for (const m of row.memory_requests ?? []) {
    atoms.push({ sessionId: row.session_id, kind: "preference", text: m.quote ?? "" });
  }
  return atoms.filter((a) => a.text.trim().length > 0);
}

/** Groups atoms per user, with every unattributed session rolled into one
 * global bucket. Buckets that cannot possibly show repetition are dropped
 * before any LLM call: fewer than MIN_BUCKET_ATOMS atoms, or every atom from
 * the same single session. */
export function bucketAtoms(rows: InsightRowForScenarios[]): ScenarioBucket[] {
  const byUser = new Map<string, ScenarioAtom[]>();
  const global: ScenarioAtom[] = [];
  for (const row of rows) {
    const atoms = atomsOf(row);
    if (atoms.length === 0) continue;
    if (row.user_id) {
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), ...atoms]);
    } else {
      global.push(...atoms);
    }
  }
  const viable = (atoms: ScenarioAtom[]): boolean =>
    atoms.length >= MIN_BUCKET_ATOMS && new Set(atoms.map((a) => a.sessionId)).size >= 2;

  const buckets: ScenarioBucket[] = [];
  for (const [userId, atoms] of byUser) {
    if (viable(atoms)) buckets.push({ scope: "user", userId, atoms });
  }
  if (viable(global)) buckets.push({ scope: "global", userId: null, atoms: global });
  return buckets;
}

const extractionSchema = z.object({
  scenarios: z.array(
    z.object({
      kind: z.enum(["correction", "error", "preference", "workflow"]),
      title: z.string().describe("One line: what recurs. No quotes, no names."),
      recipe: z.string().describe("2-4 lines: what the agent should do instead."),
      session_ids: z.array(z.string()).describe("Ids of the sessions this was observed in"),
    }),
  ),
});

export interface ExtractedScenario {
  kind: ScenarioKind;
  title: string;
  recipe: string;
  session_ids: string[];
}

const EXTRACTION_SYSTEM = `You read facts extracted from past sessions of an AI design agent and name the patterns that RECUR across DIFFERENT sessions.

Rules:
- Only report a pattern observed in at least two different session ids. One session is an anecdote, not a scenario.
- Prefer patterns that are ACTIONABLE for the agent itself (a habit to change, a step to always take) over topical groupings.
- 'title' is one line, no verbatim user quotes, no personal data.
- 'recipe' says what to do differently, in the imperative, 2-4 lines.
- 'session_ids' must be ids present in the input. Never invent one.
- Return an empty array rather than inventing a weak pattern.`;

/** One LLM pass per bucket. Anything the model invents (a session id not in
 * the input) is dropped here rather than trusted — the id set is the sole
 * evidence link back to L0/L1, so a hallucinated one would produce a
 * scenario nobody can drill down into. Free text is PII-scrubbed on the way
 * out, same rule the clustering pass follows. */
export async function extractScenarios(
  model: LanguageModel,
  atoms: ScenarioAtom[],
): Promise<ExtractedScenario[]> {
  const known = new Set(atoms.map((a) => a.sessionId));
  const prompt = atoms.map((a) => `[${a.sessionId}] (${a.kind}) ${a.text}`).join("\n");
  const { object } = await generateObject({
    model,
    schema: extractionSchema,
    system: EXTRACTION_SYSTEM,
    prompt,
  });
  return object.scenarios
    .map((s) => ({
      kind: s.kind as ScenarioKind,
      title: scrubPii(s.title),
      recipe: scrubPii(s.recipe),
      session_ids: [...new Set(s.session_ids.filter((id) => known.has(id)))],
    }))
    .filter((s) => s.session_ids.length >= 2 && s.title.trim() && s.recipe.trim());
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ExistingScenario {
  id: number;
  embedding: number[] | null;
  session_ids: string[];
}

/** The nearest existing row within the distance threshold, or null. Rows
 * without an embedding (embeddings disabled or the API failed that run) are
 * never merged into: a missing vector is unknown similarity, not zero. */
export function findDuplicate(
  embedding: number[] | null,
  existing: ExistingScenario[],
  maxDistance: number = SCENARIO_DEDUP_MAX_DISTANCE,
): ExistingScenario | null {
  if (!embedding) return null;
  let best: ExistingScenario | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of existing) {
    if (!row.embedding) continue;
    const distance = 1 - cosine(embedding, row.embedding);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return best && bestDistance <= maxDistance ? best : null;
}

export function mergeSessionIds(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

/** Confirmations are DISTINCT SESSIONS, never atoms — the invariant the
 * whole due-threshold rests on. */
export function confirmationsOf(sessionIds: string[]): number {
  return new Set(sessionIds).size;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/scenarios.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm test && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/analysis/scenarios.ts test/scenarios.test.ts
git commit -m "Add scenario extraction, bucketing and embedding dedup helpers"
```

---

### Task 4: Persist scenarios from the analysis run

**Files:**
- Create: `src/analysis/scenarioStore.ts`
- Modify: `src/analysis/run.ts` (new step 2b, after insight extraction, before clustering)
- Test: `test/scenario-store-pglite.test.ts`

**Interfaces:**
- Consumes: Task 1's table, Task 2's `session_summaries.user_id`, Task 3's `bucketAtoms`/`extractScenarios`/`findDuplicate`/`mergeSessionIds`/`confirmationsOf`.
- Produces:
  - `interface ScenarioStoreClient { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }`
  - `function loadLiveScenarios(db, scope, userId): Promise<ExistingScenario[]>`
  - `function upsertScenario(db, input: UpsertScenarioInput): Promise<"inserted" | "merged">`
  - `interface UpsertScenarioInput { scope: "user"|"global"; userId: string|null; kind: ScenarioKind; title: string; recipe: string; sessionIds: string[]; embedding: number[]|null }`

- [ ] **Step 1: Write the failing test**

`test/scenario-store-pglite.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { loadLiveScenarios, upsertScenario } from "../src/analysis/scenarioStore.js";

let harness: PgliteHarness;
beforeAll(async () => { harness = await createPgliteHarness(["agent_scenarios"]); });
afterEach(async () => { await harness.truncate(); });
afterAll(async () => { await harness.close(); });

const base = {
  scope: "user" as const, userId: "u1", kind: "correction" as const,
  title: "starts with questions", recipe: "show a draft first",
};

it("inserts a new scenario with confirmations = distinct sessions", async () => {
  const outcome = await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2", "s1"], embedding: [1, 0] });
  expect(outcome).toBe("inserted");
  const rows = await loadLiveScenarios(harness.db, "user", "u1");
  expect(rows).toHaveLength(1);
  const { rows: raw } = await harness.db.query("SELECT confirmations, state FROM agent_scenarios", []);
  expect(raw[0]).toMatchObject({ confirmations: 2, state: "open" });
});

it("merges a near-duplicate instead of inserting a second row", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  const outcome = await upsertScenario(harness.db, { ...base, title: "keeps asking questions", sessionIds: ["s2", "s3"], embedding: [0.99, 0.02] });
  expect(outcome).toBe("merged");
  const { rows } = await harness.db.query("SELECT confirmations, session_ids FROM agent_scenarios", []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ confirmations: 3 });
});

it("does not merge across buckets", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await upsertScenario(harness.db, { scope: "global", userId: null, kind: "correction", title: "same", recipe: "r", sessionIds: ["s4", "s5"], embedding: [1, 0] });
  const { rows } = await harness.db.query("SELECT id FROM agent_scenarios", []);
  expect(rows).toHaveLength(2);
});

it("never merges into a distilled or rejected row", async () => {
  await upsertScenario(harness.db, { ...base, sessionIds: ["s1", "s2"], embedding: [1, 0] });
  await harness.db.query("UPDATE agent_scenarios SET state = 'rejected'", []);
  const outcome = await upsertScenario(harness.db, { ...base, sessionIds: ["s3", "s4"], embedding: [1, 0] });
  expect(outcome).toBe("inserted");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/scenario-store-pglite.test.ts`
Expected: FAIL — `src/analysis/scenarioStore.js` not found.

- [ ] **Step 3: Implement `src/analysis/scenarioStore.ts`**

```ts
import {
  confirmationsOf, findDuplicate, mergeSessionIds,
  type ExistingScenario, type ScenarioKind,
} from "./scenarios.js";

export interface ScenarioStoreClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface UpsertScenarioInput {
  scope: "user" | "global";
  userId: string | null;
  kind: ScenarioKind;
  title: string;
  recipe: string;
  sessionIds: string[];
  embedding: number[] | null;
}

/** Rows still eligible to absorb a new observation: 'open' and 'offered'.
 * A 'distilled' row already became a memory entry or a skill, and a
 * 'rejected' one was declined twice — re-merging into either would
 * resurrect a decision the loop already made. */
export async function loadLiveScenarios(
  db: ScenarioStoreClient,
  scope: "user" | "global",
  userId: string | null,
): Promise<ExistingScenario[]> {
  const { rows } = await db.query(
    `SELECT id, embedding, session_ids FROM agent_scenarios
      WHERE scope = $1 AND user_id IS NOT DISTINCT FROM $2
        AND state IN ('open','offered')`,
    [scope, userId],
  );
  return (rows as Array<{ id: number; embedding: number[] | null; session_ids: string[] }>).map(
    (r) => ({ id: Number(r.id), embedding: r.embedding, session_ids: r.session_ids }),
  );
}

export async function upsertScenario(
  db: ScenarioStoreClient,
  input: UpsertScenarioInput,
): Promise<"inserted" | "merged"> {
  const live = await loadLiveScenarios(db, input.scope, input.userId);
  const duplicate = findDuplicate(input.embedding, live);
  if (duplicate) {
    const sessionIds = mergeSessionIds(duplicate.session_ids, input.sessionIds);
    await db.query(
      `UPDATE agent_scenarios
          SET session_ids = $2, confirmations = $3, last_seen_at = now()
        WHERE id = $1`,
      [duplicate.id, sessionIds, confirmationsOf(sessionIds)],
    );
    return "merged";
  }
  const sessionIds = [...new Set(input.sessionIds)];
  await db.query(
    `INSERT INTO agent_scenarios
       (scope, user_id, kind, title, recipe, confirmations, session_ids, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      input.scope,
      input.userId,
      input.kind,
      input.title,
      input.recipe,
      confirmationsOf(sessionIds),
      sessionIds,
      input.embedding ? JSON.stringify(input.embedding) : null,
    ],
  );
  return "inserted";
}
```

- [ ] **Step 4: Wire it into `src/analysis/run.ts`**

Add imports and a step between insight extraction (1b) and clustering (2), guarded by the config flag from Task 7:

```ts
    // 1c. Build the L2 scenario layer from the L1 atoms of the window. One
    // LLM call per bucket (a user, or the unattributed global pool), and
    // only for buckets that could possibly show repetition — see
    // bucketAtoms. Never runs in the chat path; this is the only writer.
    if (config.SCENARIOS_ENABLED) {
      const { rows: insightsForScenarios } = await pool.query<InsightRowForScenarios>(
        `SELECT si.session_id, ss.user_id, si.errors, si.corrections, si.memory_requests
           FROM session_insights si
           JOIN session_summaries ss ON ss.session_id = si.session_id
          WHERE ss.pii_check_passed
            AND ($1::int IS NULL OR ss.created_at > now() - make_interval(days => $1::int))`,
        [windowDays],
      );
      const buckets = bucketAtoms(insightsForScenarios);
      const considered = buckets.slice(0, MAX_SCENARIO_BUCKETS_PER_RUN);
      if (buckets.length > considered.length) {
        // Never truncate silently: a dropped bucket is a user whose patterns
        // simply did not get mined this run.
        console.log(
          `[analyze] ${buckets.length - considered.length} scenario bucket(s) skipped this run (cap ${MAX_SCENARIO_BUCKETS_PER_RUN})`,
        );
      }
      for (const bucket of considered) {
        try {
          const extracted = await extractScenarios(model, bucket.atoms);
          for (const scenario of extracted) {
            let embedding: number[] | null = null;
            if (embedder) {
              try {
                embedding = await embedder.embed(scenario.title);
              } catch (err) {
                console.warn("[analyze] scenario embedding failed:", err);
              }
            }
            const outcome = await upsertScenario(pool, {
              scope: bucket.scope,
              userId: bucket.userId,
              kind: scenario.kind,
              title: scenario.title,
              recipe: scenario.recipe,
              sessionIds: scenario.session_ids,
              embedding,
            });
            console.log(`[analyze] scenario ${outcome}: ${scenario.title}`);
          }
        } catch (err) {
          console.error(`[analyze] scenario extraction failed for ${bucket.scope}:`, err);
        }
      }
    }
```

Add near `EMBEDDING_DIMENSIONS`:

```ts
// One LLM call per bucket: bound a single run's cost on a deployment with
// many users. Skipped buckets are logged, never silently dropped.
const MAX_SCENARIO_BUCKETS_PER_RUN = 20;
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/scenario-store-pglite.test.ts test/analysis-run.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification**

Run: `npm run lint && npm test && npm run build`

- [ ] **Step 7: Commit**

```bash
git add src/analysis/scenarioStore.ts src/analysis/run.ts test/scenario-store-pglite.test.ts
git commit -m "Mine L2 scenarios in the analysis run"
```

---

### Task 5: `src/ai/selfimprove/scenarioFeed.ts` — read, render, settle

**Files:**
- Create: `src/ai/selfimprove/scenarioFeed.ts`
- Test: `test/scenario-feed.test.ts` (pure), `test/scenario-feed-pglite.test.ts` (SQL)

**Interfaces:**
- Consumes: Task 1's table.
- Produces, relied on by Task 6:
  - `const MAX_SCENARIOS_PER_REVIEW = 2`
  - `interface DueScenario { id: number; kind: string; title: string; recipe: string; confirmations: number; offerCount: number }`
  - `function fetchDueScenarios(db: TraceQueryable, userId: string, threshold: number): Promise<DueScenario[]>`
  - `function renderScenarioBlock(rows: DueScenario[]): string` (empty string for an empty list)
  - `function nextScenarioState(offerCount: number, wrote: boolean): "distilled" | "offered" | "rejected"`
  - `function markScenariosOffered(db, ids: number[]): Promise<void>`
  - `function settleScenarios(db, rows: DueScenario[], wrote: boolean): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/scenario-feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextScenarioState, renderScenarioBlock, MAX_SCENARIOS_PER_REVIEW } from "../src/ai/selfimprove/scenarioFeed.js";

describe("nextScenarioState", () => {
  it("distills whenever the run wrote something", () => {
    expect(nextScenarioState(1, true)).toBe("distilled");
    expect(nextScenarioState(2, true)).toBe("distilled");
  });
  it("keeps a first silent offer alive", () => {
    expect(nextScenarioState(1, false)).toBe("offered");
  });
  it("rejects for good on the second silent offer", () => {
    expect(nextScenarioState(2, false)).toBe("rejected");
    expect(nextScenarioState(3, false)).toBe("rejected");
  });
});

describe("renderScenarioBlock", () => {
  it("is empty for no scenarios", () => {
    expect(renderScenarioBlock([])).toBe("");
  });
  it("names the id, kind and confirmation count", () => {
    const block = renderScenarioBlock([
      { id: 12, kind: "correction", title: "starts with questions", recipe: "show a draft first", confirmations: 4, offerCount: 0 },
    ]);
    expect(block).toContain("S-12");
    expect(block).toContain("4 separate sessions");
    expect(block).toContain("show a draft first");
  });
  it("caps at two", () => {
    expect(MAX_SCENARIOS_PER_REVIEW).toBe(2);
  });
});
```

`test/scenario-feed-pglite.test.ts`: seed rows via SQL, then assert `fetchDueScenarios` (a) returns only `open`/`offered` rows at/above the threshold for that user plus global rows, (b) never returns `distilled`/`rejected`, (c) returns at most `MAX_SCENARIOS_PER_REVIEW`; and that `markScenariosOffered` increments `offer_count`, sets `state='offered'` and `offered_at`, while `settleScenarios(db, rows, true)` sets `distilled` and `settleScenarios(db, rows, false)` on rows with `offerCount: 2` sets `rejected`.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/scenario-feed.test.ts test/scenario-feed-pglite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/ai/selfimprove/scenarioFeed.ts`**

```ts
import type { TraceQueryable } from "../../tracing/traceStore.js";

/** Attribution of a save is per RUN, not per scenario (the review has no way
 * to say which one it acted on — see the spec's attribution table). Offering
 * at most two is what keeps that attribution honest. */
export const MAX_SCENARIOS_PER_REVIEW = 2;

export interface DueScenario {
  id: number;
  kind: string;
  title: string;
  recipe: string;
  confirmations: number;
  offerCount: number;
}

/** Scenarios this user should be shown: their own, plus the global pool that
 * unattributed sessions produced. Ordered by confirmations so the
 * best-evidenced pattern wins the two slots. */
export async function fetchDueScenarios(
  db: TraceQueryable,
  userId: string,
  threshold: number,
  limit: number = MAX_SCENARIOS_PER_REVIEW,
): Promise<DueScenario[]> {
  const { rows } = await db.query(
    `SELECT id, kind, title, recipe, confirmations, offer_count
       FROM agent_scenarios
      WHERE state IN ('open','offered')
        AND confirmations >= $2
        AND (scope = 'global' OR user_id = $1)
      ORDER BY confirmations DESC, id
      LIMIT $3`,
    [userId, threshold, limit],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    title: String(r.title),
    recipe: String(r.recipe),
    confirmations: Number(r.confirmations),
    offerCount: Number(r.offer_count),
  }));
}

/** Evidence, not instruction: the block states what recurred and how often,
 * and leaves the save/decline decision to the review prompt that precedes
 * it. Goes into the review's USER message — never the system prompt, which
 * is reused verbatim to keep the provider prefix cache warm. */
export function renderScenarioBlock(rows: DueScenario[]): string {
  if (rows.length === 0) return "";
  const items = rows.map(
    (r) => `[S-${r.id} · ${r.kind} · seen in ${r.confirmations} separate sessions]\n${r.title}\n→ ${r.recipe}`,
  );
  return [
    "Recurring patterns mined from this user's PAST sessions (evidence, not guesses — each was observed in several separate sessions):",
    ...items,
  ].join("\n\n");
}

/** The state machine's only decision point, kept pure so the anti-loop
 * invariant is testable without a database: a scenario is offered at most
 * twice, and a second silent offer retires it for good. `offerCount` is the
 * value AFTER markScenariosOffered incremented it. */
export function nextScenarioState(
  offerCount: number,
  wrote: boolean,
): "distilled" | "offered" | "rejected" {
  if (wrote) return "distilled";
  return offerCount >= 2 ? "rejected" : "offered";
}

export async function markScenariosOffered(db: TraceQueryable, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE agent_scenarios
        SET state = 'offered', offer_count = offer_count + 1, offered_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

export async function settleScenarios(
  db: TraceQueryable,
  rows: DueScenario[],
  wrote: boolean,
): Promise<void> {
  for (const row of rows) {
    // offerCount here is pre-increment (the row was read before the offer),
    // so add the offer that just happened.
    const state = nextScenarioState(row.offerCount + 1, wrote);
    if (state === "offered") continue; // already set by markScenariosOffered
    await db.query(
      `UPDATE agent_scenarios
          SET state = $2,
              distilled_into = CASE WHEN $2 = 'distilled' THEN $3::jsonb ELSE distilled_into END
        WHERE id = $1`,
      [row.id, state, JSON.stringify({ via: "background_review" })],
    );
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/scenario-feed.test.ts test/scenario-feed-pglite.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm test && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/ai/selfimprove/scenarioFeed.ts test/scenario-feed.test.ts test/scenario-feed-pglite.test.ts
git commit -m "Add the scenario feed the background review reads"
```

---

### Task 6: Wire scenarios into `maybeRunReview`

**Files:**
- Modify: `src/ai/selfimprove/review.ts`
- Test: `test/selfimprove-review-scenarios.test.ts`

**Interfaces:**
- Consumes: Task 5's `fetchDueScenarios`, `renderScenarioBlock`, `markScenariosOffered`, `settleScenarios`, `MAX_SCENARIOS_PER_REVIEW`; Task 7's `config.SCENARIOS_ENABLED` / `config.SCENARIO_CONFIRM_THRESHOLD`.
- Produces: `ReviewOutcome` unchanged; `agent_selfimprove_audit.payload.scenario_ids` on runs that were given scenarios.

- [ ] **Step 1: Write the failing test**

`test/selfimprove-review-scenarios.test.ts` (follow the existing review tests for how the model and stores are faked):

```ts
it("makes a review due on a confirmed scenario even with cold counters", async () => {
  // bumpCounters fake returns memoryReviewDue:false, skillReviewDue:false;
  // one scenario row is due. Expect maybeRunReview -> "ran".
});

it("puts the scenario block in the user message and never in the system prompt", async () => {
  // capture generateText's args via the mock model:
  expect(captured.system).not.toContain("S-12");
  const lastUser = captured.prompt.at(-1);
  expect(JSON.stringify(lastUser)).toContain("S-12");
});

it("distills the offered scenarios when the run wrote something", async () => {
  // model calls the `memory` tool -> settleScenarios(..., true) -> state 'distilled'
});

it("rejects a scenario the second time a review declines it", async () => {
  // seeded offer_count = 1, model writes nothing -> state 'rejected'
});

it("records the offered ids in the audit payload", async () => {
  expect(auditRows.at(-1)?.payload.scenario_ids).toEqual([12]);
});

it("offers at most MAX_SCENARIOS_PER_REVIEW", async () => {
  // three due rows seeded, fetch limit is 2
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/selfimprove-review-scenarios.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/ai/selfimprove/review.ts`**

After the existing `due` computation and BEFORE the `selectReviewPrompt` early return:

```ts
    // Third due-source: a pattern already confirmed by several past sessions.
    // Counters ask "has enough happened lately?"; this asks "is there
    // standing evidence worth acting on?" — the case a single-session review
    // structurally cannot see. Read-only and cheap (one indexed SELECT with
    // LIMIT 2), and only on a completed turn.
    let scenarios: DueScenario[] = [];
    if (config.SCENARIOS_ENABLED && input.auditDb) {
      try {
        scenarios = await fetchDueScenarios(
          input.auditDb,
          userId,
          config.SCENARIO_CONFIRM_THRESHOLD,
        );
      } catch (err) {
        // Evidence is an enhancement; losing it must never cost the user a
        // review that the counters had already earned.
        console.error("[review] failed to read due scenarios:", err);
      }
    }

    const reviewPromptBase = selectReviewPrompt(due, config.MEMORY_ENABLED);
    // A scenario alone can carry a review: fall back to the prompt for
    // whichever subsystem is enabled rather than inventing a fourth variant.
    const promptBase =
      reviewPromptBase ??
      (scenarios.length > 0
        ? selectReviewPrompt(
            { memoryDue: config.MEMORY_ENABLED, skillDue: config.SELF_SKILLS_ENABLED },
            config.MEMORY_ENABLED,
          )
        : null);
    if (!promptBase) return "not-due";
```

Then use `promptBase` where `reviewPromptBase` was used, and append the block after the memory snapshot block:

```ts
    const scenarioBlock = renderScenarioBlock(scenarios);
    if (scenarioBlock) reviewPrompt = `${reviewPrompt}\n\n${scenarioBlock}`;
```

Immediately before `generateText`, mark the offer (so a crash mid-run still counts as an offer and cannot loop forever):

```ts
    if (scenarios.length > 0 && input.auditDb) {
      try {
        await markScenariosOffered(input.auditDb, scenarios.map((s) => s.id));
      } catch (err) {
        console.error("[review] failed to mark scenarios offered:", err);
      }
    }
```

After `wrote` is computed, settle and extend the audit payload:

```ts
    if (scenarios.length > 0 && input.auditDb) {
      try {
        await settleScenarios(input.auditDb, scenarios, wrote);
      } catch (err) {
        console.error("[review] failed to settle scenarios:", err);
      }
    }
    await writeReviewAudit(store, userId, wrote ? "saved" : "nothing-saved", {
      memoryDue: due.memoryDue,
      skillDue: due.skillDue,
      // The metric the whole layer is judged by: saved-rate on runs WITH
      // evidence vs runs without. Empty array (not omitted) so both
      // populations are countable from one query.
      scenario_ids: scenarios.map((s) => s.id),
      steps: result.steps.length,
      toolsCalled: calledTools,
      finishReason: result.finishReason,
    });
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/selfimprove-review-scenarios.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm test && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/ai/selfimprove/review.ts test/selfimprove-review-scenarios.test.ts
git commit -m "Trigger and feed the background review from confirmed scenarios"
```

---

### Task 7: Config flags and the saved-rate metric

**Files:**
- Modify: `src/config.ts`
- Modify: `src/analysis/report.ts`
- Modify: `src/analysis/run.ts` (compute the metric, pass it to `renderReport`)
- Modify: `CLAUDE.md` (document the layer in the self-improvement section)
- Test: `test/config.test.ts` (extend), `test/report.test.ts` (extend)

**Interfaces:**
- Consumes: Task 6's `scenario_ids` audit payload.
- Produces: `config.SCENARIOS_ENABLED: boolean`, `config.SCENARIO_CONFIRM_THRESHOLD: number`, `ReportInput.scenarioMetric?: { withScenarios: { runs: number; saved: number }; without: { runs: number; saved: number } }`.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`:

```ts
it("defaults the scenario layer on with a threshold of 3", () => {
  const config = loadConfig({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m" });
  expect(config.SCENARIOS_ENABLED).toBe(true);
  expect(config.SCENARIO_CONFIRM_THRESHOLD).toBe(3);
});
```

In `test/report.test.ts`:

```ts
it("reports the saved-rate split between scenario-backed and counter-only reviews", () => {
  const md = renderReport({ /* …existing minimal input… */,
    scenarioMetric: { withScenarios: { runs: 4, saved: 3 }, without: { runs: 20, saved: 1 } },
  });
  expect(md).toContain("3/4");
  expect(md).toContain("1/20");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run test/config.test.ts test/report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/config.ts`, alongside the existing review knobs:

```ts
export const DEFAULT_SCENARIO_CONFIRM_THRESHOLD = 3;
```

and in the zod schema:

```ts
  // The L2 layer is inert without traces and an analysis run, so it defaults
  // on: with no scenarios mined, fetchDueScenarios returns an empty list and
  // nothing about the review changes.
  SCENARIOS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false")
    .pipe(z.boolean()),
  SCENARIO_CONFIRM_THRESHOLD: z.coerce
    .number()
    .int()
    .min(2)
    .default(DEFAULT_SCENARIO_CONFIRM_THRESHOLD),
```

(Match the exact idiom the neighbouring `MEMORY_ENABLED` / `SELF_SKILLS_ENABLED` entries use — copy their transform, don't invent a new one.)

`src/analysis/report.ts` — add the optional field to the report input and render a section:

```md
## Self-improvement reviews

- with scenario evidence: 3/4 saved
- counters only: 1/20 saved
```

`src/analysis/run.ts` — compute it before `renderReport`:

```ts
    // Both populations from one pass over the audit log: a review "had
    // evidence" iff its payload carries a non-empty scenario_ids array.
    const { rows: reviewRuns } = await pool.query<{ with_scenarios: boolean; saved: boolean }>(
      `SELECT jsonb_array_length(COALESCE(payload->'scenario_ids','[]'::jsonb)) > 0 AS with_scenarios,
              action = 'saved' AS saved
         FROM agent_selfimprove_audit
        WHERE origin = 'background_review' AND subsystem = 'review'
          AND ($1::int IS NULL OR created_at > now() - make_interval(days => $1::int))`,
      [windowDays],
    );
```

then fold into `{ withScenarios: {runs, saved}, without: {runs, saved} }` and pass as `scenarioMetric`.

- [ ] **Step 4: Update `CLAUDE.md`**

In the self-improvement/agent section, add a short paragraph: the loop now has an L2 layer (`agent_scenarios`), mined offline by `npm run analyze`, feeding the background review as a third due-source; scenarios ride in the review's user message and never the system prompt; a scenario is offered at most twice.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/config.test.ts test/report.test.ts test/analysis-run.test.ts`
Expected: PASS.

- [ ] **Step 6: Full verification**

Run: `npm run lint && npm test && npm run build`
Expected: all green, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/analysis/report.ts src/analysis/run.ts CLAUDE.md test/config.test.ts test/report.test.ts
git commit -m "Add scenario config knobs and the review saved-rate metric"
```

---

## Self-review against the spec

- **Проблема / архитектура** — Tasks 3–6 build exactly the `L1 atoms → L2 → review` path the spec draws.
- **Развилка №1 (per-user scope)** — Task 1 (`user_id` columns, `scope` CHECK), Task 2 (carrying the id), Task 3 (`bucketAtoms` splitting user vs global).
- **Развилка №2 (repetition measure)** — Task 3 (`extractScenarios` + `findDuplicate` + `confirmationsOf`), Task 4 (upsert-merge).
- **Contract: таблица** — Task 1, with one documented deviation: `embedding` is `jsonb`, not `vector(768)`, because PGlite has no pgvector; the spec is amended accordingly.
- **Machine of states / anti-loop invariant** — Task 5 (`nextScenarioState`, `markScenariosOffered` before the LLM call).
- **Contract: how it reaches the review / prompt cache** — Task 6, with an explicit test asserting the block is absent from `system`.
- **Attribution** — Task 6 (`scenario_ids` in the audit payload, max 2 offers).
- **Наблюдаемость** — Task 7 (saved-rate split in the analysis report).
- **Не-цели** — no hot-path recall, no LLM consolidation of memory, no UI, no short-term offload: nothing in these tasks adds any of them.
