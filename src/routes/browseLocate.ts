import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { decideBrowseLocate, type BrowseLocateInput } from "../ai/browseLocate.js";
import { MAX_SNAPSHOT_ELEMENTS } from "../ai/browseStep.js";
import { elementSchema, registerJevBrowseRoute } from "./browseStep.js";

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
  registerJevBrowseRoute(app, config, {
    path: "/api/browse/locate",
    bodySchema,
    decide: (client, body) => {
      const input: BrowseLocateInput = {
        description: body.description,
        operation: body.operation,
        url: body.url,
        title: body.title,
        elements: body.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
      };
      return decideBrowseLocate(client, input);
    },
    failureMessage: "failed to locate the requested element",
  });
}
