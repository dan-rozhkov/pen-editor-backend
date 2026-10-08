-- Phase 8.3: append-only audit log for design-system libraries and
-- organization membership. Ids only, never content or emails: actor_id,
-- target_id and org_id are account / library / organization ids, meta carries
-- counts and enums. There is deliberately NO foreign key to ds_libraries or
-- "user": the history of a purged library or a deleted account must survive.
-- Retention: indefinite. Account deletion leaves actor_id as an opaque id.
-- Not an anon-claim table: every actor is an account id (or 'system').
-- Idempotent, like 017.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  library_id  TEXT,                       -- set for library.* and version.* events
  org_id      TEXT,                       -- the library's organization, or the organization of a member.* event
  actor_id    TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'api_key', 'system')),
  client_id   TEXT,                       -- OAuth client id or API key id
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  before_hash TEXT,
  after_hash  TEXT,
  meta        JSONB NOT NULL DEFAULT '{}',
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_library_idx ON audit_log (library_id, id DESC) WHERE library_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, id DESC) WHERE org_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
