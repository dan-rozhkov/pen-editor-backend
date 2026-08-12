import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { MemoryStore } from "../ai/memory/store.js";
import { isPlausibleUserId } from "../lib/userId.js";

// Same 1..64 bound as the chat route's `userId` field (locked interface,
// self-improvement-loop spec) — a client-generated crypto.randomUUID(), not
// anything requiring a larger cap. Unlike the chat route, a shape-invalid
// userId here is rejected outright (not silently downgraded to "no memory")
// — this route reads back someone's audit trail, so a low-entropy id like
// "test" colliding across two different callers is exactly the leak this
// guards against, and a 400 is the honest response, not a degraded 200.
const querySchema = z.object({
  userId: z.string().min(1).max(64).refine(isPlausibleUserId),
  sinceId: z.coerce.number().int().min(0).optional(),
});

/**
 * Read-only "did the background review touch my memory" signal for the chat
 * panel's toast (self-improvement-loop spec, "UI visibility"). Purely
 * cosmetic — never throws a 5xx for a missing/disabled backend, since a
 * toast that never fires is a much smaller problem than one that spams the
 * console when Postgres or the feature flag is off.
 */
export async function memoryActivityRoutes(
  app: FastifyInstance,
  config: Config,
  memoryStore: MemoryStore | null,
): Promise<void> {
  app.get("/api/memory/activity", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    if (!config.MEMORY_ENABLED || !memoryStore) {
      return reply.send({ events: [], latestId: null });
    }

    const { userId, sinceId } = parsed.data;
    // This route is polled by the chat panel after every turn, so a
    // transient DB hiccup here must degrade to the same empty payload used
    // above for the disabled/missing-store case, not fall through to
    // Fastify's default error handler — which echoes `error.message`
    // verbatim in a 500 body (see app.ts's setErrorHandler) and would turn
    // a Postgres blip into a stream of leaked error text on every poll.
    try {
      const result = await memoryStore.listAuditActivity({ userId, sinceId });
      return reply.send({
        events: result.events.map((event) => ({
          id: event.id,
          subsystem: event.subsystem,
          action: event.action,
          origin: event.origin,
          created_at: event.createdAt,
        })),
        latestId: result.latestId,
      });
    } catch (err) {
      app.log.error({ err }, "[memory] activity lookup failed");
      return reply.send({ events: [], latestId: null });
    }
  });
}
