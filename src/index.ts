import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closeAllMCPClients } from "./ai/mcp.js";
import { loadSkills } from "./ai/skills.js";

const config = loadConfig();

await loadSkills();

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
