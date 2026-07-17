# Session Insights — design

Date: 2026-07-17
Status: approved, not implemented

## Problem

The Clio summarizer (`src/analysis/summarize.ts`) produces one aggregate-safe
paragraph per session. That is the right artifact for clustering, but it throws
away the material that would let an agent improve itself: the moments the user
corrected the agent, the things the user asked it to remember, what the agent
itself claimed about its own limits or plans, and whether it recovered from a
tool error.

Two concrete signals from the 2026-07-17 report motivate this. Both failing
sessions were `batch_design` → `unknown node id`, and one of them was a real
multi-turn session (mobile health dashboard, 27 raw_traces rows). The summary
says the operation failed — it does not say whether the agent retried, what the
user said next, or what the agent concluded. That is exactly the delta needed to
propose a prompt fix.

The summarizer cannot simply be extended: its prompt forbids verbatim quotes
("Never quote user text verbatim"), and corrections/memory-requests lose their
value when paraphrased — the exact wording *is* the rule.

## Consumer

The **cron self-improvement agent** (the deferred next step of the trace-analysis
work). It reads insights and proposes edits to the system prompt and skills.
Optimize for machine-readable lists of facts, not narrative. A compact report
section is rendered as a secondary, human-facing view.

## Approach

A **second extraction pass**, separate from summarization.

Rejected alternatives:

- *Extend `sessionSummarySchema`* (one LLM call, least code): forces one prompt to
  carry contradictory rules — "never quote" for `summary`, "quote exactly" for the
  new fields. Risks blurred quotes, or raw user copy leaking into `summary`, which
  feeds clustering.
- *Map-reduce over chunked transcripts*: solves truncation more thoroughly, but
  YAGNI until truncation is observed to bite. See "Truncation" for the cheaper fix.

The cost is a second `generateObject` per session — roughly 2× analysis tokens.
At current volume (9 sessions) that is negligible, and `ANALYSIS_MODEL` is
`google/gemini-2.5-flash`.

## Components

### `src/analysis/insights.ts` (new)

Mirrors `summarize.ts`: schema + prompt + one function, no DB access.

```ts
export const sessionInsightsSchema = z.object({
  errors: z.array(z.object({
    tool: z.string(),
    error: z.string(),                 // category, not raw payload
    recovered: z.boolean(),            // did the agent get past it in-session
    what_agent_did_next: z.string(),
  })),
  corrections: z.array(z.object({
    what_agent_did: z.string(),
    what_user_wanted: z.string(),
    user_quote: z.string(),            // verbatim, PII-scrubbed
    agent_complied: z.boolean(),
  })),
  memory_requests: z.array(z.object({
    quote: z.string(),                 // verbatim, PII-scrubbed
    honored: z.boolean(),
  })),
  agent_claims: z.array(z.object({
    quote: z.string(),                 // what the agent SAID, not analyst inference
    kind: z.enum(["limitation", "assumption", "plan", "conclusion"]),
  })),
});

export async function extractInsights(
  model: LanguageModel,
  sessionText: string,
): Promise<SessionInsights>;
```

`agent_claims` holds only statements the agent actually made in chat. The
extractor must not invent lessons or interpretations; deriving lessons is the
cron agent's job.

`errors` deliberately overlaps `session_summaries.tool_errors`. The old field
feeds the report's tally table; the new one carries recovery context for the cron
agent. They have different consumers and are allowed to disagree in granularity.

Prompt rules: quotes permitted in `user_quote`/`quote` only; still no names,
emails, phone numbers, addresses, or credentials; empty arrays when nothing
applies (do not invent entries).

### `src/analysis/migrations/002_insights.sql` (new)

```sql
CREATE TABLE IF NOT EXISTS session_insights (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE
                    REFERENCES session_summaries(session_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  errors          JSONB NOT NULL DEFAULT '[]',
  corrections     JSONB NOT NULL DEFAULT '[]',
  memory_requests JSONB NOT NULL DEFAULT '[]',
  agent_claims    JSONB NOT NULL DEFAULT '[]',
  model           TEXT NOT NULL
);
```

A separate table, not columns on `session_summaries`: extraction can fail, be
re-run, and be backfilled independently of summarization, and `session_summaries`
stays the Clio artifact.

### `src/analysis/run.ts` (changed)

A second loop after the summarization loop:

```sql
SELECT ss.session_id FROM session_summaries ss
WHERE NOT EXISTS (SELECT 1 FROM session_insights si WHERE si.session_id = ss.session_id)
ORDER BY ss.id
```

For each: re-read `raw_traces` for that session, `assembleSession` →
`renderSessionText` → `extractInsights` → INSERT ... ON CONFLICT (session_id) DO
NOTHING. Per-session try/catch and a failure counter, matching the summarization
loop — one poisoned session must never block the rest or the TTL cleanup.

