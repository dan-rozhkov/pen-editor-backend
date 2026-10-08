-- Phase 8.2: a design-system library may belong to an organization.
-- org_id NULL = a personal library: only owner_id has access (role 'owner').
-- org_id set  = access comes from the caller's `member` row for that
-- organization (owner / editor / viewer, see src/auth/organization.ts);
-- owner_id then only records who created the library.
-- No backfill on purpose: existing libraries stay personal, so the owner-only
-- behaviour of Phase 6 is unchanged until someone moves a library into an org.
-- RESTRICT: deleting an organization must not silently orphan or expose its
-- libraries; archive and purge them first.
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS), like 017.
ALTER TABLE ds_libraries ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES "organization" ("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ds_libraries_org_idx ON ds_libraries (org_id) WHERE org_id IS NOT NULL;

-- Names stay unique per owner among live PERSONAL libraries; an organization's
-- live libraries are unique per organization. Archiving frees the name.
DROP INDEX IF EXISTS ds_libraries_owner_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS ds_libraries_owner_name_uq
  ON ds_libraries (owner_id, lower(name)) WHERE archived_at IS NULL AND org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ds_libraries_org_name_uq
  ON ds_libraries (org_id, lower(name)) WHERE archived_at IS NULL AND org_id IS NOT NULL;
