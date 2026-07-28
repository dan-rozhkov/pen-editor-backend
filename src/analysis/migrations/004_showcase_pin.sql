ALTER TABLE showcase_screens ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS showcase_screens_published_pinned_idx
  ON showcase_screens ((pinned_at IS NOT NULL) DESC, created_at DESC, id DESC)
  WHERE published;
