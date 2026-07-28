-- Pin exclusivity moves from the whole table to one row per run_id: each app
-- may have its own cover screen, not just one for the entire feed.
DROP INDEX IF EXISTS showcase_screens_published_pinned_idx;

CREATE UNIQUE INDEX IF NOT EXISTS showcase_screens_run_pinned_idx
  ON showcase_screens (run_id)
  WHERE pinned_at IS NOT NULL;

-- Does not cover the top-level ORDER BY (it leads with run_sort, a window-
-- function output this index can't carry, so Postgres still does an explicit
-- Sort over the published set). What it does support: the PARTITION BY run_id
-- scan behind MAX(created_at), and within-run lookups ordered pinned-first
-- then newest-first.
CREATE INDEX IF NOT EXISTS showcase_screens_run_feed_idx
  ON showcase_screens (run_id, (pinned_at IS NOT NULL) DESC, created_at DESC, id DESC)
  WHERE published;
