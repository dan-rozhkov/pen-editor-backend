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
          JSON.stringify(row.payload),
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
