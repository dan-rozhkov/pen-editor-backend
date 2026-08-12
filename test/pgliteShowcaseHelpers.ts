// Real-Postgres-engine backing for showcase store tests (see
// showcase-store-pglite.test.ts). Everything else in showcase-store.test.ts
// runs against `fakePool` — a JS interpreter of the store's own SQL — which
// cannot catch a query that is syntactically fine but semantically illegal
// (e.g. an ambiguous column reference after a JOIN). PGlite runs the real
// Postgres query planner/executor, so it catches that class of bug.
import { PGlite } from "@electric-sql/pglite";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/analysis/migrate.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/analysis/migrations",
);

// `001_init.sql` starts with `CREATE EXTENSION IF NOT EXISTS vector;` —
// pgvector is not one of the extensions PGlite ships (its `dist/contrib`
// has no vector.*), so that statement fails outright, and `002_insights.sql`
// only exists to add a table that references `001`'s `session_summaries`.
// Neither table is reachable from anything showcase-related (`showcase_*`
// tables have no FK to them), so excluding these two by name — while still
// applying every other migration file's exact, unmodified bytes — gets a
// real schema for what this suite actually exercises without inventing a
// hand-rolled DDL substitute for the part PGlite can't run. If PGlite ever
// ships pgvector this allowlist can just be dropped.
const SKIP_MIGRATIONS = new Set(["001_init.sql", "002_insights.sql"]);

// `migrate()` (src/analysis/migrate.ts) issues both plain multi-statement
// SQL (schema_migrations bootstrap, each migration file's body, BEGIN/
// COMMIT/ROLLBACK — always called as `client.query(sql)`, no params) and
// parameterized single statements (the schema_migrations existence check
// and insert — always called with a `params` array, even if `[]`). PGlite's
// `query()` uses the extended/prepared-statement protocol, which — like real
// Postgres — rejects multiple statements in one prepare ("cannot insert
// multiple commands into a prepared statement"); its `exec()` uses the
// simple query protocol instead, which allows multiple statements but takes
// no params. `migrate()` and every store method only ever call one shape or
// the other, never both in a way that needs one call site to switch — so
// dispatching on "was `params` passed at all" reproduces `pg.Pool.query`'s
// behavior (which papers over this distinction) without forking any of the
// call sites in `migrate.ts` or `store.ts`.
function adaptPglite(db: PGlite): TraceQueryable {
  return {
    async query(sql: string, params?: unknown[]) {
      if (params === undefined) {
        await db.exec(sql);
        return { rows: [] };
      }
      const result = await db.query(sql, params);
      return { rows: result.rows };
    },
    async end() {
      await db.close();
    },
  };
}

export interface PgliteQueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

// Pool-shaped view over the single PGlite instance. PGlite is one connection,
// so BEGIN/COMMIT issued through `connect()` can never straddle two clients —
// which is exactly what makes it a valid stand-in for the `SELECT … FOR UPDATE`
// transactions the memory store runs against a real pg.Pool.
export interface PglitePool {
  connect(): Promise<PgliteQueryClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface PgliteHarness {
  db: TraceQueryable;
  pool: PglitePool;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Boots a fresh in-memory PGlite instance and applies the real migrations
 * against it once. `reset()` truncates `truncateTables` without paying the
 * migration cost again. */
export async function createPgliteHarness(
  truncateTables: string[],
): Promise<PgliteHarness> {
  const pglite = new PGlite();
  const db = adaptPglite(pglite);

  const allFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const files = allFiles.filter((f) => !SKIP_MIGRATIONS.has(f));
  const dir = await mkdtemp(join(tmpdir(), "pglite-migrations-"));
  for (const file of files) {
    await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
  }
  await migrate(db, dir);

  const client: PgliteQueryClient = {
    query: (sql, params) => db.query(sql, params) as Promise<{ rows: unknown[] }>,
    release: () => {},
  };

  return {
    db,
    pool: {
      connect: async () => client,
      query: (sql, params) => db.query(sql, params) as Promise<{ rows: unknown[] }>,
      end: () => db.end(),
    },
    async reset() {
      if (truncateTables.length === 0) return;
      await pglite.exec(
        `TRUNCATE TABLE ${truncateTables.join(", ")} RESTART IDENTITY CASCADE`,
      );
    },
    async close() {
      await pglite.close();
    },
  };
}

export type PgliteShowcaseHarness = PgliteHarness;

export function createPgliteShowcaseHarness(): Promise<PgliteShowcaseHarness> {
  return createPgliteHarness(["showcase_screens", "showcase_app_likes"]);
}
