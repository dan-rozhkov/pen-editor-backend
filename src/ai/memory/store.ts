import type { Config } from "../../config.js";
import { createPgPool } from "../../tracing/traceStore.js";
import { applyMemoryOperations, type MemoryApplyOutcome } from "./apply.js";
import {
  type MemoryOperation,
  type MemorySnapshot,
  type MemoryTarget,
} from "./types.js";

/** Every user turn counts; the review fires (and the counter resets) at 10. */
export const MEMORY_REVIEW_INTERVAL = 10;

// The memory pool is the one `createPgPool` caller that sits in the hot path
// of every `/api/chat` request (via prepareChatTurn's snapshot read) — see
// the comment on `createPgPool` in tracing/traceStore.ts for why this is
// opt-in rather than a blanket default. An unreachable Postgres must fail
// this pool fast so a user's turn degrades to memory-off instead of hanging.
const MEMORY_POOL_CONNECTION_TIMEOUT_MS = 5_000;

// A checked-out client is required, not optional: `SELECT … FOR UPDATE` only
// holds a lock for the transaction that took it, and BEGIN/COMMIT issued
// through a pool can land on different clients (this is exactly the trap
// documented in showcase/store.ts's pinScreen).
export interface MemoryQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface MemoryPool {
  connect(): Promise<MemoryQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export type AuditOrigin = "foreground" | "background_review" | "curator";

export interface AuditEntry {
  userId: string;
  origin: AuditOrigin;
  subsystem: "memory" | "skill";
  action: string;
  payload: Record<string, unknown>;
}

export interface ReviewCounters {
  turnsSinceMemory: number;
  stepsSinceSkill: number;
  memoryReviewDue: boolean;
}

/** A single audited write, summarized for UI display — never carries entry
 * contents (see agent_selfimprove_audit.payload, which this deliberately
 * omits). `id` is the bigserial audit row id. */
export interface AuditActivityEvent {
  id: number;
  subsystem: "memory" | "skill";
  action: string;
  origin: AuditOrigin;
  createdAt: string;
}

export interface AuditActivityResult {
  events: AuditActivityEvent[];
  latestId: number | null;
}

export interface MemoryStore {
  loadSnapshot(userId: string): Promise<MemorySnapshot>;
  applyOperations(input: {
    userId: string;
    target: MemoryTarget;
    operations: MemoryOperation[];
    origin: AuditOrigin;
  }): Promise<MemoryApplyOutcome>;
  bumpCounters(input: {
    userId: string;
    turns: number;
    steps: number;
    memoryInterval: number;
  }): Promise<ReviewCounters>;
  writeAudit(entry: AuditEntry): Promise<void>;
  /**
   * Read-only summary of a user's audit trail for the UI-visibility toast
   * (self-improvement-loop spec, "UI visibility"). Baseline mode
   * (`sinceId` omitted) returns no events, only the current max id to anchor
   * future polls against. `latestId` is always the user's overall max id,
   * not just the max among the returned `events` — a caller catching up
   * across more than `limit` new rows still learns where the tail is.
   */
  listAuditActivity(input: {
    userId: string;
    sinceId?: number;
    limit?: number;
  }): Promise<AuditActivityResult>;
  /** Users with any stored memory, most recently updated first — the
   * discovery step for `memory:curate --list` (there is otherwise no index
   * of user ids to inspect). */
  listUsers(limit: number): Promise<Array<{ userId: string; updatedAt: string }>>;
  /**
   * Wipes both targets for a user in one transaction and writes a single
   * audit row (curator CLI's "clear a user's memory entirely"). Unlike
   * `applyOperations`, which needs a unique `old_text` per entry, this is a
   * blunt full reset — the CLI's confirmation step is what makes that safe.
   * Returns how many entries were cleared from each target, for the CLI to
   * report; a user with nothing stored yields `{ memory: 0, user: 0 }`
   * without erroring.
   */
  clearUser(userId: string, origin: AuditOrigin): Promise<{ memory: number; user: number }>;
  close(): Promise<void>;
}

const AUDIT_ACTIVITY_LIMIT = 50;

function toEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// Single INSERT path for the audit table, shared by the standalone
// `writeAudit` (runs on the pool) and `applyOperations` (must run on the
// checked-out transaction client, per the class comment above — a pool-level
// query here would land on a different connection and commit outside the
// transaction). Both callers satisfy this minimal query surface, so one
// function serves either.
async function insertAuditRow(
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  entry: AuditEntry,
): Promise<void> {
  await db.query(
    `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [entry.userId, entry.origin, entry.subsystem, entry.action, JSON.stringify(entry.payload)],
  );
}

export function createMemoryStore(
  config: Config,
  pool?: MemoryPool,
): MemoryStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: MemoryPool =
    pool ??
    (createPgPool(config.TRACE_DATABASE_URL, {
      connectionTimeoutMillis: MEMORY_POOL_CONNECTION_TIMEOUT_MS,
    }) as unknown as MemoryPool);

  const writeAudit = (entry: AuditEntry): Promise<void> => insertAuditRow(db, entry);

  return {
    async loadSnapshot(userId) {
      const result = (await db.query(
        "SELECT target, entries FROM agent_memory WHERE user_id = $1",
        [userId],
      )) as { rows: Array<{ target: MemoryTarget; entries: unknown }> };
      // Fresh arrays, not a shallow spread of the shared module constant —
      // `{ ...EMPTY_MEMORY_SNAPSHOT }` copies the object but not its `memory`/
      // `user` arrays, so every caller with no row for a target would get the
      // SAME array instance back and could mutate the module-level default.
      const snapshot: MemorySnapshot = { memory: [], user: [] };
      for (const row of result.rows) {
        if (row.target === "memory" || row.target === "user") {
          snapshot[row.target] = toEntries(row.entries);
        }
      }
      return snapshot;
    },

    async applyOperations({ userId, target, operations, origin }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Materialize the row first: FOR UPDATE locks nothing on a row that
        // does not exist yet, so two concurrent first-writes would both read
        // an empty list and one would silently lose its entry.
        await client.query(
          `INSERT INTO agent_memory (user_id, target) VALUES ($1, $2)
           ON CONFLICT (user_id, target) DO NOTHING`,
          [userId, target],
        );
        const read = (await client.query(
          "SELECT entries FROM agent_memory WHERE user_id = $1 AND target = $2 FOR UPDATE",
          [userId, target],
        )) as { rows: Array<{ entries: unknown }> };
        const current = toEntries(read.rows[0]?.entries);

        const outcome = applyMemoryOperations(current, operations, target);
        if (!outcome.ok) {
          await client.query("ROLLBACK");
          return outcome;
        }

        await client.query(
          "UPDATE agent_memory SET entries = $3::jsonb, updated_at = now() WHERE user_id = $1 AND target = $2",
          [userId, target, JSON.stringify(outcome.entries)],
        );
        await insertAuditRow(client, {
          userId,
          origin,
          subsystem: "memory",
          action: operations.map((op) => op.action).join("+"),
          payload: {
            target,
            operations,
            entryCount: outcome.entries.length,
            usage: outcome.usage,
          },
        });
        await client.query("COMMIT");
        return outcome;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction is already dead; the original error is what matters.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async bumpCounters({ userId, turns, steps, memoryInterval }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO agent_review_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
          [userId],
        );
        await client.query(
          "SELECT user_id FROM agent_review_state WHERE user_id = $1 FOR UPDATE",
          [userId],
        );
        const updated = (await client.query(
          `UPDATE agent_review_state
              SET turns_since_memory = turns_since_memory + $2,
                  steps_since_skill  = steps_since_skill + $3,
                  updated_at = now()
            WHERE user_id = $1
        RETURNING turns_since_memory, steps_since_skill`,
          [userId, turns, steps],
        )) as { rows: Array<{ turns_since_memory: number; steps_since_skill: number }> };

        const turnsSinceMemory = Number(updated.rows[0].turns_since_memory);
        const stepsSinceSkill = Number(updated.rows[0].steps_since_skill);
        const memoryReviewDue = turnsSinceMemory >= memoryInterval;

        // Reset inside the same transaction that observed the threshold, so
        // two concurrent requests can never both fire the review.
        if (memoryReviewDue) {
          await client.query(
            "UPDATE agent_review_state SET turns_since_memory = 0 WHERE user_id = $1",
            [userId],
          );
        }
        await client.query("COMMIT");
        return { turnsSinceMemory, stepsSinceSkill, memoryReviewDue };
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // See applyOperations.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    writeAudit,

    async listAuditActivity({ userId, sinceId, limit = AUDIT_ACTIVITY_LIMIT }) {
      const maxResult = (await db.query(
        "SELECT MAX(id) AS max_id FROM agent_selfimprove_audit WHERE user_id = $1",
        [userId],
      )) as { rows: Array<{ max_id: string | number | null }> };
      const rawMaxId = maxResult.rows[0]?.max_id;
      // pg returns bigint columns (bigserial's underlying type) as strings to
      // avoid silent precision loss beyond 2^53 — audit ids never realistically
      // reach that, so a plain Number() coercion is safe and gives callers a
      // real JSON number rather than a string they'd have to parse themselves.
      const latestId = rawMaxId === null || rawMaxId === undefined ? null : Number(rawMaxId);

      if (sinceId === undefined) {
        return { events: [], latestId };
      }

      const rows = (await db.query(
        `SELECT id, subsystem, action, origin, created_at
           FROM agent_selfimprove_audit
          WHERE user_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [userId, sinceId, limit],
      )) as {
        rows: Array<{
          id: string | number;
          subsystem: "memory" | "skill";
          action: string;
          origin: AuditOrigin;
          created_at: string | Date;
        }>;
      };

