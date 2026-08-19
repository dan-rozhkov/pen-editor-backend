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

-- The review's due-check: scope+user, then state, then the threshold. Also
-- serves the analysis run's dedup read (all live rows of one bucket, scope+
-- user with no state filter): a leading (scope, user_id) subset of this
-- index's columns covers that query just as well as a separate
-- (scope, user_id, state) index would, so there is no dedicated bucket index
-- here — it would be a strict, write-only-cost duplicate of this one.
CREATE INDEX IF NOT EXISTS agent_scenarios_due_idx
  ON agent_scenarios (scope, user_id, state, confirmations DESC);
