-- The enterprise design-system feature set (libraries, organizations, audit
-- log, usage reports) was removed from the code. Migrations 017-021 had
-- already run in production and the runner never re-runs or reverses an
-- applied file, so those files stay as history and this migration removes
-- what they created. Everything is IF EXISTS ... CASCADE: a database that
-- never ran them, or a fresh one that ran 017-021 a moment ago, ends up the
-- same. Dependency order: children before parents.
DROP TABLE IF EXISTS ds_usage CASCADE;
DROP TABLE IF EXISTS ds_versions CASCADE;
DROP TABLE IF EXISTS ds_libraries CASCADE;
DROP FUNCTION IF EXISTS ds_versions_immutable() CASCADE;

DROP TABLE IF EXISTS audit_log CASCADE;
DROP FUNCTION IF EXISTS audit_log_append_only() CASCADE;

DROP TABLE IF EXISTS "invitation" CASCADE;
DROP TABLE IF EXISTS "member" CASCADE;
DROP TABLE IF EXISTS "organization" CASCADE;
ALTER TABLE "session" DROP COLUMN IF EXISTS "activeOrganizationId";
