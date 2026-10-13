import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import {
  browseStepBodySchema,
  decideStep,
  isJevModel,
  type BrowsePolicyOptions,
} from "@sideform/browser-agent/policy";
import type { Config } from "../config.js";
import { createBrowsePolicy } from "../ai/browsePolicy.js";

// POST /api/browse/step — the backend half of the browse_task loop (see
// docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md §2).
// Stateless: one Jev call in, one decision out. This file is the Fastify glue
// only (TYPESAFE_API_KEY gate, rate limit, body validation, logging); the
// decision logic and the body schema live in @sideform/browser-agent/policy.

/**
 * Registers one stateless Jev-backed browse route — shared by
 * /api/browse/step and /api/browse/locate so the TYPESAFE_API_KEY gate
 * (503), body validation (400) and the last-resort catch (502) can't drift
 * between them. The policy functions are themselves designed never to
 * throw (they fail open to a BLOCKED/retry result); the catch is only a net
 * so a genuinely unexpected error still answers something machine-readable
 * rather than tearing down the frontend loop.
 */
export function registerJevBrowseRoute<Body>(
  app: FastifyInstance,
  config: Config,
  route: {
    path: string;
    bodySchema: z.ZodType<Body>;
    decide: (policy: BrowsePolicyOptions, body: Body) => Promise<unknown>;
    failureMessage: string;
  },
): void {
  app.post(
    route.path,
    {
      config: {
        // One Jev call per request (plus, for /api/browse/step, a small
        // STRUCTURED_MODEL call for TYPE_TEXT or a second small Jev call for
        // SELECT). Cheap individually, but browse_task fires one per loop
        // iteration, and a planned multi-item goal runs up to 150 of them back
        // to back at ~1/s (a live skroutz run hit 60/min and stalled 15
        // sub-goals on 429s). 180/min sits well above that rate and still
        // bounds a script hammering these endpoints directly.
        rateLimit: { max: 180, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const policy = createBrowsePolicy(config);
      if (!policy) {
        return reply
          .status(503)
          .send({ error: "Browsing is not configured (TYPESAFE_API_KEY unset)." });
      }

      const parsed = route.bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }

      try {
        return reply.send(await route.decide(policy, parsed.data));
      } catch (err) {
        app.log.error({ err, path: route.path }, "browse route failed unexpectedly");
        return reply.status(502).send({ error: route.failureMessage });
      }
    },
  );
}

export async function browseStepRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  // The package gates silently; the operator gets the warning here.
  if (config.BROWSE_STEP_VISION === "on" && isJevModel(config.TYPESAFE_MODEL)) {
    app.log.warn(
      { model: config.TYPESAFE_MODEL },
      "BROWSE_STEP_VISION=on ignored: TYPESAFE_MODEL is a jev model without vision; screenshots will not be sent",
    );
  }
  registerJevBrowseRoute(app, config, {
    path: "/api/browse/step",
    bodySchema: browseStepBodySchema,
    decide: async (policy, body) => {
      const result = await decideStep(policy, body);
      // One line per decision so a stuck browse_task can be diagnosed from
      // the server log. Only the decision's own fields — never page text;
      // a cascade `reason` is model-written and may quote the page.
      // vision/inputTokens are logged once, at the top level, not inside diag.
      const { vision: _vision, inputTokens: _inputTokens, ...logDiag } = result.diag ?? {};
      app.log.info(
        {
          browseStep: {
            step: body.history.length,
            policy: config.BROWSE_STEP_POLICY,
            outcome: result.outcome,
            operation: result.operation,
            confidence: result.confidence,
            cascade: result.cascade === true,
            reason: result.cascade ? undefined : result.reason,
            cascadeNote: result.cascadeNote,
            timings: result.timings,
            textSource: result.textSource,
            vision: result.diag?.vision === true,
            inputTokens: result.diag?.inputTokens,
            diag: logDiag,
          },
        },
        "browse step decided",
      );
      // `diag` is server-side gate/cascade diagnostics (logged above) —
      // never part of the HTTP contract, so it's stripped before the reply
      // is sent rather than left for the client to ignore.
      const { diag: _diag, ...reply } = result;
      return reply;
    },
    failureMessage: "failed to evaluate the next browsing step",
  });
}
