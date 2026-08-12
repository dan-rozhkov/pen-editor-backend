import { loadConfig } from "../../config.js";
import { createPgPool } from "../../tracing/traceStore.js";
import { migrate } from "../../analysis/migrate.js";
import { runAsScript } from "../../showcase/cli.js";
import {
  curateSkills,
  formatCurateReport,
  parseCurateFlags,
  type CuratorClient,
} from "./curate.js";

// CLI entrypoint for `npm run skills:curate` — the deterministic phase-3
// curator (see curate.ts). Wiring only: flags in, one call into curate.ts,
// report out. Same env + pool + migrate shape as `npm run memory:curate`
// (src/ai/memory/curatorRun.ts): only TRACE_DATABASE_URL is required, no S3,
// no LLM.
//
// Read-only by default. `--apply` is what makes it write, and nothing else —
// this is the CLI half of the spec's "mutating run requires --apply" rule;
// the read-only-by-default enforcement itself lives in curateSkills.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let flags;
  try {
    flags = parseCurateFlags(argv);
  } catch (err) {
    console.error(`[skills:curate] ${(err as Error).message}`);
    console.error("[skills:curate] usage: npm run skills:curate -- [--apply]");
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.TRACE_DATABASE_URL) {
    console.error("[skills:curate] TRACE_DATABASE_URL is required");
    process.exit(1);
  }

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const client = await pool.connect();
  try {
    const applied = await migrate(client);
    if (applied.length) {
      console.log(`[skills:curate] applied migrations: ${applied.join(", ")}`);
    }

    // curateSkills runs its own BEGIN/UPDATE/COMMIT on this one checked-out
    // client — never the pool — because the whole run is one transaction and
    // pg.Pool would scatter those statements across physical connections.
    const result = await curateSkills(client as unknown as CuratorClient, {
      apply: flags.apply,
    });
    console.log(formatCurateReport(result));
  } finally {
    client.release();
    await pool.end();
  }
}

runAsScript(import.meta.url, "skills:curate", main);
