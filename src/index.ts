import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { registerCors } from "./plugins/cors.js";
import { chatRoutes } from "./routes/chat.js";

const config = loadConfig();

const app = Fastify({
  logger: true,
});

await registerCors(app);
await chatRoutes(app, config);

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

app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
