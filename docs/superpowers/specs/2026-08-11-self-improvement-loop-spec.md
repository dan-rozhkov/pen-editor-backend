# Self-Improvement Loop (Hermes-style): Persistent Memory + Self-Authored Skills

**Date:** 2026-08-11
**Status:** **SHIPPED** in backend v0.38.0 / frontend v0.75.0 (2026-08-12), all three phases. Both kill switches (`MEMORY_ENABLED`, `SELF_SKILLS_ENABLED`) default to `false`, and the loop has **not yet run against a live model** — verify before enabling in production.

> **Read `CLAUDE.md`, not this file, for how the shipped system works.** Its
> "Persistent agent memory", "Self-authored skills" and "Deterministic skills
> curator" sections describe the code as built. This spec and the three phase
> plans are kept as the record of *why* each decision was made; the behavioural
> contract below held, but several module paths and signatures named in the
> plans never existed — see the "As shipped" block at the top of each plan.

**Plans:** `docs/superpowers/plans/2026-08-11-selfimprove-phase{1,2,3}-*.md`
**Origin:** Reverse-engineering of `NousResearch/hermes-agent`'s memory + skill self-creation loop (session research 2026-08-11). We replicate the mechanism natively in `pen-editor-backend` instead of adopting Hermes as a harness.

## Problem

The design agent has no persistence across sessions: it re-learns user preferences every conversation and never distills recurring corrections into reusable procedure. Hermes demonstrates a working pattern: (a) two small always-in-prompt memory stores written by the model itself, (b) a background review pass that distills conversations into skill updates, (c) a rare curator pass that keeps the skill library from rotting. We port that pattern, improving on Hermes in one dimension: **per-user scoping in Postgres** (Hermes shares one memory file across all users — a known pain point in their tracker).

## Non-goals

- No embeddings/vector retrieval, no TTLs, no contradiction detection — Hermes ships none of these; the char budget IS the selection mechanism.
- No LLM-driven consolidation (curator phase 2 in Hermes) — off by default upstream, and their worst incident source (91M-token runaway). Deterministic curator only.
- No auth system. `userId` is a client-generated stable anonymous id.
- Curated skills in `src/skills/*.md` remain git-owned and hand-edited; the loop NEVER writes them.

## Architecture (all phases)

```
pen-editor (frontend)                     pen-editor-backend
┌──────────────────┐   userId in body   ┌─────────────────────────────────────┐
│ useDesignChat    │ ─────────────────► │ /api/chat route                     │
│ localStorage     │                    │   prepareChatTurn(+userId)          │
│ pen.userId       │                    │     └ memory snapshot → sys prompt  │
└──────────────────┘                    │     └ +memory/+skill_manage tools   │
                                        │   onFinish → maybeRunReview()       │
                                        │       (server-side generateText,    │
                                        │        whitelist: memory/skills)    │
                                        │ Postgres: agent_memory,             │
                                        │   agent_skills, agent_review_state, │
                                        │   agent_selfimprove_audit           │
                                        └─────────────────────────────────────┘
```

Key decision: **the new tools are turn-time injected, backend-executed tools** (same pattern as `load_skill` via `getSkillTools()` in `src/ai/skills.ts`) — NOT `penTools` entries. This keeps them out of the cross-repo tool contract entirely (no frontend handler, no `toolRegistry.ts` change, no contract-test churn). The only frontend change in the whole project is the `userId` plumbing.

## Locked interfaces (all plans must conform)

### Identity
- Frontend: `pen.userId` in `localStorage`, `crypto.randomUUID()` on first run, sent as `userId` in the `/api/chat` JSON body (`useDesignChat.ts` transport body).
- Backend: `userId: z.string().min(1).max(64).optional()` in the chat route schema. Absent `userId` → memory features silently disabled for that request (backward compatible; showcase runner passes none).

### Storage (Postgres, same database/pool as traces — reuse the existing connection config; plan 1 verifies the exact env var in `src/config.ts` and follows the `raw_traces` bootstrap pattern)

