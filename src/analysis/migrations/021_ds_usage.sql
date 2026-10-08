-- Phase 7.2: opt-in, counts-only adoption data for design-system libraries.
-- One row per (library, document): the latest report of a document that pins a
-- version of the library. `metrics` holds integers keyed by library variable
-- ids and component keys (validated against the pinned version's snapshot),
-- never names, markup, titles or free text. `document_key` is an opaque random
-- uuid chosen by the client. `reporter_id` is a Better Auth account id (the
-- caller of the PUT), never an anon id, so there is nothing to claim.
-- Retention: rows older than 90 days are pruned on write and ignored by reads.
-- Idempotent, like 017.
CREATE TABLE IF NOT EXISTS ds_usage (
  library_id    TEXT NOT NULL REFERENCES ds_libraries(id) ON DELETE CASCADE,
  document_key  TEXT NOT NULL,
  reporter_id   TEXT NOT NULL,
  version       TEXT NOT NULL,
  metrics       JSONB NOT NULL,
  prev_metrics  JSONB,                    -- the previous report, for "came back" regressions
  reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, document_key)
);

CREATE INDEX IF NOT EXISTS ds_usage_library_reported_idx ON ds_usage (library_id, reported_at DESC);
