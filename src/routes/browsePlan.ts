import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { MAX_GOAL_CHARS, BROWSE_PLAN_TIMEOUT_MS, planBrowseGoal } from "../ai/browsePlan.js";

// POST /api/browse/plan — splits a multi-item browse_task goal into ordered
// sub-goals (see src/ai/browsePlan.ts). Gated exactly like /api/browse/step:
// it is only ever useful together with browse_task, which needs
// TYPESAFE_API_KEY, so an instance without it advertises neither.

const bodySchema = z.object({
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  url: z.string().max(4_000).optional(),
});

export async function browsePlanRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.post(
    "/api/browse/plan",
    {
      // One small model call per browse_task, so far fewer than step's 60/min.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!config.TYPESAFE_API_KEY) {
        return reply
          .status(503)
          .send({ error: "Browsing is not configured (TYPESAFE_API_KEY unset)." });
      }
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      // Bounded by the timeout AND by the client hanging up.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const signal = AbortSignal.any([AbortSignal.timeout(BROWSE_PLAN_TIMEOUT_MS), gone.signal]);
      const { subgoals, fallbackReason } = await planBrowseGoal(config, parsed.data, signal);
      if (fallbackReason) {
        // Reason is an error message or fixed string; never the goal itself.
        app.log.warn({ browsePlan: { fallbackReason } }, "browse plan fell back to the single goal");
      } else {
        app.log.info({ browsePlan: { subgoals: subgoals.length } }, "browse plan produced");
      }
      return reply.send({ subgoals });
    },
  );
}
