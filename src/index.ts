import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeAllMCPClients } from "./ai/mcp.js";
import { getAllSkills, loadSkills } from "./ai/skills.js";
import { applyStartupMigrations } from "./startupMigrations.js";

const config = loadConfig();

// Postgres schema was previously only ever advanced by CLI entrypoints
// (npm run analyze / the showcase scripts); the server itself never applied
// migrations. That silently broke the moment a route started reading a
// column a migration adds (see startupMigrations.ts) — so the server now
// applies pending migrations itself before it starts serving traffic.
await applyStartupMigrations(config);

await loadSkills();
if (getAllSkills().length === 0) {
  // A deploy without skill files is a packaging bug (e.g. dist/ copied without
  // dist/skills). Slash-commands would silently degrade to plain text — refuse
  // to start instead.
  console.error("[skills] No skills loaded — dist/skills (or src/skills) is missing. Aborting startup.");
  process.exit(1);
}

const app = await buildApp(config);

const shutdown = async () => {
  await closeAllMCPClients();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
