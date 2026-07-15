CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS raw_traces (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT        NOT NULL,
  agent_mode    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  stream_error  TEXT,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS raw_traces_session_idx ON raw_traces (session_id, created_at);
CREATE INDEX IF NOT EXISTS raw_traces_created_idx ON raw_traces (created_at);

CREATE TABLE IF NOT EXISTS session_summaries (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT        NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_goal        TEXT        NOT NULL,
  summary          TEXT        NOT NULL,
  outcome          TEXT        NOT NULL CHECK (outcome IN ('success','partial','failure','unclear')),
  tool_errors      JSONB       NOT NULL DEFAULT '[]',
  frustration      BOOLEAN     NOT NULL DEFAULT false,
  model            TEXT        NOT NULL,
  agent_mode       TEXT        NOT NULL,
  step_count       INTEGER     NOT NULL DEFAULT 0,
  embedding        vector(768),
  pii_check_passed BOOLEAN     NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_days   INTEGER,
  summary_count INTEGER     NOT NULL,
  model         TEXT        NOT NULL,
  report_md     TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  description TEXT   NOT NULL,
  size        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_clusters (
  cluster_id BIGINT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  summary_id BIGINT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, summary_id)
);
