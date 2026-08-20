// All SQL against `shared_canvases`. Mirrors userStore.ts's shape (a
// pool-shaped dependency injectable by tests, a plain object implementing
// the store interface, one module-level singleton for production wiring) —
// same trust model too: `ownerId` is the anonymous, shape-checked
// `pen.userId`, never authenticated. The one thing this store adds that
// userStore.ts doesn't need is a *second* secret per row (`editToken`):
// unlike a user's own skills (gated only by knowing their own userId),
// anyone with a share link's id can read a canvas, so update/remove must be
// gated by something the id alone doesn't grant.
import { createPgPool } from "../tracing/traceStore.js";

export interface SharedCanvas {
  id: string;
  ownerId: string;
  title: string;
  document: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SharedCanvasRow {
  id: string;
  owner_id: string;
  title: string;
  document: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function toCanvas(row: SharedCanvasRow): SharedCanvas {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    document: row.document,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// Never selected by get()/the public read path — edit_token must not leave
// this module except via update()/remove()'s own WHERE clause matching.
const PUBLIC_COLUMNS = "id, owner_id, title, document, created_at, updated_at";

export interface SharedCanvasPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// Same reasoning as USER_SKILLS_POOL_CONNECTION_TIMEOUT_MS in userStore.ts —
// a share create/update sits in the request path of a user action, so an
// unreachable Postgres must fail fast rather than hang the request.
const SHARED_CANVAS_POOL_CONNECTION_TIMEOUT_MS = 5_000;

export interface SharedCanvasStore {
  insert(input: {
    id: string;
    ownerId: string;
    editToken: string;
    title: string;
    document: string;
  }): Promise<void>;
  /** Public read — never returns edit_token. */
  get(id: string): Promise<SharedCanvas | null>;
  /** Number of rows owned by ownerId — the route checks this against its
   * per-owner cap before an insert only (never before an update, which
   * overwrites an existing row and adds no new one). */
  countByOwner(ownerId: string): Promise<number>;
  /** Returns null when the id doesn't exist OR the token doesn't match;
   * otherwise the row's real `updated_at` as Postgres wrote it (read off
   * the UPDATE's own RETURNING), not a value invented by the caller. */
  update(input: {
    id: string;
    editToken: string;
    title: string;
    document: string;
  }): Promise<Date | null>;
  /** Returns false when the id doesn't exist OR the token doesn't match. */
  remove(id: string, editToken: string): Promise<boolean>;
  /** Mirrors UserSkillStore/TraceStore/MemoryStore's `close()` — buildApp
   * (src/app.ts) hangs this off an `onClose` hook so the pool this store
   * opened actually gets torn down when the Fastify instance does. */
  close(): Promise<void>;
}

export function createSharedCanvasStore(
  connectionString: string | undefined,
  pool?: SharedCanvasPool,
): SharedCanvasStore | null {
  if (!pool && !connectionString) return null;
  const db: SharedCanvasPool =
    pool ??
    (createPgPool(connectionString!, {
      connectionTimeoutMillis: SHARED_CANVAS_POOL_CONNECTION_TIMEOUT_MS,
    }) as unknown as SharedCanvasPool);
  // Same closed-flag reasoning as userStore.ts's createUserSkillStore: more
  // than one buildApp() instance can end up owning the SAME store object
  // (getSharedSharedCanvasStore below caches by connection string), and a
  // real pg.Pool's end() throws the second time it's called.
  let closed = false;

  return {
    async insert({ id, ownerId, editToken, title, document }) {
      await db.query(
        `INSERT INTO shared_canvases (id, owner_id, edit_token, title, document)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ownerId, editToken, title, document],
      );
    },

    async get(id) {
      const result = (await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM shared_canvases WHERE id = $1`,
        [id],
      )) as { rows: SharedCanvasRow[] };
      return result.rows[0] ? toCanvas(result.rows[0]) : null;
    },

    async countByOwner(ownerId) {
      const result = (await db.query(
        "SELECT count(*)::int AS count FROM shared_canvases WHERE owner_id = $1",
        [ownerId],
      )) as { rows: Array<{ count: number }> };
      return result.rows[0]?.count ?? 0;
    },

    async update({ id, editToken, title, document }) {
      // A single guarded UPDATE, not SELECT-then-UPDATE, and the token match
      // lives in the WHERE clause itself — never compared in JS — so the
      // secret never leaves Postgres and there's no read-then-write gap for
      // a concurrent unshare to land in. Same shape as userStore.ts's
      // update().
      const result = (await db.query(
        `UPDATE shared_canvases
            SET title = $3,
                document = $4,
                updated_at = now()
          WHERE id = $1 AND edit_token = $2
          RETURNING updated_at`,
        [id, editToken, title, document],
      )) as { rows: Array<{ updated_at: string | Date }> };
      const row = result.rows[0];
      return row ? new Date(row.updated_at) : null;
    },

    async remove(id, editToken) {
      const result = (await db.query(
        "DELETE FROM shared_canvases WHERE id = $1 AND edit_token = $2 RETURNING id",
        [id, editToken],
      )) as { rows: unknown[] };
      return result.rows.length > 0;
    },

    async close() {
      if (closed) return;
      closed = true;
      await db.end();
    },
  };
}

// One pool per process, not per request — same reasoning as
// getSharedUserSkillStore in userStore.ts. Keyed by connection string so a
// config change (only ever seen in tests, which rebuild Config per case)
// creates a fresh pool rather than reusing one pointed at a different
// database.
let shared: { url: string; store: SharedCanvasStore } | null = null;

export function getSharedCanvasStore(url: string | undefined): SharedCanvasStore | null {
  if (!url) return null;
  if (shared?.url === url) return shared.store;
  if (shared) {
    // A URL change only happens in tests that rebuild Config per case
    // (production never changes TRACE_DATABASE_URL mid-process) — without
    // this, the old store's pool is simply overwritten and never closed,
    // leaking one pg.Pool per case across a test file with many `it`s.
    // Fire-and-forget: nothing here can block returning the new store, and a
    // close failure is not actionable beyond logging it.
    shared.store.close().catch((err) => {
      console.error("[shared-canvas] failed to close previous pool:", err);
    });
  }
  const store = createSharedCanvasStore(url);
  if (!store) return null;
  shared = { url, store };
  return store;
}

/** Test-only: drops the module-level singleton pool so the next
 * getSharedCanvasStore call builds a fresh one against a fresh config. */
export function __resetSharedCanvasStore(): void {
  shared = null;
}
