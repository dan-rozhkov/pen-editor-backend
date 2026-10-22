-- Input tokens the provider served from its prompt cache, per request.
-- Before this, the only record of cache hits was the `[tokens]` log line,
-- which Render keeps for 30 days at most.
-- Nullable on purpose: NULL = the provider did not report it (and every row
-- written before this column existed); 0 = reported, nothing was cached.
-- IF EXISTS: the PGlite test harness skips 001_init.sql, see 013.
ALTER TABLE IF EXISTS raw_traces ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
