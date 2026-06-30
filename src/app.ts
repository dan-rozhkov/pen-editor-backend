import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Config } from "./config.js";
import { registerCors } from "./plugins/cors.js";
import { registerMultipart } from "./plugins/multipart.js";
import { chatRoutes } from "./routes/chat.js";
import { generateImageRoutes } from "./routes/generateImage.js";
import { modelsRoutes } from "./routes/models.js";
import { uploadRoutes } from "./routes/upload.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — base64 images can be 2-5 MB each
  });

  await registerCors(app, config);
  await registerMultipart(app);
  await chatRoutes(app, config);
  await modelsRoutes(app, config);
  await uploadRoutes(app, config);
  await generateImageRoutes(app, config);

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

  return app;
}
