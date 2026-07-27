CREATE TABLE IF NOT EXISTS showcase_screens (
  id          UUID PRIMARY KEY,
  run_id      UUID        NOT NULL,
  theme       TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  prompt      TEXT        NOT NULL,
  model       TEXT        NOT NULL,
  image_url   TEXT        NOT NULL,
  html_url    TEXT        NOT NULL,
  width       INTEGER     NOT NULL,
  height      INTEGER     NOT NULL,
  published   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS showcase_screens_published_created_idx
  ON showcase_screens (created_at DESC, id DESC)
  WHERE published;