```sql
CREATE TABLE IF NOT EXISTS agent_memory (
  user_id    text NOT NULL,
  target     text NOT NULL CHECK (target IN ('memory','user')),
  entries    jsonb NOT NULL DEFAULT '[]',   -- string[]
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target)
);

CREATE TABLE IF NOT EXISTS agent_review_state (
  user_id            text PRIMARY KEY,
  turns_since_memory int NOT NULL DEFAULT 0,
  steps_since_skill  int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_selfimprove_audit (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  origin     text NOT NULL,                -- 'foreground' | 'background_review' | 'curator'
  subsystem  text NOT NULL,                -- 'memory' | 'skill'
  action     text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 2
CREATE TABLE IF NOT EXISTS agent_skills (
  name         text PRIMARY KEY,           -- kebab-case, validated
  description  text NOT NULL,              -- ≤60 chars enforced on create
  body         text NOT NULL,              -- markdown, no frontmatter
  created_by   text NOT NULL,              -- 'agent' (only value for now)
  state        text NOT NULL DEFAULT 'active',  -- 'active'|'stale'|'archived'
  use_count    int NOT NULL DEFAULT 0,
  view_count   int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

Concurrency: every read-modify-write runs `SELECT … FOR UPDATE` in a transaction. A failed read must abort the write (never rewrite from a view you didn't actually read — Hermes invariant).

### Memory semantics (ported from Hermes verbatim where noted)
- Char limits on the **serialized joined form** (entries joined with `\n§\n`): `memory` 2200, `user` 1375. Limits are characters, not tokens.
- Snapshot render (module `src/ai/memory/render.ts`):

```
══════════════════════════════════════════════
MEMORY (your personal notes) [67% — 1,474/2,200 chars]
══════════════════════════════════════════════
<entries joined by "\n§\n">
```

  Header `USER PROFILE (who the user is)` for the `user` target. Injected into the system prompt **after the skills catalog, before `## Current Canvas Context`** — loaded once per request; never re-read mid-turn.
- Tool `memory` (backend-executed): actions `add` | `replace` | `remove`, plus atomic `operations: [{action, content?, old_text?}]` batch. `replace`/`remove` match by **unique substring** (`old_text`); ambiguous → error listing candidates. Budget checked on the **final** state only. No `read` action. Success response is terminal and does NOT echo entries (`"Write saved. This update is complete — do not repeat it."`). Over-budget → error carrying `current_entries` + usage + the consolidate-in-this-turn instruction. Per-turn failure counter: after 3 failed memory calls in one request, respond `done: true` telling the model to stop retrying.
- Prompts (module `src/ai/memory/prompts.ts`): `MEMORY_GUIDANCE` (stable-tier text: declarative facts not instructions; "if a fact will be stale in a week, it does not belong in memory"; task progress → never) and the tool-description WHEN/HOW/IF FULL/SKIP block — both ported from Hermes verbatim (English), texts captured in the phase 1 plan.

### Background review runner (module `src/ai/selfimprove/review.ts`)
- `maybeRunReview({config, userId, prepared, messages, stepCount})` called fire-and-forget from the chat route's `onFinish` (errors caught + logged, never affect the user response).
- Counters in `agent_review_state`: `turns_since_memory` +1 per request, `steps_since_skill` +stepCount per request; thresholds `MEMORY_REVIEW_INTERVAL = 10` (user turns), `SKILL_REVIEW_INTERVAL = 15` (tool steps, phase 2). Reset on fire. Counter increments and threshold checks happen in the same `FOR UPDATE` transaction.
- The review is a server-side `generateText`: same model, the turn's exact `system` string (warm prefix cache), conversation replayed + the review prompt as a trailing user message, tools = **whitelist only** (`memory`; + `skill_manage`/`skill_view` in phase 2), `stopWhen: stepCountIs(8)`. Its transcript is never persisted into any user-visible session (Hermes learned this the hard way: a persisted review prompt turns the agent into "the curator" on the next turn).
- Review prompts ported from Hermes: memory-only, skill-only, and combined variants.
- Showcase runner and any headless entry point: **skipped** (no userId → no-op).
- Every autonomous write lands in `agent_selfimprove_audit` with `origin: 'background_review'`.

