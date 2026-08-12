import { loadConfig } from "../../config.js";
import { createPgPool } from "../../tracing/traceStore.js";
import { migrate } from "../../analysis/migrate.js";
import { hasFlag, readFlag } from "../../showcase/cliFlags.js";
import { runAsScript } from "../../showcase/cli.js";
import { createMemoryStore } from "./store.js";
import { resolveCuratorAction, runCuratorAction } from "./curator.js";
import type { MemoryTarget } from "./types.js";

// CLI entrypoint for `npm run memory:curate` — the repair path for
// persistent memory (see curator.ts). Only needs TRACE_DATABASE_URL, same as
// `showcase:pin`/`showcase:delete`: no S3, no LLM. Deliberately does NOT
// check MEMORY_ENABLED — a curator fixing a stuck entry needs this to work
// even while the feature flag is off for new writes.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const user = readFlag(argv, "user");
  const target = readFlag(argv, "target") as MemoryTarget | undefined;
  const entry = readFlag(argv, "entry");
  const limitFlag = readFlag(argv, "limit");

  const action = resolveCuratorAction({
    user,
    target,
    entry,
    clear: argv.includes("--clear"),
    listUsers: hasFlag(argv, "list-users"),
    limit: limitFlag ? Number(limitFlag) : undefined,
    dryRun: argv.includes("--dry-run"),
  });

  const config = loadConfig();
  if (!config.TRACE_DATABASE_URL) {
    console.error("[memory:curate] TRACE_DATABASE_URL is required");
    process.exit(1);
  }

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const migrationClient = await pool.connect();
  try {
    const applied = await migrate(migrationClient);
    if (applied.length) {
      console.log(`[memory:curate] applied migrations: ${applied.join(", ")}`);
    }
  } finally {
    migrationClient.release();
  }

  const store = createMemoryStore(config, pool);
  if (!store) {
    console.error("[memory:curate] failed to construct memory store");
    process.exit(1);
  }

  try {
    await runCuratorAction({ store, log: (message) => console.log(message) }, action);
  } finally {
    await store.close();
  }
}

runAsScript(import.meta.url, "memory:curate", main);
