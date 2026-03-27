import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { registerCors } from "./plugins/cors.js";
import { registerMultipart } from "./plugins/multipart.js";
import { chatRoutes } from "./routes/chat.js";
import { uploadRoutes } from "./routes/upload.js";
import { closeAllMCPClients } from "./ai/mcp.js";
import { loadSkills } from "./ai/skills.js";

const config = loadConfig();

await loadSkills();

const app = Fastify({
  logger: true,
  bodyLimit: 10 * 1024 * 1024, // 10 MB — base64 images can be 2-5 MB each
});

await registerCors(app);
await registerMultipart(app);
await chatRoutes(app, config);
await uploadRoutes(app, config);

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode: number }).statusCode
      : 500;
  const message =
    error instanceof Error ? error.message : "Internal Server Error";
  reply.status(statusCode).send({ error: message });
});

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
