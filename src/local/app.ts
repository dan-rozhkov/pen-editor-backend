import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Config } from "../config.js";
import { registerRateLimit } from "../plugins/rateLimit.js";
import { chatRoutes } from "../routes/chat.js";
import { byokRoutes } from "../routes/byok.js";
import { browseStepRoutes } from "../routes/browseStep.js";
import { browseLocateRoutes } from "../routes/browseLocate.js";
import { browsePlanRoutes } from "../routes/browsePlan.js";
import { browseJudgeRoutes } from "../routes/browseJudge.js";
import { buildDefaultLogger, createErrorHandler } from "../lib/httpDefaults.js";
import type { AgentRetryPolicy } from "../ai/retry.js";

export const LOCAL_TOKEN_HEADER = "x-sideform-local-token";

export interface BuildLocalAppOptions {
  logger?: FastifyServerOptions["logger"];
  /** Shared secret every request must carry in X-Sideform-Local-Token. Required unless insecureDev. */
  token?: string;
  /** Dev only (`npm run dev:local`): run without a token. Without this, a missing token is an error (fail closed). */
  insecureDev?: boolean;
  // Test seams, same meaning as in buildApp.
  chatRetryPolicy?: Partial<AgentRetryPolicy>;
  chatRateLimits?: { total?: number; main?: number };
}

function tokenMatches(expected: string, header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The Sideform Light backend: exactly the routes the app uses, and nothing
// else (no database, accounts, MCP, uploads, showcase, ...). Every other path
// is a 404. See docs/specs/2026-11-16-sideform-light-local-mode.md.
export async function buildLocalApp(
  config: Config,
  options: BuildLocalAppOptions = {},
): Promise<FastifyInstance> {
  if (!config.SIDEFORM_LOCAL) {
    throw new Error("buildLocalApp needs a local config (loadLocalConfig).");
  }
  const { token } = options;
  if (!token && !options.insecureDev) {
    throw new Error("buildLocalApp needs a token (SIDEFORM_LOCAL_TOKEN), or insecureDev for local development.");
  }
  const app = Fastify({
    logger: options.logger ?? buildDefaultLogger(),
    bodyLimit: 10 * 1024 * 1024, // base64 screenshots
    // Loopback only: nothing is a trusted proxy, so request.ip is the socket peer.
    trustProxy: false,
  });
  // resolveActor reads app.auth; local mode has no accounts (anonymous only).
  app.decorate("auth", null);

  // DNS-rebinding defence: a web page that rebinds its hostname to 127.0.0.1
  // still sends its own name in Host, so only the loopback names on the actual
  // listening port pass. Fails closed when the port is unknown.
  app.addHook("onRequest", async (request, reply) => {
    const port = request.socket.localPort ?? (app.server.address() as AddressInfo | null)?.port;
    const host = request.headers.host;
    if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
      return reply.status(403).send({ error: "forbidden_host" });
    }
  });

  if (token) {
    app.addHook("onRequest", async (request, reply) => {
      if (!tokenMatches(token, request.headers[LOCAL_TOKEN_HEADER])) {
        return reply.status(401).send({ error: "unauthorized" });
      }
    });
  }

  await registerRateLimit(app);

  // Every store and the analytics client are null: no traces, memory,
  // learned/user skills, audit, PostHog.
  await chatRoutes(
    app,
    config,
    null,
    null,
    null,
    null,
    null,
    null,
    options.chatRetryPolicy,
    options.chatRateLimits,
    { auxiliaryRoutes: false },
  );
  await byokRoutes(app, config);
  await browseStepRoutes(app, config);
  await browseLocateRoutes(app, config);
  await browsePlanRoutes(app, config);
  await browseJudgeRoutes(app, config);

  // No server models at all (see src/local/config.ts).
  app.get("/api/models", async () => ({
    models: [],
    default: null,
    visionFallback: false,
    imageOps: { removeBackground: false, vectorize: false },
  }));

  app.setErrorHandler(createErrorHandler(app));

  return app;
}
