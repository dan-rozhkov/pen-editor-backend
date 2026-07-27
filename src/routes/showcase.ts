import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createShowcaseStore, type ShowcaseStore } from "../showcase/store.js";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(24),
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
    const { screens, nextCursor } = await store.listScreens({
      limit,
      cursor,
    });

    return reply.send({
      screens: screens.map((screen) => ({
        id: screen.id,
        runId: screen.runId,
        theme: screen.theme,
        title: screen.title,
        model: screen.model,
        imageUrl: screen.imageUrl,
        htmlUrl: screen.htmlUrl,
        width: screen.width,
        height: screen.height,
        createdAt: screen.createdAt,
      })),
      nextCursor,
    });
  });

  return store;
}
