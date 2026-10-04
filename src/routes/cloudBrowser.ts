import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { requireUserId } from "../auth/actor.js";
import { createSteelClient, type SteelClient } from "../services/steel.js";
import { connectOverCdp } from "../browser/connect.js";
import {
  COMMAND_NAMES,
  createCloudSessions,
  type BrowserConnector,
  type CloudSessions,
  type CommandName,
} from "../browser/cloudSessions.js";

// Spec: docs/specs/2026-09-29-cloud-browser-steel-design.md §3.5. The web
// build's browse_* tools forward here; `result` is exactly what the desktop
// bridge would resolve with, `{error}` objects included.

export interface CloudBrowserRouteOptions {
  // Test seams: fake Steel client / CDP connector (no network in tests).
  steel?: SteelClient;
  connect?: BrowserConnector;
}

const identity = {
  // Shape-checked by resolveActor (a session cookie wins and makes this field
  // irrelevant), so only a coarse bound lives in the schema.
  userId: z.string().max(64).optional(),
  chatId: z.string().min(1).max(128),
};
const cmdBody = z.object({ ...identity, handle: z.string().min(1).max(512).optional(), args: z.unknown().optional() });
const releaseBody = z.object({ ...identity, handle: z.string().min(1).max(512) });

const DISABLED = "Cloud browser is not configured on this server.";

export async function cloudBrowserRoutes(
  app: FastifyInstance,
  config: Config,
  options: CloudBrowserRouteOptions = {},
): Promise<CloudSessions | null> {
  const apiKey = config.STEEL_API_KEY;
  const sessions = apiKey
    ? createCloudSessions({
        steel: options.steel ?? createSteelClient({ apiKey }),
        connect: options.connect ?? connectOverCdp,
        secret: apiKey,
        maxSessions: config.CLOUD_BROWSER_MAX_SESSIONS,
        sessionTimeoutMs: config.CLOUD_BROWSER_SESSION_TIMEOUT_MS,
        idleMs: config.CLOUD_BROWSER_IDLE_MS,
        dailySessions: config.CLOUD_BROWSER_DAILY_SESSIONS,
      })
    : null;

  if (sessions) {
    sessions.startSweeper();
    // Timer stopped and every Steel session released when the app closes, so
    // tests never leak the sweeper and SIGTERM stops billing.
    app.addHook("onClose", async () => {
      await sessions.shutdown();
    });
  }

  app.get("/api/browser/config", async () => ({ enabled: Boolean(sessions) }));

  // Each command can hold a remote browser; the route is unauthenticated, so
  // it is capped per IP (the daily/global quotas live in the registry).
  const rateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  app.post("/api/browser/cmd/:name", { config: rateLimit }, async (request, reply) => {
    if (!sessions) return reply.status(503).send({ error: DISABLED });
    const name = (request.params as { name: string }).name;
    if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
      return reply.status(400).send({ error: `Unknown browser command '${name}'` });
    }
    const parsed = cmdBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid userId, chatId, handle or args" });
    const { chatId, handle, args } = parsed.data;
    const userId = await requireUserId(request, reply, "Invalid userId, chatId, handle or args");
    if (!userId) return reply;
    const command = name as CommandName;

    let outcome;
    try {
      outcome = await sessions.resolve({ userId, chatId, ip: request.ip, handle, command, args });
    } catch (e) {
      request.log.warn({ err: e }, "cloud browser session unavailable");
      return reply.status(502).send({ error: "Cloud browser is unavailable right now — try again shortly." });
    }
    if (outcome.kind === "forbidden") return reply.status(403).send({ error: "Invalid browser handle" });
    if (outcome.kind === "quota") return reply.status(outcome.status).send({ error: outcome.error });
    if (outcome.kind === "no-session") {
      const result = outcome.sessionExpired
        ? { error: outcome.error, sessionExpired: true }
        : { error: outcome.error };
      return { result, handle: null, liveViewUrl: null, expiresAt: null };
    }

    let result;
    try {
      result = await sessions.run(outcome.entry, command, args);
    } catch (e) {
      // The controller never rejects by contract; belt and braces.
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    return {
      result,
      handle: outcome.handle,
      liveViewUrl: outcome.entry.liveViewUrl,
      expiresAt: outcome.entry.expiresAt,
      // Lets the client hide the live view once the session has sat idle this long.
      idleMs: config.CLOUD_BROWSER_IDLE_MS,
    };
  });

  app.post("/api/browser/release", { config: rateLimit }, async (request, reply) => {
    if (!sessions) return reply.status(503).send({ error: DISABLED });
    const parsed = releaseBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid userId, chatId or handle" });
    const userId = await requireUserId(request, reply, "Invalid userId, chatId or handle");
    if (!userId) return reply;
    const out = await sessions.release(userId, parsed.data.chatId, parsed.data.handle);
    if ("forbidden" in out) return reply.status(403).send({ error: "Invalid browser handle" });
    return out;
  });

  return sessions;
}
