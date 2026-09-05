import pg from "pg";
import type { Config } from "../config.js";

export interface RawTracePayload {
  messages: unknown[];
  steps: unknown[];
  systemPromptHash: string;
}

export interface RawTraceRow {
  sessionId: string;
  // Client-generated anonymous id (localStorage `pen.userId`), already shape-
  // validated by the route (isPlausibleUserId) before it ever reaches here.
  // Absent/null for older clients or a turn where the id failed validation.
  userId?: string | null;
  model: string;
  agentMode: string;
  payload: RawTracePayload;
  streamError: string | null;
  inputTokens: number;
  outputTokens: number;
}

// Minimal query surface so tests can pass a fake instead of a real pg.Pool.
export interface TraceQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export interface TraceStore {
  writeRawTrace(row: RawTraceRow): Promise<void>;
  close(): Promise<void>;
}

// Shared pool factory: idle-client errors must never crash whichever process
// created the pool (chat server or the analyze worker), so every pool we
// create gets an 'error' listener wired up from the start.
//
// connectionTimeoutMillis bounds how long a `connect()`/pool-level `query()`
// can wait to acquire a TCP connection — pg's own default is 0 (wait
// forever). It is opt-in per pool, NOT a blanket default: every caller of
// `createPgPool` gets its OWN separate `pg.Pool` instance (traceStore,
// memoryStore, analysis, curator, showcase, startup migrations), and only
// the memory pool sits in a request's hot path (`/api/chat`'s
// `prepareChatTurn` snapshot read — see MEMORY_SNAPSHOT_TIMEOUT_MS in
// chatTurn.ts, which bounds the query itself but not the wait for a free
// pool slot). That one must fail fast rather than hang a user's request
// indefinitely. Every other caller here is batch/CLI-ish (trace writes,
// nightly analysis, the curator CLI, showcase generation, one-shot startup
// migrations) and should keep pg's old "wait for a slot" semantics — under a
// burst of concurrent work against a small `max`, erroring instead of
// queueing would turn a slow patch into a failed one for no reason.
// Deliberately NOT a global `statement_timeout` either: some of these
// callers run legitimately long queries, and a statement timeout would cut
// those off mid-query instead of just failing fast on a dead connection.
export function buildPgPoolOptions(
  connectionString: string,
  options: { max?: number; connectionTimeoutMillis?: number } = {},
): pg.PoolConfig {
  const { max = 3, connectionTimeoutMillis } = options;
  const config: pg.PoolConfig = { connectionString, max };
  if (connectionTimeoutMillis !== undefined) {
    config.connectionTimeoutMillis = connectionTimeoutMillis;
  }
  return config;
}

export function createPgPool(
  connectionString: string,
  options: { max?: number; connectionTimeoutMillis?: number } = {},
): pg.Pool {
  const pool = new pg.Pool(buildPgPoolOptions(connectionString, options));
  pool.on("error", (err) => console.error("[db] pool error:", err.message));
  return pool;
}

// Screenshots and image attachments reach the trace as `data:...;base64,...`
// strings inside the message history, and `buildTraceRow` stores the WHOLE
// incoming history on every turn — so one screenshot is re-stored once per
// tool-loop continuation. Measured on the Neon database in 2026-09: 94% of
// all `raw_traces` bytes (208 MB of 222 MB across the largest rows) were
// base64 payloads, and the table alone was 477 MB of a 512 MB quota. The
// analysis pipeline only ever reads text, tool calls and the prompt hash —
// it never looks at the pixels — so the bytes are pure cost. Redaction
// happens on the serialized JSON rather than by walking the object: the
// payload shape is `unknown[]` by design (whatever the client sent), so
// there is no reliable set of fields to target, and a single regex pass over
// the string catches an image wherever it is nested.
//
// Small data URLs (inline icons, 1x1 spacers) are left alone: they cost
// nothing and keeping them keeps trace rendering honest.
const MIN_REDACTED_BASE64_CHARS = 512;
const BASE64_DATA_URL_RE = new RegExp(
  `data:([\\w.+-]+/[\\w.+-]+)?((?:;[\\w.+-]+=[\\w.+-]+)*);base64,([A-Za-z0-9+/]{${MIN_REDACTED_BASE64_CHARS},}={0,2})`,
  "g",
);

/** Replaces every large base64 data URL in a JSON string with a size marker. */
export function redactBase64DataUrls(json: string): string {
  return json.replace(
    BASE64_DATA_URL_RE,
    (_match, mime: string | undefined, params: string, data: string) =>
      `data:${mime ?? ""}${params};base64,[redacted ${data.length} chars]`,
  );
}

export function createTraceStore(
  config: Config,
  pool?: TraceQueryable,
): TraceStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable =
    pool ?? createPgPool(config.TRACE_DATABASE_URL);

  return {
    async writeRawTrace(row) {
      await db.query(
        `INSERT INTO raw_traces
           (session_id, user_id, model, agent_mode, payload, stream_error, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          row.sessionId,
          row.userId ?? null,
          row.model,
          row.agentMode,
          redactBase64DataUrls(JSON.stringify(row.payload)),
          row.streamError,
          row.inputTokens,
          row.outputTokens,
        ],
      );
    },
    close: () => db.end(),
  };
}

export function writeRawTraceSafe(store: TraceStore, row: RawTraceRow): void {
  // Guard both a rejected promise and a synchronous throw — trace writing
  // must never affect the chat response.
  try {
    store.writeRawTrace(row).catch((err) => {
      console.error("[trace] failed to write raw trace:", err);
    });
  } catch (err) {
    console.error("[trace] failed to write raw trace:", err);
  }
}