### Skills semantics (phase 2)
- Learned skills are **global** (not per-user) — the agent serves one design domain; revisit per-user scoping only if real multi-tenancy arrives.
- Tool `skill_manage`: `create` | `patch` (old_string/new_string, preferred) | `delete` (requires `absorbed_into: string` — empty string = pruning). Create validates: kebab-case name, description ≤60 chars, body ≤200 lines, name must not collide with curated skills or `penTools` names.
- Guards: curated `src/skills/*.md` are read-only to the tool (error mentions they are git-owned); `patch`/`delete` require the exact skill to have been loaded via `load_skill`/`skill_view` **within the same review run** (read-before-write, tracked in the runner's in-memory context).
- Catalog: `buildSystemPrompt`'s skills catalog merges curated + learned (learned marked `(learned)`); `load_skill` resolves both, bumping `use_count` for learned. Learned skills are NOT slash-invocable (slash stays curated-only).
- The review prompt carries Hermes' preference ladder (patch existing → extend → only then create new; class-level names; the do-not-capture list: environment-dependent failures, negative tool claims, transient errors, one-off narratives, unresolved failures) — verbatim texts in the phase 2 plan.

### Curator (phase 3, deterministic only)
- CLI `npm run skills:curate` (entry `src/selfimprove/curateRun.ts`, same `runAsScript` pattern as showcase CLIs): `state='active'` unused ≥30 days → `'stale'`; `'stale'` unused ≥90 days total → `'archived'` (dropped from catalog). Never DELETE. Prints a report; `--dry-run` default OFF is forbidden — mutating run requires `--apply`. Snapshot of `agent_skills` written to `agent_selfimprove_audit` (`origin: 'curator'`) before any mutation.

## UI visibility (added 2026-08-11, user requirement)

The user must SEE when the agent's memory changed or a skill was created — silent self-modification is not acceptable UX.

- **In-turn writes** (the model calls `memory`/`skill_manage` during a chat turn): the tool part already streams to the client; the chat panel renders a friendly inline indicator for these tool names (e.g. "Память обновлена" / "Скилл создан: <name>") instead of a generic tool chip. Frontend-only change.
- **Background-review writes** (happen server-side after the stream closes): new read-only endpoint `GET /api/memory/activity?userId=…&since=<ISO>` returning recent `agent_selfimprove_audit` rows `{subsystem, action, origin, created_at}` (no entry contents — summaries only). After a turn finishes, the frontend schedules one delayed check (~20s) and surfaces a transient toast/badge if `origin='background_review'` rows appeared. Phase 1 covers `subsystem='memory'`; phase 2 reuses the same endpoint and toast for `subsystem='skill'`.

## Testing requirements (all phases)
- Vitest in `test/`, following existing patterns: LLM via `MockLanguageModelV3` + `vi.mock` of `src/ai/provider.js`; DB tests use the same approach as the showcase pagination tests (PGlite — the fake-DB lesson from FIR filters applies: SQL must run against a real engine).
- Route-level tests use `buildApp()` + listen + fetch (not `inject`, chat route hijacks the reply).
- Contract untouched: no `penTools` changes in any phase → no cross-repo contract work. The only frontend PR (userId) needs a `useDesignChat` test asserting the body carries `userId`.

## Rollout / safety
- Phase order strict: 1 → 2 → 3; each independently shippable.
- All autonomous writes audited from day one; `ENABLE_AGENT_LOGGING=true` also dumps review-run transcripts via the existing logging module.
- Kill switches: `MEMORY_ENABLED` / `SELF_SKILLS_ENABLED` env flags (zod, default `false` until verified live) checked in `prepareChatTurn` tool assembly and in `maybeRunReview`.
- Known upstream failure modes to respect (from Hermes' tracker): garbage-skill manufacture (mitigated by the do-not-capture list + ladder), self-congratulation (review prompt asks for user-visible signals, not self-assessment), counter never firing for short sessions (counters are per-user cumulative in DB, not per-session), review recursion (runner never persists, never triggers itself).
