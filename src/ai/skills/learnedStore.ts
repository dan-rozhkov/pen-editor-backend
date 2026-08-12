// All SQL against `agent_skills` (Phase 2 of the self-improvement loop),
// plus a short-lived in-process cache of the "active" catalog that
// `prepareChatTurn` merges into the system prompt on every turn (see
// `getLearnedCatalog`). Mirrors the shape of `src/ai/memory/store.ts`
// (Phase 1): a pool-shaped dependency injectable by tests, a plain object
// implementing the store interface, and one module-level singleton for
// production wiring.
import type { Config } from "../../config.js";
import { createPgPool } from "../../tracing/traceStore.js";

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  createdBy: string;
  state: "active" | "stale" | "archived";
  useCount: number;
  viewCount: number;
}

interface SkillRow {
  name: string;
  description: string;
  body: string;
  created_by: string;
  state: string;
  use_count: number | string;
  view_count: number | string;
}

function toSkill(row: SkillRow): LearnedSkill {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    createdBy: row.created_by,
    state: row.state as LearnedSkill["state"],
    // pg (and PGlite) return int4 columns as JS numbers, but coerce defensively
    // in case a driver ever returns them as strings (as it does for bigint).
    useCount: Number(row.use_count),
    viewCount: Number(row.view_count),
  };
}

const SELECT_COLUMNS =
  "name, description, body, created_by, state, use_count, view_count";

