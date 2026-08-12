-- The UI-visibility endpoint (GET /api/memory/activity) queries
-- agent_selfimprove_audit by (user_id, id > $sinceId) ordered by id, not by
-- the (user_id, created_at DESC) shape 009's index serves. Add the matching
-- index rather than editing 009 — that migration may already be applied on
-- a dev database, and migration tracking is by filename.
CREATE INDEX IF NOT EXISTS agent_selfimprove_audit_user_id_idx
  ON agent_selfimprove_audit (user_id, id);
