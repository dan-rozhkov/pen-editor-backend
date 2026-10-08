-- Phase 7.2: opt-in, counts-only adoption data for design-system libraries.
-- One row per (library, document, reporter): the latest report of a document
-- that pins a version of the library. Keying by reporter means one account can
-- never overwrite another's report. `metrics` holds integers keyed by library
-- variable ids and component keys (validated against the pinned version's
-- snapshot), never names, markup, titles or free text. `document_key` is an
-- opaque random uuid chosen by the client; `id` is the stable opaque report id
-- an admin deletes by. `reporter_id` is a Better Auth account id (the caller
-- of the PUT), never an anon id, so there is nothing to claim.
-- token_coverage / component_coverage (0..1) and lint_total are derived on
-- write so lists and aggregates never have to read the JSONB.
-- Retention: rows older than 90 days are ignored by reads and swept daily.
-- Idempotent, like 017.
CREATE TABLE IF NOT EXISTS ds_usage (
  library_id          TEXT NOT NULL REFERENCES ds_libraries(id) ON DELETE CASCADE,
  document_key        TEXT NOT NULL,
  reporter_id         TEXT NOT NULL,
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  version             TEXT NOT NULL,
  metrics             JSONB NOT NULL,
  prev_metrics        JSONB,                    -- the previous report, for "came back" regressions
  token_coverage      DOUBLE PRECISION,         -- bound / bindable, NULL when nothing is bindable
  component_coverage  DOUBLE PRECISION,         -- (instances - detached) / instances, NULL without instances
  lint_total          INTEGER NOT NULL DEFAULT 0,
  reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, document_key, reporter_id),
  UNIQUE (id)
);

CREATE INDEX IF NOT EXISTS ds_usage_library_reported_idx ON ds_usage (library_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS ds_usage_reported_idx ON ds_usage (reported_at);
