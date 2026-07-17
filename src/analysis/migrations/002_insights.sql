CREATE TABLE IF NOT EXISTS session_insights (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT        NOT NULL UNIQUE
                    REFERENCES session_summaries(session_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  errors          JSONB       NOT NULL DEFAULT '[]',
  corrections     JSONB       NOT NULL DEFAULT '[]',
  memory_requests JSONB       NOT NULL DEFAULT '[]',
  agent_claims    JSONB       NOT NULL DEFAULT '[]',
  model           TEXT        NOT NULL
);
