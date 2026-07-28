import type { Config } from "./config.js";
import { createPgPool } from "./tracing/traceStore.js";
import { migrate, type QueryClient } from "./analysis/migrate.js";

// Until now, schema_migrations only ever ran from CLI entrypoints
// (`npm run analyze`, the showcase scripts via `openShowcaseContext`) — the
// HTTP server itself never touched Postgres schema. That was fine while every
// route only ever wrote rows into tables that already existed. It stopped
// being fine the moment a migration added a column a route *reads*
// (`pinned_at` for `GET /api/showcase`, migration `004_showcase_pin.sql`):
// deploying the code without separately remembering to run the CLI migrator
// would 500 the whole showcase gallery until someone noticed and ran it by
// hand. Running migrations at server startup closes that gap for good.

interface MigrationClient {
  query: QueryClient["query"];
  release(): void;
}

interface MigrationPool {
  connect(): Promise<MigrationClient>;
  end(): Promise<void>;
}

export interface StartupMigrationsDeps {
  createPool: (connectionString: string) => MigrationPool;
  migrate: (client: QueryClient) => Promise<string[]>;
}

const defaultDeps: StartupMigrationsDeps = {
  createPool: (connectionString) => createPgPool(connectionString),
  migrate,
};

// Postgres is optional for the server as a whole — chat and every other
// route work fine without TRACE_DATABASE_URL, only the showcase gallery
// degrades. So a migration failure here (bad creds, unreachable host, a
// broken migration file) must never prevent the server from listening: we
// log it loudly and move on, rather than letting `await` propagate into a
// crashed startup. The pool is created solely to run migrations and must not
// linger past this call, or every deploy would leak a Postgres connection
// that no route ever uses again.
export async function applyStartupMigrations(
  config: Config,
  deps: StartupMigrationsDeps = defaultDeps,
): Promise<void> {
  if (!config.TRACE_DATABASE_URL) return;

  let pool: MigrationPool | undefined;
  try {
    pool = deps.createPool(config.TRACE_DATABASE_URL);
    const client = await pool.connect();
    try {
      const applied = await deps.migrate(client);
      if (applied.length) {
        console.log(`[startup] applied migrations: ${applied.join(", ")}`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[startup] failed to apply migrations — continuing without them:", err);
  } finally {
    try {
      await pool?.end();
    } catch (err) {
      console.error("[startup] failed to close migration pool:", err);
    }
  }
}
