-- L2 scenarios are per-user, but raw_traces only ever stored session_id.
-- Nullable on purpose: existing rows and sessions without a shape-valid
-- client userId stay NULL and roll up into scope='global' scenarios.
-- IF EXISTS: the PGlite test harness skips 001_init.sql (no pgvector), so
-- these tables are absent there and this migration must be a no-op, not a
-- hard failure.
ALTER TABLE IF EXISTS raw_traces        ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE IF EXISTS session_summaries ADD COLUMN IF NOT EXISTS user_id TEXT;
