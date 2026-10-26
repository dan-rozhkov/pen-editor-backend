-- Per-user "agent remembers" switch. A missing row means enabled, so only
-- users who turned memory off ever get a row.
CREATE TABLE IF NOT EXISTS agent_memory_prefs (
  user_id    text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
