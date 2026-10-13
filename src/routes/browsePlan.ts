import type { FastifyInstance } from "fastify";
import { browsePlanBodySchema, planGoal } from "@sideform/browser-agent/policy";
import type { Config } from "../config.js";
import { createBrowsePlanPolicy } from "../ai/browsePolicy.js";

// POST /api/browse/plan — splits a multi-item browse_task goal into ordered
// sub-goals (planGoal in @sideform/browser-agent/policy). Gated exactly like /api/browse/step:
// it is only ever useful together with browse_task, which needs
// TYPESAFE_API_KEY, so an instance without it advertises neither.

export async function browsePlanRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.post(
    "/api/browse/plan",
    {
      // One small model call per browse_task, so far fewer than step's 60/min.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const policy = createBrowsePlanPolicy(config);
      if (!policy) {
        return reply
          .status(503)
          .send({ error: "Browsing is not configured (TYPESAFE_API_KEY unset)." });
      }
      const parsed = browsePlanBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      // planGoal applies its own timeout; this adds the client hanging up.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const { subgoals, fallbackReason } = await planGoal(policy, parsed.data, gone.signal);
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
