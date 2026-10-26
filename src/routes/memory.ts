import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { MemoryStore } from "../ai/memory/store.js";
import { MEMORY_LIMITS } from "../ai/memory/types.js";
import { requireUserId } from "../auth/actor.js";

// Validated by resolveActor, which lets a session cookie replace it.
const querySchema = z.object({ userId: z.string().max(64).optional() });
const entryBodySchema = z.object({
  target: z.enum(["memory", "user"]),
  text: z.string().min(1).max(10_000),
});
const settingsBodySchema = z.object({ enabled: z.boolean() });

/**
 * The "Agent memory" settings page: read what the agent remembers, delete one
 * entry or everything, and switch remembering off. `userId` is always in the
 * query string (anonymous id or session cookie), for every method.
 */
export async function memoryRoutes(
  app: FastifyInstance,
  config: Config,
  memoryStore: MemoryStore | null,
): Promise<void> {
  const available = config.MEMORY_ENABLED && memoryStore !== null;

  async function authorize(
    request: Parameters<typeof requireUserId>[0],
    reply: FastifyReply,
  ): Promise<string | null> {
    if (!querySchema.safeParse(request.query).success) {
      await reply.status(400).send({ error: "Invalid query parameters" });
      return null;
    }
    return requireUserId(request, reply, "Invalid query parameters");
  }

  function unavailable(reply: FastifyReply) {
    return reply.status(503).send({ error: "Memory is not available" });
  }

  app.get("/api/memory", async (request, reply) => {
    const userId = await authorize(request, reply);
    if (!userId) return reply;
    if (!available || !memoryStore) {
      return reply.send({
        available: false,
        enabled: true,
        memory: [],
        user: [],
        limits: MEMORY_LIMITS,
      });
    }
    try {
      const [snapshot, enabled] = await Promise.all([
        memoryStore.loadSnapshot(userId),
        memoryStore.getMemoryEnabled(userId),
      ]);
      return reply.send({
        available: true,
        enabled,
        memory: snapshot.memory,
        user: snapshot.user,
        limits: MEMORY_LIMITS,
      });
    } catch (err) {
      app.log.error({ err }, "[memory] read failed");
      return reply.status(500).send({ error: "Memory read failed" });
    }
  });

  app.delete("/api/memory/entry", async (request, reply) => {
    const userId = await authorize(request, reply);
    if (!userId) return reply;
    const body = entryBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid body" });
    if (!available || !memoryStore) return unavailable(reply);
    try {
      const removed = await memoryStore.removeEntry(userId, body.data.target, body.data.text, "user");
      if (!removed) return reply.status(404).send({ error: "Entry not found" });
      return reply.send({ removed: true });
    } catch (err) {
      app.log.error({ err }, "[memory] entry delete failed");
      return reply.status(500).send({ error: "Memory delete failed" });
    }
  });

  app.delete("/api/memory", async (request, reply) => {
    const userId = await authorize(request, reply);
    if (!userId) return reply;
    if (!available || !memoryStore) return unavailable(reply);
    try {
      const cleared = await memoryStore.clearUser(userId, "user");
      return reply.send({ cleared });
    } catch (err) {
      app.log.error({ err }, "[memory] clear failed");
      return reply.status(500).send({ error: "Memory clear failed" });
    }
  });

  app.put("/api/memory/settings", async (request, reply) => {
    const userId = await authorize(request, reply);
    if (!userId) return reply;
    const body = settingsBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "Invalid body" });
    if (!available || !memoryStore) return unavailable(reply);
    try {
      await memoryStore.setMemoryEnabled(userId, body.data.enabled);
      return reply.send({ enabled: body.data.enabled });
    } catch (err) {
      app.log.error({ err }, "[memory] settings write failed");
      return reply.status(500).send({ error: "Memory settings write failed" });
    }
  });
}
