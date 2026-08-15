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
import {
  getHandshakePath,
  removeHandshakeFile,
  resolveMcpAuth,
  writeHandshakeFile,
  type HandshakeFileEntry,
} from "./mcp/autoToken.js";
import { modelsRoutes } from "./routes/models.js";
import { prototypeLinkRoutes } from "./routes/prototype-link.js";
import { showcaseRoutes } from "./routes/showcase.js";
import { showcasePublishRoutes } from "./routes/showcasePublish.js";
import { uploadRoutes } from "./routes/upload.js";
import { createTraceStore, type TraceStore } from "./tracing/traceStore.js";
import type { ShowcaseStore } from "./showcase/store.js";
import { createMemoryStore, type MemoryStore } from "./ai/memory/store.js";
import { memoryActivityRoutes } from "./routes/memoryActivity.js";
import { getSharedLearnedSkillStore, type LearnedSkillStore } from "./ai/skills/learnedStore.js";
import { getSharedAuditDb } from "./ai/selfimprove/auditDb.js";
import type { TraceQueryable } from "./tracing/traceStore.js";
import { createAnalyticsClient, type AnalyticsClient } from "./analytics/posthog.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  // Test seam: inject a fake trace store. `undefined` = create from config,
  // `null` = explicitly disabled.
  traceStore?: TraceStore | null;
  // Test seam: inject a fake showcase store. `undefined` = create from
  // config, `null` = explicitly disabled.
  showcaseStore?: ShowcaseStore | null;
  // Test seam: inject a fake memory store. `undefined` = create from config,
  // `null` = explicitly disabled.
  memoryStore?: MemoryStore | null;
  // Phase 2 test seams, same undefined/null contract as memoryStore above.
  learnedSkillStore?: LearnedSkillStore | null;
  auditDb?: TraceQueryable | null;
  // Test seam: inject a fake analytics client (e.g. one that records
  // captures in memory). `undefined` = build the real one from config
  // (POSTHOG_API_KEY unset → a no-op client, same shape either way — unlike
  // the stores above there is no `null` variant, since "analytics off" is
  // already represented by the no-op client rather than by omitting one).
  analytics?: AnalyticsClient;
  // Whether this buildApp() call is the one long-running dev server
  // instance allowed to publish/reuse/clean up the shared handshake file at
  // ~/.pen-editor/mcp.json. Defaults to false: every other caller (test
  // suites, one-off scripts, anything that spins up buildApp() for a short
  // ephemeral instance) must never touch the real file, even when it
  // otherwise ends up in auto-token mode. Only src/index.ts — the actual
  // `npm run dev` / `npm start` entrypoint — sets this to true. A global
  // test-setup homedir redirect (test/setup.ts) is a second, independent
  // layer against the same mistake — see mcp-auto-token-publish.test.ts for
  // why both are required.
  publishHandshake?: boolean;
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
  // Gated on MEMORY_ENABLED || SELF_SKILLS_ENABLED here, not inside
  // createMemoryStore: that factory is also called directly by tests
  // wanting a store regardless of either flag (test/memory-store-pglite.test.ts),
  // and its own contract is "config has TRACE_DATABASE_URL". The app itself
  // must not open a second pool at the same Postgres when BOTH features are
  // off. SELF_SKILLS_ENABLED alone still needs this store: agent_review_state
  // holds turns_since_memory AND steps_since_skill in one row per user, and
  // bumpCounters is the only place that reads/resets either counter — a
  // skills-only deployment (MEMORY_ENABLED off) still needs it to track the
  // skill review threshold, even though the memory *feature* (snapshot
  // injection, the `memory` tool) stays fully gated by MEMORY_ENABLED alone
  // inside prepareChatTurn/maybeRunReview.
  const memoryStore =
    options.memoryStore !== undefined
      ? options.memoryStore
      : config.MEMORY_ENABLED || config.SELF_SKILLS_ENABLED
        ? createMemoryStore(config)
        : null;
  if (memoryStore) {
    app.addHook("onClose", async () => {
      await memoryStore.close();
    });
  }
  // Phase 2: learnedSkillStore feeds the catalog merge + load_skill's
  // learned-skill resolution; auditDb is skill_manage/skill_view's own
  // handle for agent_selfimprove_audit writes. Both gated on
  // SELF_SKILLS_ENABLED alone (unlike memoryStore above, nothing else needs
  // agent_skills or a raw audit handle).
  const learnedSkillStore =
    options.learnedSkillStore !== undefined
      ? options.learnedSkillStore
      : config.SELF_SKILLS_ENABLED
        ? getSharedLearnedSkillStore(config)
        : null;
  const auditDb =
    options.auditDb !== undefined
      ? options.auditDb
      : config.SELF_SKILLS_ENABLED
        ? getSharedAuditDb(config)
        : null;
  // Same close-on-shutdown contract as traceStore/memoryStore above —
  // without these, every buildApp() call in a long-running process (or a
  // test file with many `it`s that each build+close an app) leaked one
  // pg.Pool per store, since nothing else ever called .close()/.end() on
  // them. Both are shared-by-URL singletons (getSharedLearnedSkillStore /
  // getSharedAuditDb), so this only actually closes the underlying pool
  // once per URL, not once per buildApp() call — repeated calls against the
  // same URL just re-close an already-closed pool, which pg treats as a
  // harmless no-op.
  if (learnedSkillStore) {
    app.addHook("onClose", async () => {
      await learnedSkillStore.close();
    });
  }
  if (auditDb) {
    app.addHook("onClose", async () => {
      await auditDb.end();
    });
  }
  // Product analytics (PostHog). Always a real object — never null — since
  // "disabled" is represented by createAnalyticsClient's own no-op client
  // rather than by a null test seam, unlike the stores above.
  const analytics =
    options.analytics ??
    createAnalyticsClient({
      apiKey: config.POSTHOG_API_KEY,
      host: config.POSTHOG_HOST,
    });
  app.addHook("onClose", async () => {
    await analytics.shutdown();
  });

  // Generic HTTP health signal: one `api_request` event per response, for
  // every route EXCEPT the ones explicitly excluded below. Registered before
  // any route so it observes every request — this must stay above every
  // route registration below (including any inside an encapsulated
  // app.register() plugin), or a route registered above this line would
  // silently go unobserved: Fastify resolves root-level hook arrays at
  // ready(), so a hook registered after a route still happens to fire for
  // it today, but only by accident of registration order, not because
  // hook-then-route ordering is required. Excluded on purpose:
  //   - "/api/chat": uses reply.hijack() (see chat.ts), so Fastify's normal
  //     onResponse semantics don't apply to it reliably — it already emits
  //     its own explicit agent_turn_completed/agent_turn_failed events with
  //     richer, non-PII detail than a generic route/status/duration row
  //     could carry.
  //   - "/api/image-proxy": a high-frequency asset proxy (every showcase
  //     screen's every <img>), not a product action — logging it would burn
  //     a meaningful share of PostHog's free event budget for no signal.
  //   - "/api/mcp", "/api/mcp/ws": the MCP surface — loopback-only in dev,
  //     bearer-token gated in production, and /api/mcp/ws is a WebSocket
  //     upgrade that never reaches onResponse in the first place.
  const ANALYTICS_EXCLUDED_ROUTES = new Set([
    "/api/chat",
    "/api/image-proxy",
    "/api/mcp",
    "/api/mcp/ws",
  ]);
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || ANALYTICS_EXCLUDED_ROUTES.has(route)) return;
    analytics.capture({
      event: "api_request",
      // No per-visitor id is available on a generic route (unlike chat,
      // which carries userId) — group these under one fixed id rather than
      // inventing a fake per-request one that would fragment PostHog's
      // per-person event count for no benefit.
      distinctId: "api",
      properties: {
        route,
        method: request.method,
        status_code: reply.statusCode,
        duration_ms: reply.elapsedTime,
        // No real person behind this fixed "api" distinctId — without this,
        // PostHog would build one person profile carrying the server's
        // entire request volume and bill it in the pricier person-profile
        // tier. agent_turn_completed/failed and showcase_published carry a
        // real anonymous user id and stay person-scoped (no flag).
        $process_person_profile: false,
      },
    });
  });

  await chatRoutes(
    app,
    config,
    traceStore,
    memoryStore,
    learnedSkillStore,
    auditDb,
    analytics,
  );
  await memoryActivityRoutes(app, config, memoryStore);
  await modelsRoutes(app, config);
  await uploadRoutes(app, config);
  await generateImageRoutes(app, config, analytics);
  await prototypeLinkRoutes(app, config);
  const showcaseStore = await showcaseRoutes(app, config, options.showcaseStore);
  if (showcaseStore) {
    app.addHook("onClose", async () => {
      await showcaseStore.close();
    });
  }
  // Same store instance showcaseRoutes returned — never a second one, or
  // the two routes would race two independent Postgres pools.
  await showcasePublishRoutes(app, config, showcaseStore, undefined, analytics);

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
  const mcpAuth = await resolveMcpAuth(config, {
    reuseFromHandshake: options.publishHandshake === true,
  });
  await mcpRoutes(app, config, mcpAuth);

  if (mcpAuth.autoGenerated && options.publishHandshake) {
    // No manual token wiring for local dev: MCP_AUTH_TOKEN unset means we
    // generated (or reused, see resolveMcpAuth) a token above and gated
    // /api/mcp* to loopback callers only (src/mcp/routes.ts). Publish it to
    // the shared handshake file other local tools (the editor, an MCP
    // client) read to connect with zero configuration — only once the real
    // listening port is known, hence the onListen hook rather than doing
    // this inline here.
    app.log.info(
      "[mcp] MCP_AUTH_TOKEN not set — enabling /api/mcp* with an auto-generated token, restricted to 127.0.0.1.",
    );
    // Captured so onClose can (a) wait for the write to actually land before
    // deciding whether to remove anything — a process that listens and
    // closes quickly could otherwise run removeHandshakeFile before the
    // write's rename lands, leaving exactly the stale file the cleanup
    // exists to prevent — and (b) verify the file it's about to delete is
    // still the one this process itself wrote (see removeHandshakeFile).
    let handshakeEntry: HandshakeFileEntry | undefined;
    let writeDone: Promise<void> = Promise.resolve();
    app.addHook("onListen", async () => {
      const address = app.server.address();
      const port = typeof address === "object" && address !== null ? address.port : config.PORT;
      // Non-null: this branch only runs when mcpAuth.autoGenerated is true,
      // which resolveMcpAuth only ever returns alongside a real token.
      handshakeEntry = { url: `http://127.0.0.1:${port}/api/mcp`, token: mcpAuth.token!, port };
      writeDone = writeHandshakeFile(handshakeEntry, app.log);
      await writeDone;
    });
    app.addHook("onClose", async () => {
      await writeDone;
      if (handshakeEntry) {
        await removeHandshakeFile(handshakeEntry, app.log);
      }
    });
  } else if (mcpAuth.autoGenerated) {
    app.log.debug(
      `[mcp] auto-token mode active but this instance does not publish/read the shared handshake file (not the long-running dev server).`,
    );
  } else {
    app.log.debug(`[mcp] MCP_AUTH_TOKEN set explicitly — not writing ${getHandshakePath()}.`);
  }

  return app;
}
