import type { FastifyInstance } from "fastify";
import { browseLocateBodySchema, locateTarget } from "@sideform/browser-agent/policy";
import type { Config } from "../config.js";
import { registerJevBrowseRoute } from "./browseStep.js";

// POST /api/browse/locate — resolves a natural-language element
// description to one element index in a single Jev Choice call. Backend
// half of browse_act's `element` field (src/ai/tools.ts). Same
// auth/rate-limit/gating shape as POST /api/browse/step — stateless, one
// vendor call in, one decision out. The logic (locateTarget) and the body
// schema live in @sideform/browser-agent/policy.

export async function browseLocateRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  registerJevBrowseRoute(app, config, {
    path: "/api/browse/locate",
    bodySchema: browseLocateBodySchema,
    decide: (policy, body) => locateTarget(policy, body),
    failureMessage: "failed to locate the requested element",
  });
}
