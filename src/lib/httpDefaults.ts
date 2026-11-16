import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from "fastify";
import { maskTokenInUrl } from "./maskTokenInUrl.js";

// Shared by the hosted app (src/app.ts) and the local one (src/local/app.ts).

/** Default pino logger: the request url is logged with secret query params masked. */
export function buildDefaultLogger(): FastifyServerOptions["logger"] {
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

/** The error's own HTTP status when it is a valid 4xx/5xx, else 500. */
export function errorStatusCode(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode: unknown }).statusCode
      : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
}

/** Fastify error handler: logs the error and answers `{ error: message }`. */
export function createErrorHandler(app: FastifyInstance) {
  return (error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) => {
    app.log.error(error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    reply.status(errorStatusCode(error)).send({ error: message });
  };
}
