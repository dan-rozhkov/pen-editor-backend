-- Design-system libraries (Phase 6 of "Enterprise-grade design systems").
-- A library is owned by a Better Auth ACCOUNT (never an anonymous client id),
-- so neither table is a CLAIM_TARGETS table: there is nothing to claim.
--
-- ds_versions rows are immutable snapshots. `snapshot` is JSONB, so the route
-- hashes the canonical JSON it produced (sorted keys) and stores that hash in
-- `snapshot_hash`; JSONB reorders keys and cannot hold a `\u0000` escape, and
-- the route rejects the latter before it reaches this table.
-- Idempotent (IF NOT EXISTS / OR REPLACE), like 015.
CREATE TABLE IF NOT EXISTS ds_libraries (
  id                  TEXT PRIMARY KEY,     -- 'lib_' + 12 base64url chars, route-generated
  owner_id            TEXT NOT NULL,        -- Better Auth user id (never an anon id)
  name                TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description         TEXT NOT NULL DEFAULT '',
  latest_version      TEXT,
  latest_published_at TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Names are unique per owner among live libraries; archiving frees the name.
CREATE UNIQUE INDEX IF NOT EXISTS ds_libraries_owner_name_uq
  ON ds_libraries (owner_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ds_libraries_owner_created_idx
  ON ds_libraries (owner_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS ds_versions (
  library_id      TEXT NOT NULL REFERENCES ds_libraries(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  major           INT NOT NULL,
  minor           INT NOT NULL,
  patch           INT NOT NULL,
  bump            TEXT NOT NULL CHECK (bump IN ('initial', 'major', 'minor', 'patch')),
  base_version    TEXT,
  snapshot        JSONB NOT NULL,
  snapshot_hash   TEXT NOT NULL,            -- sha256 of canonical JSON
  changelog       JSONB NOT NULL,           -- client-supplied display data, never used for gating
  summary         JSONB NOT NULL DEFAULT '{}',   -- server-computed {added, changed, deprecated, removed}
  migrations      JSONB NOT NULL DEFAULT '[]',   -- server-derived, see src/ds/diff.ts
  notes           TEXT NOT NULL DEFAULT '',
  published_by    TEXT NOT NULL,
  published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT,
  request_hash    TEXT,
  PRIMARY KEY (library_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ds_versions_idem_uq
  ON ds_versions (library_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ds_versions_order_idx
  ON ds_versions (library_id, major DESC, minor DESC, patch DESC);

-- A published version never changes. DELETE stays possible so that deleting a
-- library (ON DELETE CASCADE) works.
CREATE OR REPLACE FUNCTION ds_versions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ds_versions rows are immutable';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ds_versions_no_update ON ds_versions;
CREATE TRIGGER ds_versions_no_update
  BEFORE UPDATE ON ds_versions
  FOR EACH ROW EXECUTE FUNCTION ds_versions_immutable();
