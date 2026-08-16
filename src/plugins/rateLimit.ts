import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

// Registered globally but effectively opt-in: `global: false` means no route
// gets a limit unless it explicitly sets `config.rateLimit` (see
// generateImageRoutes/prototypeLinkRoutes/chatRoutes). This keeps every other
// route (memoryActivity, models, showcase, upload, userSkills, mcp)
// unthrottled without having to enumerate them as exceptions here.
//
// Keyed by client IP via the plugin's default `keyGenerator`
// (`request.ip`) — good enough for a per-IP cost guard; no auth layer
// exists yet to key by user instead.
//
// Store is the plugin's default in-memory LRU — per-process, not shared
// across replicas. Same caveat already noted for showcasePublish.ts's
// in-memory busy-flag: if this service is ever scaled to N Render
// instances, each holds its own counter, so a client round-robining across
// instances sees an effective ceiling of N × the configured limit. Fine at
// today's single-instance scale; revisit with a shared store (e.g. Redis)
// before scaling out.
export async function registerRateLimit(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: false,
  });
}
