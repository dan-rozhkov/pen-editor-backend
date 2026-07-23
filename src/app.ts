import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Config } from "./config.js";
import { registerCors } from "./plugins/cors.js";
import { registerMultipart } from "./plugins/multipart.js";
import { chatRoutes } from "./routes/chat.js";
import { generateImageRoutes } from "./routes/generateImage.js";
import { mcpRoutes } from "./mcp/routes.js";
import { modelsRoutes } from "./routes/models.js";
import { prototypeLinkRoutes } from "./routes/prototype-link.js";
import { uploadRoutes } from "./routes/upload.js";
import { createTraceStore, type TraceStore } from "./tracing/traceStore.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  // Test seam: inject a fake trace store. `undefined` = create from config,
  // `null` = explicitly disabled.
  traceStore?: TraceStore | null;
}

// The MCP WS upgrade (GET /api/mcp/ws?token=...) carries the auth token in
// the query string. Fastify's default request logging (pino) logs req.url
// verbatim, which would put the secret in plaintext logs. This serializer
// masks any `token=...` query param on the logged url; only applied when we
// build the default logger (options.logger left unset) so explicit caller
// configs (including `logger: false` in tests) are untouched.
export function maskTokenInUrl(url: string): string {
  return url.replace(/token=[^&]+/, "token=[redacted]");
}

function buildDefaultLogger(): FastifyServerOptions["logger"] {
  return {
    serializers: {
      req(request: { method?: string; url?: string }) {
        return {
          method: request.method,
          url: request.url ? maskTokenInUrl(request.url) : request.url,
        };
      },
    },
  };
}

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? buildDefaultLogger(),
    bodyLimit: 10 * 1024 * 1024, // 10 MB — base64 images can be 2-5 MB each
  });

  await registerCors(app, config);
  await registerMultipart(app);

  const traceStore =
    options.traceStore !== undefined
      ? options.traceStore
      : createTraceStore(config);
  if (traceStore) {
    app.addHook("onClose", async () => {
      await traceStore.close();
    });
  }
  await chatRoutes(app, config, traceStore);
  await modelsRoutes(app, config);
  await uploadRoutes(app, config);
  await generateImageRoutes(app, config);
  await prototypeLinkRoutes(app, config);

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

  // Registered after setErrorHandler: @fastify/websocket (used by mcpRoutes)
  // decorates the root instance and, if registered first, causes routes
  // registered earlier on this instance to fall back to Fastify's default
  // {statusCode, error, message} error shape instead of ours — verified via
  // test/upload-route.test.ts's thrown-Error path (see mcp-server task 6
  // report for the repro).
  await mcpRoutes(app, config);

  return app;
}