      const events: AuditActivityEvent[] = rows.rows.map((row) => ({
        id: Number(row.id),
        subsystem: row.subsystem,
        action: row.action,
        origin: row.origin,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }));

      return { events, latestId };
    },

    async listUsers(limit) {
      const result = (await db.query(
        `SELECT user_id, MAX(updated_at) AS updated_at
           FROM agent_memory
          GROUP BY user_id
          ORDER BY updated_at DESC
          LIMIT $1`,
        [limit],
      )) as { rows: Array<{ user_id: string; updated_at: string | Date }> };
      return result.rows.map((row) => ({
        userId: row.user_id,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
    },

    async clearUser(userId, origin) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const read = (await client.query(
          "SELECT target, entries FROM agent_memory WHERE user_id = $1 FOR UPDATE",
          [userId],
        )) as { rows: Array<{ target: MemoryTarget; entries: unknown }> };
        const counts = { memory: 0, user: 0 };
        for (const row of read.rows) {
          if (row.target === "memory" || row.target === "user") {
            counts[row.target] = toEntries(row.entries).length;
          }
        }
        await client.query(
          "UPDATE agent_memory SET entries = '[]'::jsonb, updated_at = now() WHERE user_id = $1",
          [userId],
        );
        await insertAuditRow(client, {
          userId,
          origin,
          subsystem: "memory",
          action: "clear",
          payload: { counts },
        });
        await client.query("COMMIT");
        return counts;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // See applyOperations.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    close: () => db.end(),
  };
}
