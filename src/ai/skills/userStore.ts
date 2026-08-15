// All SQL against `user_skills` — the per-user counterpart to
// `agent_skills`/learnedStore.ts. Mirrors that module's shape closely (a
// pool-shaped dependency injectable by tests, a plain object implementing
// the store interface, one module-level singleton for production wiring)
// because the two stores play the same role at different scopes: learned
// skills are global (one agent, one design domain), user skills are scoped
// to `user_id` (Figma-style "your own skills", never authenticated — same
// trust model `agent_memory` already established).
import { createPgPool } from "../../tracing/traceStore.js";

export interface UserSkill {
  userId: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: "manual" | "upload" | "generated";
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserSkillRow {
  user_id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: string;
  use_count: number | string;
  last_used_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toSkill(row: UserSkillRow): UserSkill {
  return {
    userId: row.user_id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    source: row.source as UserSkill["source"],
    // pg (and PGlite) return int4 columns as JS numbers, but coerce
    // defensively in case a driver ever returns them as strings (as it does
    // for bigint) — same defensiveness as learnedStore.ts's toSkill.
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const SELECT_COLUMNS =
  "user_id, name, description, body, enabled, source, use_count, last_used_at, created_at, updated_at";

export interface UserSkillsPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// Same reasoning as SKILLS_POOL_CONNECTION_TIMEOUT_MS in learnedStore.ts:
// the enabled-skills read runs on every prepared chat turn for a user with
// any custom skills, so this pool sits in the hot path too. An unreachable
// Postgres must fail fast so a turn degrades to "no user skills" instead of
// hanging /api/chat.
const USER_SKILLS_POOL_CONNECTION_TIMEOUT_MS = 5_000;

// Thrown by create()/update() on a Postgres unique_violation (23505) against
// the (user_id, name) primary key, translated into a typed error so callers
// (the route layer, once it lands) can map it to a 409 without inspecting a
// raw pg error code themselves. Distinct from learnedStore's create(), which
// has no caller-facing rename path — update() here can ALSO hit this when
// `newName` collides with an existing row for the same user.
export class UserSkillExistsError extends Error {
  constructor(public readonly name: string) {
    super(`A skill named "${name}" already exists for this user.`);
    this.name = "UserSkillExistsError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface UserSkillStore {
  /** All of this user's skills, newest-updated first. */
  list(userId: string): Promise<UserSkill[]>;
  /** Enabled-only subset, same order — what a chat turn actually loads. */
  listEnabled(userId: string): Promise<UserSkill[]>;
  get(userId: string, name: string): Promise<UserSkill | null>;
  create(input: {
    userId: string;
    name: string;
    description: string;
    body: string;
    source: UserSkill["source"];
  }): Promise<UserSkill>;
  update(
    userId: string,
    name: string,
    patch: { newName?: string; description?: string; body?: string; enabled?: boolean },
  ): Promise<UserSkill | null>;
  remove(userId: string, name: string): Promise<boolean>;
  bumpUse(userId: string, name: string): Promise<void>;
  /** Row count for this user — the max-50-per-user cap's precondition. */
  count(userId: string): Promise<number>;
  /** Mirrors LearnedSkillStore/TraceStore/MemoryStore's `close()` — buildApp
   * (src/app.ts) hangs this off an `onClose` hook so the pool this store
   * opened actually gets torn down when the Fastify instance does. */
  close(): Promise<void>;
}

export function createUserSkillStore(
  connectionString: string | undefined,
  pool?: UserSkillsPool,
): UserSkillStore | null {
  if (!pool && !connectionString) return null;
  const db: UserSkillsPool =
    pool ??
    (createPgPool(connectionString!, {
      connectionTimeoutMillis: USER_SKILLS_POOL_CONNECTION_TIMEOUT_MS,
    }) as unknown as UserSkillsPool);
  // getSharedUserSkillStore below caches this store by connection string, so
  // more than one buildApp() instance can end up owning the SAME store
  // object (production never does this — one process, one buildApp() call —
  // but any test file that builds+closes several apps against the same
  // TRACE_DATABASE_URL does). Each owner's onClose hook calls close()
  // independently, and unlike this store's own no-op-on-a-missing-row
  // methods, a real pg.Pool's end() throws ("Called end on pool more than
  // once") the second time — so this flag is what actually makes repeated
  // closes the harmless no-op the sibling stores' comments already assume.
  let closed = false;

  return {
    async list(userId) {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM user_skills WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId],
      )) as { rows: UserSkillRow[] };
      return result.rows.map(toSkill);
    },

    async listEnabled(userId) {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM user_skills
          WHERE user_id = $1 AND enabled = TRUE
          ORDER BY updated_at DESC`,
        [userId],
      )) as { rows: UserSkillRow[] };
      return result.rows.map(toSkill);
    },

    async get(userId, name) {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM user_skills WHERE user_id = $1 AND name = $2`,
        [userId, name],
      )) as { rows: UserSkillRow[] };
      return result.rows[0] ? toSkill(result.rows[0]) : null;
    },

    async create({ userId, name, description, body, source }) {
      // No ON CONFLICT: a name collision here means either the route layer's
      // own pre-check (count()/get()) raced with another writer, or was
      // skipped — either way the loser must error, not silently overwrite
      // the winner's skill. Same stance as learnedStore.ts's create().
      try {
        const result = (await db.query(
          `INSERT INTO user_skills (user_id, name, description, body, source)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${SELECT_COLUMNS}`,
          [userId, name, description, body, source],
        )) as { rows: UserSkillRow[] };
        return toSkill(result.rows[0]);
      } catch (err) {
        if (isUniqueViolation(err)) throw new UserSkillExistsError(name);
        throw err;
      }
    },

    async update(userId, name, patch) {
      // A single guarded UPDATE, not SELECT-then-UPDATE: the WHERE clause is
      // itself the existence check, so there's no read-then-write gap for a
      // concurrent delete to land in — same shape as learnedStore.ts's
      // reviveArchived. COALESCE lets an omitted patch field pass through
      // unchanged rather than requiring the caller to re-supply every column
      // on every partial edit.
      try {
        const result = (await db.query(
          `UPDATE user_skills
              SET name = COALESCE($3, name),
                  description = COALESCE($4, description),
                  body = COALESCE($5, body),
                  enabled = COALESCE($6, enabled),
                  updated_at = now()
            WHERE user_id = $1 AND name = $2
          RETURNING ${SELECT_COLUMNS}`,
          [userId, name, patch.newName ?? null, patch.description ?? null, patch.body ?? null, patch.enabled ?? null],
        )) as { rows: UserSkillRow[] };
        return result.rows[0] ? toSkill(result.rows[0]) : null;
      } catch (err) {
        // A rename (`newName`) colliding with another row this same user
        // already owns is the one way this UPDATE can hit the (user_id,
        // name) primary key — create()'s pre-check has no equivalent here
        // since the conflicting row isn't the one being written.
        if (isUniqueViolation(err)) throw new UserSkillExistsError(patch.newName ?? name);
        throw err;
      }
    },

    async remove(userId, name) {
      const result = (await db.query(
        "DELETE FROM user_skills WHERE user_id = $1 AND name = $2 RETURNING name",
        [userId, name],
      )) as { rows: unknown[] };
      return result.rows.length > 0;
    },

    async bumpUse(userId, name) {
      // use_count = use_count + 1 computed server-side in one statement, so
      // Postgres's own row lock makes this atomic without a transaction —
      // same as learnedStore.ts's bumpUse (minus the stale/state revival,
      // which user_skills has no equivalent state machine for).
      await db.query(
        `UPDATE user_skills
            SET use_count = use_count + 1, last_used_at = now()
          WHERE user_id = $1 AND name = $2`,
        [userId, name],
      );
    },

    async count(userId) {
      const result = (await db.query(
        "SELECT count(*)::int AS count FROM user_skills WHERE user_id = $1",
        [userId],
      )) as { rows: Array<{ count: number | string }> };
      return Number(result.rows[0]?.count ?? 0);
    },

    async close() {
      if (closed) return;
      closed = true;
      await db.end();
    },
  };
}

