import pg from "pg";
import type { Config } from "../config.js";

export interface RawTracePayload {
  messages: unknown[];
  steps: unknown[];
  systemPromptHash: string;
}

export interface RawTraceRow {
  sessionId: string;
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

export function createTraceStore(
  config: Config,
  pool?: TraceQueryable,
): TraceStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable =
    pool ??
    (() => {
      const p = new pg.Pool({
        connectionString: config.TRACE_DATABASE_URL,
        max: 3,
      });
      // Idle-client errors must never crash the chat server.
      p.on("error", (err) => console.error("[trace] pool error:", err.message));
      return p;
    })();

  return {
    async writeRawTrace(row) {
      await db.query(
        `INSERT INTO raw_traces
           (session_id, model, agent_mode, payload, stream_error, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          row.sessionId,
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
  store.writeRawTrace(row).catch((err) => {
    console.error("[trace] failed to write raw trace:", err);
  });
}
