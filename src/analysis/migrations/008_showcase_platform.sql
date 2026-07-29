-- Desktop generation, alongside the existing mobile-only showcase. Every row
-- published before this migration is a phone screen, hence the default.
ALTER TABLE showcase_screens ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'mobile';

-- `listApps`'s runs subquery always filters `WHERE published = true AND
-- platform = $n [AND theme = $n]`, then GROUPs BY run_id computing
-- MAX(created_at)/likes for the run-level sort — the same shape 005's
-- showcase_screens_run_feed_idx supports for run_id alone, but every query
-- now leads with platform, so put it first. Also covers the per-run,
-- pinned-first/newest-first ordering `listApps`'s outer SELECT uses once the
-- run set is known.
CREATE INDEX IF NOT EXISTS showcase_screens_platform_run_feed_idx
  ON showcase_screens (platform, run_id, (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC)
  WHERE published;
