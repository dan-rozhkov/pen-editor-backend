-- Skills the agent wrote for itself. GLOBAL, not per-user: the agent serves
-- one design domain, so a procedure learned in one session is procedure for
-- every session. Revisit only if real multi-tenancy arrives.
--
-- Curated skills live in src/skills/*.md and are git-owned; they are never
-- represented here, and the tool that writes this table refuses their names.
CREATE TABLE IF NOT EXISTS agent_skills (
  name         text PRIMARY KEY,           -- kebab-case, validated
  description  text NOT NULL,              -- <=60 chars enforced on create
  body         text NOT NULL,              -- markdown, no frontmatter
  created_by   text NOT NULL,              -- 'agent' (only value for now)
  state        text NOT NULL DEFAULT 'active',  -- 'active'|'stale'|'archived'
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

-- Phase 3's deterministic curator sweeps by "unused since": active -> stale at
-- 30 days, stale -> archived at 90.
CREATE INDEX IF NOT EXISTS agent_skills_state_last_used_idx
  ON agent_skills (state, last_used_at NULLS FIRST);