This loop backfills the 9 existing summaries on the first run without
re-summarizing them. **Backfill only works while the raw traces live**:
`TRACE_RAW_TTL_DAYS` is 14, and step 3 of the same run deletes expired rows.
Sessions whose raw traces are already gone get no insights, ever — the loop skips
them silently (no rows to assemble → caught, counted, logged).

Ordering: insights run after summarization and before TTL cleanup.

### `src/analysis/assemble.ts` (changed) — truncation

Today `renderSessionText` flat-caps at `maxChars = 60_000` by cutting the middle
out of the transcript, and `clip()` truncates tool input at 500 chars, tool output
at 1000, and any text part at `MAX_PART_CHARS = 1500`. For an aggregate summary
that is tolerable; for "extract everything important" it silently eats the
corrections it is supposed to find — the longest sessions (27 rows) are both the
most truncated and the most interesting.

Replace the flat cap with tiered rendering. Render at the most generous tier that
fits `maxChars`:

| Tier | text parts | tool input | tool output |
|---|---|---|---|
| 1 | 4000 | 2000 | 2000 |
| 2 | 4000 | 500 | 1000 |
| 3 | 4000 | 200 | 200 |

- `maxChars` default rises 60_000 → 200_000 (≈50k tokens; flash has a 1M-token
  context).
- User and assistant text parts, tool errors, and stream errors are never
  tightened between tiers — they are the corrections and the failures.
- If tier 3 still overflows, fall back to the existing middle-truncation as a last
  resort.

`renderSessionText` stays pure, so each tier is unit-testable.

### `src/routes/chat.ts` (changed) — `mapSteps` tool I/O

`mapSteps` builds each `LogStep` from `tc.args` and `tr.result`, but AI SDK v6
emits `input`/`output` on step tool calls/results. Verified against the live
database on 2026-07-17: `payload.steps[].toolCalls[].args` is `{}` for every row
ever written.

This is not cosmetic for this work. `assembleSession` takes the final turn from
`payload.steps` precisely because `messages` only carries history *before* the
last response — and `renderFinalTurnStep` reads `call.args` / `result.result`.
So the last assistant turn currently renders as `[tool batch_design]` with no
input, no output, and no ERROR line. The last turn is where a failing session
usually fails, so the extractor would be blind exactly where it matters.

Fix: `tc.input ?? tc.args` and `tr.output ?? tr.result` in `mapSteps`, with
`renderFinalTurnStep` tolerating both shapes, plus a test pinning the v6 shape.

**This only helps traces written from now on.** The 9 existing sessions already
hold `args: {}` on disk, so their backfilled insights keep a blind final turn.
Their earlier turns are unaffected (those ride in `messages`).

### `src/analysis/report.ts` (changed)

`ReportInput` gains an optional `insights` field. A new section renders between
"Top tool errors" and "# Clusters", omitted entirely when there is nothing to
show:

```markdown
## Corrections & memory requests

**Corrections: 4** (2 not complied) · **Memory requests: 3** (1 not honored) · **Unrecovered tool errors: 2**

- correction (not complied): <what_agent_did> → <what_user_wanted>
- memory request (not honored): <quote>
```

Lists the not-complied / not-honored / not-recovered entries first, capped at 10
lines with a `_Showing N of M._` footer, since those are the actionable ones. All
LLM-derived text goes through the existing `inline()` / `cell()` escaping.

## Privacy

- `extractInsights` scrubs its input with `scrubPii` before the call, as
  `summarizeOnce` does.
- `scrubPii` runs over every stored string field, including quotes.
- No `containsPii` retry loop and no `pii_check_passed` gate: insights never enter
  clustering, so there is no `WHERE pii_check_passed` to satisfy. The retry loop
  exists to protect the clustering corpus; adding it here would be cargo cult.
- `raw_traces` remains the only table holding unsanitized content.

## Testing

- `test/insights.test.ts`: `MockLanguageModelV3` scripted output → assert schema
  round-trip, that PII in quotes is scrubbed on the way out, and that empty
  categories stay empty arrays.
- `test/assemble.test.ts`: one case per tier — a transcript that fits tier 1; one
  that forces tier 2/3 and asserts user text survives verbatim while tool output
  shrinks; one that overflows tier 3 and hits middle-truncation.
- `test/report.test.ts`: section renders, is omitted when empty, escapes pipes and
  newlines.
- The `run.ts` loop is not unit-tested (matching current practice — only pure
  helpers are); verified by a live `npm run analyze` against the render.com
  Postgres.

## Verification

Live run against the existing 9 sessions (raw traces still present):
`npm run analyze` → `session_insights` populated, report gains the section, and
the health-dashboard session (`tab-1784288486419-1`, the `unknown node id`
failure) shows whether the agent recovered.

## Out of scope

- The degenerate clustering (every session lands in the "Unclustered" fallback in
  both runs to date) — separate bug, separate fix.
- The cron self-improvement agent that consumes this.
