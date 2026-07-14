# Clio-Style Private Trace Analysis for the Design Agent

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan

## Purpose

Collect traces of design-agent sessions (including client-side tool errors), strip PII, summarize each session, cluster summaries into problem/pattern groups, and store everything in a cloud Postgres (Aiven free tier) so a human — and later an automated cron agent — can use the insights to improve the agent's prompt and harness.

Privacy model follows Anthropic's Clio: raw data is short-lived, everything permanent is sanitized and describes *behavior patterns*, never verbatim user content.

## Key architectural facts this design builds on

- The agent uses split execution: tool schemas live on the backend, tool execution happens in the browser. A single `/api/chat` request therefore contains **no client-tool results**; results (and errors) come back embedded in the `messages` array of the *next* request. A "session trace" spans multiple requests and must be stitched.
- There is currently no session identity: `chat.ts` generates a fresh random `sessionId` per request. Stitching requires a client-generated session ID.
- `chat.ts` already assembles per-step logs (`LogStep`) in `onFinish` and writes local JSON files to `.logs/` when `ENABLE_AGENT_LOGGING=true` (`src/logging.ts`). This stays; Postgres tracing is additive.
- The backend already has an OpenRouter LLM provider; the analysis pipeline reuses it.

## Decisions made during brainstorming

1. **Storage scope:** raw traces go to Postgres too, in a dedicated table with a short TTL (default 14 days). Sanitized summaries, clusters, and reports are permanent.
2. **Pipeline location:** a separate worker script in this repo (`src/analysis/`, run via `npm run analyze`), scheduled externally (server cron / GitHub Actions / manual). The chat backend only *writes* raw traces.
3. **Scale posture:** traffic is small (units–tens of sessions/day) → clustering is done by an LLM over the whole analysis window. But every summary gets a pgvector `embedding` column populated when an embeddings provider is configured, so a switch to algorithmic clustering later needs no schema migration.
4. **Consumption:** the primary artifact is a Markdown report per analysis run (`reports/YYYY-MM-DD.md`), also stored in the `analysis_runs` table. No admin UI.

## Component 1 — Trace collection

### Frontend (`pen-editor`, minimal change)

- `useDesignChat` generates a `chatSessionId` (UUID) once per chat conversation lifetime and includes it in the `/api/chat` request body. Reset when the conversation is cleared/new chat started.

### Backend (`pen-editor-backend`)

- `chatBodySchema` accepts optional `chatSessionId: z.string().uuid().optional()`. Absent → the request is still served; the trace row gets a generated fallback ID (such rows form single-request sessions).
- In `onFinish`, in addition to the existing `.logs/` behavior, write one row to `raw_traces`:
  - `session_id`, `request_seq` (derived: count of prior rows for the session, or timestamp ordering), `model`, `agent_mode`, `payload` (jsonb: full incoming `messages`, system prompt hash — not the full system prompt, steps as `LogStep[]`, usage), `stream_error` (nullable text), `created_at`.
- Server-side errors (invalid tool input, `NoSuchToolError`, stream failures, aborts) are recorded in the trace row (`stream_error` / step data). Client-tool errors need no special capture — they arrive as tool-result parts inside the next request's `messages` and are stored with the full history.
- Writing is **fire-and-forget**: failures are logged with `console.error` and never affect the chat response. A small connection pool (`pg`) is created at startup only when `TRACE_DATABASE_URL` is set; when unset, the feature is fully inert.
- New env vars (all optional, validated in `config.ts`):
  - `TRACE_DATABASE_URL` — Postgres connection string (Aiven requires SSL; `sslmode=require` in the URL).
  - `TRACE_RAW_TTL_DAYS` — default `14`.
  - `ANALYSIS_MODEL` — default `google/gemini-2.5-flash`.
  - `EMBEDDINGS_API_KEY` / `EMBEDDINGS_MODEL` — optional; embeddings are skipped when absent.

## Component 2 — Postgres schema

Extension: `vector` (pgvector, available on Aiven). Migrations are plain SQL files in `src/analysis/migrations/`, applied idempotently by the worker at startup (simple `schema_migrations` table).

| Table | Columns (essence) | Retention |
|---|---|---|
| `raw_traces` | `id`, `session_id`, `created_at`, `model`, `agent_mode`, `payload jsonb`, `stream_error text`, usage fields | deleted after `TRACE_RAW_TTL_DAYS` by the worker |
| `session_summaries` | `id`, `session_id` (unique), `created_at`, `summary text`, `user_goal text`, `outcome` (`success \| partial \| failure \| unclear`), `tool_errors jsonb` (tool name + error kind, no payloads), `frustration bool`, `model`, `agent_mode`, `step_count`, `embedding vector(768) NULL`, `pii_check_passed bool` | permanent |
| `analysis_runs` | `id`, `created_at`, `window_start/window_end`, `report_md text`, `summary_count`, `model` | permanent |
| `clusters` | `id`, `run_id` FK, `name`, `description`, `size` | permanent |
| `summary_clusters` | `cluster_id` FK, `summary_id` FK | permanent |