// A checked-out client is required (not just query()) for replaceBody's
// SELECT ... FOR UPDATE transaction: BEGIN/COMMIT issued through a pool can
// land on different physical connections, which would make FOR UPDATE lock
// nothing. Same trap documented on MemoryQueryClient in ai/memory/store.ts.
export interface LearnedSkillsQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface LearnedSkillsPool {
  connect(): Promise<LearnedSkillsQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// Same reasoning as MEMORY_POOL_CONNECTION_TIMEOUT_MS in ai/memory/store.ts:
// getLearnedCatalog() runs on every prepared chat turn (via prepareChatTurn),
// so this pool sits in the hot path too. An unreachable Postgres must fail
// fast so a turn degrades to "no learned skills" instead of hanging.
const SKILLS_POOL_CONNECTION_TIMEOUT_MS = 5_000;

export interface LearnedSkillStore {
  listActive(): Promise<LearnedSkill[]>;
  get(name: string): Promise<LearnedSkill | null>;
  create(input: { name: string; description: string; body: string }): Promise<void>;
  /** Overwrites description/body and brings an archived, agent-authored row
   * back to `active` with a fresh `last_used_at` — the recovery path for
   * `skill_manage`'s `create` action landing on a name an earlier archival
   * left behind (see tool.ts). `name` is a primary key and archived rows are
   * never deleted (curate.ts), so a plain INSERT on that name always fails;
   * this is what makes `create` on an archived name resurrect it instead of
   * dead-ending in "already exists, use patch" forever, since `patch` alone
   * can never change `state`. Returns false — not an error — when the row
   * isn't archived, isn't agent-created, or no longer exists by the time this
   * runs; the caller falls back to its normal already-exists handling either
   * way. Optional on the interface so the many hand-rolled `LearnedSkillStore`
   * test doubles that predate this method don't all need updating — every
   * real (production or PGlite-backed) store below implements it. */
  reviveArchived?(
    name: string,
    input: { description: string; body: string },
  ): Promise<boolean>;
  replaceBody(name: string, body: string): Promise<void>;
  remove(name: string): Promise<boolean>;
  bumpUse(name: string): Promise<void>;
  bumpView(name: string): Promise<void>;
  /** Mirrors TraceStore/MemoryStore/ShowcaseStore's `close()` — buildApp
   * (src/app.ts) hangs this off an `onClose` hook so the pool this store
   * opened actually gets torn down when the Fastify instance does. */
  close(): Promise<void>;
}

export function createLearnedSkillStore(
  config: Config,
  pool?: LearnedSkillsPool,
): LearnedSkillStore | null {
  if (!pool && !config.TRACE_DATABASE_URL) return null;
  const db: LearnedSkillsPool =
    pool ??
    (createPgPool(config.TRACE_DATABASE_URL!, {
      connectionTimeoutMillis: SKILLS_POOL_CONNECTION_TIMEOUT_MS,
    }) as unknown as LearnedSkillsPool);

  return {
    async listActive() {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM agent_skills WHERE state = 'active' ORDER BY name`,
        [],
      )) as { rows: SkillRow[] };
      return result.rows.map(toSkill);
    },

    async get(name) {
      const result = (await db.query(
        `SELECT ${SELECT_COLUMNS} FROM agent_skills WHERE name = $1`,
        [name],
      )) as { rows: SkillRow[] };
      return result.rows[0] ? toSkill(result.rows[0]) : null;
    },

    async create({ name, description, body }) {
      // No ON CONFLICT: a name collision here means either the tool layer's
      // own pre-check raced with another writer, or it was skipped — either
      // way the loser must error, not silently overwrite the winner's skill.
      await db.query(
        `INSERT INTO agent_skills (name, description, body, created_by)
         VALUES ($1, $2, $3, 'agent')`,
        [name, description, body],
      );
    },

    async reviveArchived(name, { description, body }) {
      // A single guarded UPDATE, not SELECT-then-UPDATE: the WHERE clause
      // itself is the check, so there is no read-then-write gap for a
      // concurrent writer to land in between (unlike replaceBody, which
      // needs the row's current body in application code before it can
      // compute a patched one — there's nothing to compute here, the new
      // description/body come from the caller whole).
      // `last_used_at = now()` matters as much as `state = 'active'`: without
      // it the row's idle clock still starts from its old (already
      // 90+-days-stale, by construction) last_used_at, and the very next
      // curate run would immediately re-archive it — making "revival" a
      // no-op in practice.
      const result = (await db.query(
        `UPDATE agent_skills
            SET description = $2, body = $3, state = 'active',
                last_used_at = now(), updated_at = now()
          WHERE name = $1 AND state = 'archived' AND created_by = 'agent'
        RETURNING name`,
        [name, description, body],
      )) as { rows: unknown[] };
      return result.rows.length > 0;
    },

    // Read-modify-write, so it goes through SELECT ... FOR UPDATE inside a
    // transaction per the spec's concurrency rule: the caller (skill_manage's
    // patch path) computed `body` from a body it read earlier — possibly
    // several tool calls ago — so between that read and this write the row
    // could have been deleted (or, with a future multi-writer, changed).
    // Locking-then-checking-existence here is what "a failed read cancels
    // the write" means for an UPDATE (whose bare form is a silent no-op on
    // a missing row rather than an error).
    async replaceBody(name, body) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const locked = (await client.query(
          "SELECT name FROM agent_skills WHERE name = $1 FOR UPDATE",
          [name],
        )) as { rows: unknown[] };
        if (locked.rows.length === 0) {
          throw new Error(
            `agent_skills: cannot patch "${name}" — it no longer exists (deleted concurrently).`,
          );
        }
        await client.query(
          "UPDATE agent_skills SET body = $2, updated_at = now() WHERE name = $1",
          [name, body],
        );
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Connection may already be aborted by the failed statement above;
          // there is nothing more to roll back.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async remove(name) {
      // A single DELETE ... RETURNING is already atomic at the row level —
      // no separate lock-then-delete transaction needed, unlike replaceBody
      // which reads a value in application code before writing a new one.
      const result = (await db.query(
        "DELETE FROM agent_skills WHERE name = $1 RETURNING name",
        [name],
      )) as { rows: unknown[] };
      return result.rows.length > 0;
    },

    async bumpUse(name) {
      // use_count = use_count + 1 is computed server-side in one statement,
      // so Postgres's own row lock makes this atomic without a transaction.
      //
      // A successful load is also what un-stales a skill: `state='stale'`
      // means "not recently used", and being used right now is precisely
      // what that state is measuring. Reviving here (rather than leaving the
      // row `stale` until the next curator run notices last_used_at moved)
      // is what makes the stale period an actual grace window instead of an
      // absorbing state a skill can only fall further from — see the
      // "one-way door" discussion at the top of src/ai/selfimprove/curate.ts.
      // `archived` is deliberately excluded from the CASE: this phase has no
      // unarchive path (see skill_manage's `create`-revives-archived path in
      // tool.ts for the one place archival IS reversible, and only there).
      await db.query(
        `UPDATE agent_skills
            SET use_count = use_count + 1,
                last_used_at = now(),
                state = CASE WHEN state = 'stale' THEN 'active' ELSE state END
          WHERE name = $1`,
        [name],
      );
    },

    async bumpView(name) {
      await db.query(
        "UPDATE agent_skills SET view_count = view_count + 1 WHERE name = $1",
        [name],
      );
    },

    async close() {
      await db.end();
    },
  };
}

// One pool per process, not per request: prepareChatTurn runs on every chat
// request, and a fresh pg.Pool per turn would leak connections until
// Postgres refuses new ones. Keyed by URL so a config change (only ever seen
// in tests, which rebuild Config per case) creates a fresh pool rather than
// reusing one pointed at a different database.
let shared: { url: string; store: LearnedSkillStore } | null = null;

export function getSharedLearnedSkillStore(config: Config): LearnedSkillStore | null {
  const url = config.TRACE_DATABASE_URL;
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
      console.error("[selfskills] failed to close previous learned-skill pool:", err);
    });
    // The catalog cache is keyed by store identity (see getLearnedCatalog
    // below) so a stale entry for the old store object is unreachable from
    // here on anyway, but drop it explicitly rather than leaving dead
    // weight in the Map for the lifetime of the process.
    catalogCacheByStore.delete(shared.store);
  }
  const store = createLearnedSkillStore(config);
  if (!store) return null;
  shared = { url, store };
  return store;
}

/** Test-only: drops the module-level singleton pool so the next
 * getSharedLearnedSkillStore call builds a fresh one against a fresh config. */
export function __resetSharedLearnedSkillStore(): void {
  shared = null;
}

// The catalog is read on every prepared turn but changes only when the agent
// itself writes a skill through skill_manage — rare, and always routed
// through this module. A short TTL bounds staleness from a write made by
// another process (a second server instance); invalidateLearnedCatalog()
// makes this process's own writes visible on the very next turn instead of
// waiting out the TTL.
const CATALOG_TTL_MS = 30_000;

// Keyed by STORE IDENTITY, not a single global slot: production only ever
// has one LearnedSkillStore alive at a time, but tests (and any process that
// rebuilds Config per case) construct multiple stores, sometimes pointed at
// different databases, in the same process. A single shared cache slot let
// getLearnedCatalog(storeB) return rows read through storeA — invisible in
// production, but in a multi-store process it meant skill_manage/load_skill
// resolved a name that had never actually been read from the store they
// were given, reporting "Unknown skill" for a row that really did exist.
// Keying by the store object itself makes each store's cache independent
// without needing a URL or other identifier LearnedSkillStore doesn't carry.
const catalogCacheByStore = new Map<LearnedSkillStore, { at: number; skills: LearnedSkill[] }>();

export async function getLearnedCatalog(
  store: LearnedSkillStore,
): Promise<LearnedSkill[]> {
  const cached = catalogCacheByStore.get(store);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.skills;
  }
  try {
    const skills = await store.listActive();
    catalogCacheByStore.set(store, { at: Date.now(), skills });
    return skills;
  } catch (err) {
    // A self-improvement read must never break a design turn: fall back to
    // the last known catalog (still better than nothing), or to none at all
    // if this is the very first read.
    console.error("[selfskills] catalog read failed:", (err as Error).message);
    return catalogCacheByStore.get(store)?.skills ?? [];
  }
}

/** Clears every store's cached catalog. Called with no store argument on
 * purpose: production only ever has one store alive, and a write through
 * skill_manage must be visible on the very next turn regardless of which
 * store reference happened to serve the read that populated the cache. */
export function invalidateLearnedCatalog(): void {
  catalogCacheByStore.clear();
}
