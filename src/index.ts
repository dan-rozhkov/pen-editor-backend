import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeAllMCPClients } from "./ai/mcp.js";
import { getAllSkills, loadSkills } from "./ai/skills.js";

const config = loadConfig();

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
