import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createSystemOne } from "../services/systemone.js";
import { MAX_SCREENS_PER_REQUEST, MAX_TASTE_CHECK_ROUNDS, runTasteCheck } from "../ai/tasteCheck.js";

// POST /api/taste-check — the backend half of the Jev taste-check feature
// (see src/ai/tasteCheck.ts's header). Stateless: one runTasteCheck() call
// in, one result out. Body validation and the TYPESAFE_API_KEY gate live
// here, mirroring src/routes/browseStep.ts's pattern; the check logic
// itself is in src/ai/tasteCheck.ts so it's unit-testable without HTTP.

const screenSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  html: z.string().min(1).max(200_000),
});

const bodySchema = z.object({
  screens: z.array(screenSchema).min(1).max(MAX_SCREENS_PER_REQUEST),
  brief: z.string().max(4_000).optional(),
  round: z.number().int().min(1).max(MAX_TASTE_CHECK_ROUNDS).optional(),
});

export async function tasteCheckRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  app.post(
    "/api/taste-check",
    {
      config: {
        // One call is up to 8 screens x 9 Nouls in parallel batches of 4 —
        // not a per-loop-iteration cost like browse/step, but still a real
        // Jev spend, so a per-IP cap keeps a script hammering this endpoint
        // directly from being free.
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const client = createSystemOne(config);
      if (!client) {
        return reply
          .status(503)
          .send({ error: "Taste checking is not configured (TYPESAFE_API_KEY unset)." });
      }

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }

      try {
        const result = await runTasteCheck(client, config, {
          screens: parsed.data.screens,
          brief: parsed.data.brief,
          round: parsed.data.round,
        });
        return reply.send(result);
      } catch (err) {
        // runTasteCheck is designed to never throw (fail-open per screen,
        // and per-call outcome codes for everything else) — this is a
        // last-resort net, same as browseStep.ts's.
        app.log.error({ err }, "taste check failed unexpectedly");
        return reply.status(502).send({ error: "failed to run the taste check" });
      }
    },
  );
}