Cluster assignments are per-run (a new run re-clusters the window), so `summary_clusters` links to run-scoped clusters; historical runs remain queryable for trend analysis.

## Component 3 — Analysis worker (`src/analysis/`, `npm run analyze`)

One idempotent CLI script. Steps in order:

1. **Session assembly.** Select sessions from `raw_traces` that are *complete* (no row newer than 30 minutes) and have no `session_summaries` row. Reconstruct the full conversation from the row with the longest `messages` history (later requests carry the entire prior history, including client-tool results/errors); merge in `stream_error`s from all rows of the session.
2. **PII stripping — three layers (defense in depth):**
   - (a) *Pre-LLM regex scrubber* over the assembled trace text: emails, phone numbers, API keys/tokens (common prefixes + high-entropy strings), URLs with embedded credentials → replaced with typed placeholders (`[EMAIL]`, `[TOKEN]`, …). Image/file payloads (base64, data URLs) are dropped entirely before the LLM sees the trace.
   - (b) *Summarizer prompt constraints*: the summary must describe behavior patterns; it must not contain names, verbatim quotes of user text, or any personal/identifying details (Clio principle).
   - (c) *Post-LLM output validation*: the same regex battery runs over the generated summary; on a hit the summary is rejected and regenerated (max 2 retries, then the session is marked `pii_check_passed=false` and excluded from reports).
3. **Summarization.** `ANALYSIS_MODEL` via the existing OpenRouter provider, structured output (zod schema): `user_goal`, `summary`, `outcome`, `tool_errors[]` (tool name + error category), `frustration`. One LLM call per session.
4. **Embedding (optional).** When `EMBEDDINGS_API_KEY` is configured (pluggable provider module; default implementation targets the Gemini embeddings API — OpenRouter has no stable embeddings endpoint), embed `summary` and store in `embedding`. Otherwise leave NULL. Nothing downstream depends on it yet.
5. **LLM clustering.** Feed all summaries in the analysis window (default: all summaries to date; configurable `--window-days`) to one LLM call → named clusters with descriptions + assignment of each summary to exactly one cluster (an "other/unclustered" bucket is allowed). Persist as a new `analysis_runs` row + `clusters` + `summary_clusters`.
6. **Report generation.** Render `reports/YYYY-MM-DD.md`: clusters ordered by size with descriptions and per-cluster example summaries, deltas vs the previous run (new/grown/shrunk clusters), top tool-error categories, outcome distribution. Written to the `reports/` directory (gitignored) and stored in `analysis_runs.report_md`.
7. **Cleanup.** `DELETE FROM raw_traces WHERE created_at < now() - interval 'TRACE_RAW_TTL_DAYS days'`.

Idempotency: summaries are keyed by `session_id` (unique) — re-runs skip already-summarized sessions; each run creates a fresh `analysis_runs` row.

## Privacy summary

- Raw traces: cloud-stored but TTL-bound (14 days default); local `.logs/` remains opt-in via the existing flag.
- Everything permanent (summaries, clusters, reports) passes the three-layer PII filter and contains no verbatim user content, no image data, no credentials.
- Aiven connection over TLS (`sslmode=require`); credentials only in `.env` (never committed).
- `reports/` is gitignored; report content is sanitized anyway, but reports stay local/DB-only by default.

## Testing

Follows the repo's existing conventions (Vitest, no real LLM, no API keys):

- **Regex scrubber + output validator**: pure unit tests with PII fixtures (emails, phones, tokens, data URLs).
- **Session assembly**: unit tests on fixture `raw_traces` rows (multi-request session with a client-tool error in the second request's history; stream-error merge; incomplete-session exclusion).
- **Summarizer & clusterer**: `MockLanguageModelV3` from `ai/test` (same pattern as existing chat tests), asserting prompt constraints are present and structured output is parsed/validated.
- **DB layer**: kept thin (a module exposing typed query functions); tests mock the `pg` client. No real Postgres in CI.
- **Trace write in `chat.ts`**: integration test via `buildApp()` + listen/fetch (existing pattern) with a mocked trace-store module, asserting fire-and-forget (a throwing store must not break the SSE response).
- **Frontend**: `useDesignChat` test asserts `chatSessionId` is present and stable across messages in one conversation, and changes after reset.

## Out of scope (explicitly)

- The self-improving cron agent that reads summaries/reports and proposes prompt changes — future work; this system provides its data source (SQL + Markdown reports).
- Algorithmic clustering (k-means/HDBSCAN over embeddings) — schema is ready, implementation deferred.
- Admin UI, auth/user identity, multi-tenant concerns.
- Clio-style minimum-cluster-size aggregation thresholds — meaningful for large multi-user populations, not for this traffic level.
