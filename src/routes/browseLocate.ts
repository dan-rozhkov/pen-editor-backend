import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createSystemOne } from "../services/systemone.js";
import { decideBrowseLocate, type BrowseLocateInput } from "../ai/browseLocate.js";
import { MAX_SNAPSHOT_ELEMENTS } from "../ai/browseStep.js";
import { elementSchema } from "./browseStep.js";

// POST /api/browse/locate — resolves a natural-language element
// description to one element index in a single Jev Choice call. Backend
// half of browse_act's `element` field (src/ai/tools.ts): the client sends
// a fresh snapshot of the page plus a description ("the Continue button in
// the cookie banner"), this picks the one element that matches. Same
// auth/rate-limit/gating shape as POST /api/browse/step (see that route's
// own header) — stateless, one vendor call in, one decision out. The
// decision logic lives in src/ai/browseLocate.ts so it's unit-testable
// without HTTP, same split as browseStep.ts/browseStep route.

const bodySchema = z.object({
  description: z.string().min(1).max(300),
  operation: z.enum(["CLICK", "TYPE_TEXT", "SELECT", "HOVER", "FOCUS"]),
  url: z.string().max(4_000),
  title: z.string().max(500),
  // Not bounded here at the exact MAX_SNAPSHOT_ELEMENTS — decideBrowseLocate
  // (via capAndScrubElements) re-caps unconditionally regardless of what the
  // client sent, mirroring the /api/browse/step route's own coarse guard.
  elements: z.array(elementSchema).max(1_000),
});

export async function browseLocateRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  app.post(
    "/api/browse/locate",
    {
      config: {
        // One Jev call per request — same per-IP shape/reasoning as
        // /api/browse/step's rate limit, sized for a script hammering the
        // endpoint directly rather than legitimate browse_act traffic (each
        // chat turn calls this at most a handful of times).
        rateLimit: { max: 60, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const client = createSystemOne(config);
      if (!client) {
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

      const input: BrowseLocateInput = {
        description: parsed.data.description,
        operation: parsed.data.operation,
        url: parsed.data.url,
        title: parsed.data.title,
        elements: parsed.data.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
      };

      try {
        const result = await decideBrowseLocate(client, input);
        return reply.send(result);
      } catch (err) {
        // decideBrowseLocate is itself designed to never throw (see its own
        // header) — this is a last-resort net, same reasoning as the
        // /api/browse/step route's equivalent catch.
        app.log.error({ err }, "browse locate failed unexpectedly");
        return reply
          .status(502)
          .send({ error: "failed to locate the requested element" });
      }
    },
  );
}
