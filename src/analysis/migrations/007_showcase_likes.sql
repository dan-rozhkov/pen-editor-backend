-- A like belongs to an *app* (run_id), which is up to 5 screen rows, not to
-- any one screen. A column on showcase_screens would mean five row updates
-- per increment and an ambiguous "which screen's counter is authoritative" —
-- a dedicated table sidesteps both.
CREATE TABLE IF NOT EXISTS showcase_app_likes (
  run_id     UUID PRIMARY KEY,
  likes      BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
