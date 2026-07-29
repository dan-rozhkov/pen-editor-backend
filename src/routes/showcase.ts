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
  sort: z.enum(["popular", "latest"]).default("popular"),
  category: z.string().min(1).optional(),
  // Defaults to "mobile" for backward compatibility — every client built
  // before desktop generation existed still gets exactly the feed it always
  // has.
  platform: z.enum(["mobile", "desktop"]).default("mobile"),
});

const categoriesQuerySchema = z.object({
  platform: z.enum(["mobile", "desktop"]).default("mobile"),
});

const likeParamsSchema = z.object({
  runId: z.string().uuid(),
});

// The 1..25 bound exists solely so a single request can't post `count: 1e9`
// — it is not a rate limit (there's no dedup, claps are meant to be
// repeatable).
const likeBodySchema = z.object({
  count: z.coerce.number().int().min(1).max(25),
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

    const { limit, cursor, sort, category, platform } = parsed.data;
    const { apps, nextCursor } = await store.listApps({
      limit,
      cursor,
      sort,
      category,
      platform,
    });

    // Explicit field lists, not the store rows: `prompt` (the full generation
    // prompt) and `pinned` stay server-side. Pin state needs no exposure —
    // the cover being first in `screens` is the whole contract.
    return reply.send({
      apps: apps.map((app) => ({
        runId: app.runId,
        theme: app.theme,
        model: app.model,
        platform: app.platform,
        createdAt: app.createdAt,
        likes: app.likes,
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

  app.get("/api/showcase/categories", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const parsed = categoriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const categories = await store.listCategories(parsed.data.platform);
    return reply.send({ categories });
  });

  app.post("/api/showcase/:runId/like", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const params = likeParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid runId" });
    }
    const body = likeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid request body" });
    }

    const likes = await store.likeApp(params.data.runId, body.data.count);
    if (likes === null) {
      return reply.status(404).send({ error: "App not found" });
    }
    return reply.send({ likes });
  });

  return store;
}
