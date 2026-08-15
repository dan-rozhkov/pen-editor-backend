-- User-authored skills (Figma-style "custom skills"), scoped by the existing
-- anonymous `userId` (never authenticated — same trust model as
-- `agent_memory`, see 009_agent_memory.sql). Unlike `agent_skills` (learned,
-- global — one skill library serves every session because the agent serves
-- one design domain), these are per-user by design: a user's own workflow
-- shortcut has no reason to be visible to anyone else, and `PRIMARY KEY
-- (user_id, name)` is what makes two different users free to pick the same
-- skill name without colliding.
CREATE TABLE IF NOT EXISTS user_skills (
  user_id      TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  body         TEXT        NOT NULL,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  source       TEXT        NOT NULL DEFAULT 'manual',   -- manual | upload | generated
  use_count    INTEGER     NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

-- list()/listEnabled() both read "this user's skills, newest-updated first" —
-- the same access shape agent_skills_state_name_idx serves for the learned
-- catalog, scoped down to one user's rows here instead of a global state
-- filter.
CREATE INDEX IF NOT EXISTS user_skills_user_updated_idx
  ON user_skills (user_id, updated_at DESC);
