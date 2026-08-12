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
