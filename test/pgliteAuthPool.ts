// A `pg.Pool`-shaped view over a PGlite instance, good enough for Better
// Auth's Kysely adapter (which only needs connect()/query()/release()/end()
// and detects a pool by the presence of `connect`). PGlite is one connection,
// so leases are serialized: a Kysely transaction holds the lease from BEGIN to
// COMMIT and nobody can interleave statements into it.
import type { PGlite } from "@electric-sql/pglite";

interface PoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number; command: string }>;
  release(): void;
}

export interface PgliteAuthPool {
  connect(): Promise<PoolClient>;
  query: PoolClient["query"];
  end(): Promise<void>;
}

export function createPgliteAuthPool(db: PGlite): PgliteAuthPool {
  let tail: Promise<void> = Promise.resolve();
  const run: PoolClient["query"] = async (sql, params) => {
    const result = await db.query(sql, params ?? []);
    return {
      rows: result.rows,
      rowCount: result.affectedRows ?? result.rows.length,
      command: sql.trimStart().split(/\s+/, 1)[0].toUpperCase(),
    };
  };
  return {
    async connect() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
      await previous;
      return { query: run, release };
    },
    query: run,
    end: () => db.close(),
  };
}
