import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createShowcaseStore, type ShowcaseStore } from "../showcase/store.js";

// `limit` counts apps (gallery cards), not screens — an app publishes at most
// 5 screens, so 24 apps is ~120 screens, in the same ballpark as the old
// 50-screen ceiling.
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
  cursor: z.string().optional(),
});

export async function showcaseRoutes(
  app: FastifyInstance,
  config: Config,
  storeOverride?: ShowcaseStore | null,
): Promise<ShowcaseStore | null> {
  const store =
    storeOverride !== undefined ? storeOverride : createShowcaseStore(config);

  app.get("/api/showcase", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const { limit, cursor } = parsed.data;
    const { apps, nextCursor } = await store.listApps({
      limit,
      cursor,
    });

    // Explicit field lists, not the store rows: `prompt` (the full generation
    // prompt) and `pinned` stay server-side. Pin state needs no exposure —
    // the cover being first in `screens` is the whole contract.
    return reply.send({
      apps: apps.map((app) => ({
        runId: app.runId,
        theme: app.theme,
        model: app.model,
        createdAt: app.createdAt,
        screens: app.screens.map((screen) => ({
          id: screen.id,
          title: screen.title,
          imageUrl: screen.imageUrl,
          imageUrl1x: screen.imageUrl1x,
          lqip: screen.lqip,
          htmlUrl: screen.htmlUrl,
          width: screen.width,
          height: screen.height,
          createdAt: screen.createdAt,
        })),
      })),
      nextCursor,
    });
  });

  return store;
}