// One pool per process, not per request — same reasoning as
// getSharedLearnedSkillStore in learnedStore.ts. Keyed by connection string
// so a config change (only ever seen in tests, which rebuild Config per
// case) creates a fresh pool rather than reusing one pointed at a different
// database.
let shared: { url: string; store: UserSkillStore } | null = null;

export function getSharedUserSkillStore(url: string | undefined): UserSkillStore | null {
  if (!url) return null;
  if (shared?.url === url) return shared.store;
  if (shared) {
    // A URL change only happens in tests that rebuild Config per case
    // (production never changes TRACE_DATABASE_URL mid-process) — but
    // without this, the old store's pool is simply overwritten and never
    // closed, leaking one pg.Pool per case across a test file with many
    // `it`s. Fire-and-forget: nothing here can block returning the new
    // store, and a close failure is not actionable beyond logging it.
    shared.store.close().catch((err) => {
      console.error("[user-skills] failed to close previous user-skill pool:", err);
    });
  }
  const store = createUserSkillStore(url);
  if (!store) return null;
  shared = { url, store };
  return store;
}

/** Test-only: drops the module-level singleton pool so the next
 * getSharedUserSkillStore call builds a fresh one against a fresh config. */
export function __resetSharedUserSkillStore(): void {
  shared = null;
}
