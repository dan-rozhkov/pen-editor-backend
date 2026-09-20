import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createSystemOne } from "../services/systemone.js";
import {
  decideBrowseStep,
  MAX_SNAPSHOT_ELEMENTS,
  type BrowseStepInput,
} from "../ai/browseStep.js";

// POST /api/browse/step — the backend half of the browse_task loop (see
// docs/superpowers/specs/2026-09-18-browse-task-jev-loop-design.md §2).
// Stateless: one Jev call in (via decideBrowseStep), one decision out. Body
// validation and the TYPESAFE_API_KEY gate live here; the decision logic
// itself is in src/ai/browseStep.ts so it's unit-testable without HTTP.

// `value`/`options` are bounded here only as a coarse sanity/DoS guard, not
// at the real limit (MAX_ELEMENT_VALUE_CHARS/MAX_ELEMENT_OPTIONS/
// MAX_OPTION_CHARS in browseStep.ts) — a long textarea or a 195-option
// country/state/year <select> is ordinary page content, and rejecting the
// request over it (as this used to at 500/200/100) 400s the whole step and
// burns the client loop's budget on identical failures. decideBrowseStep
// truncates these down to the real limits unconditionally, the same way it
// already re-caps `elements` regardless of what the client sent.
const elementSchema = z.object({
  index: z.number().int().nonnegative(),
  tag: z.string().min(1).max(40),
  role: z.string().max(60).optional(),
  label: z.string().max(200),
  value: z.string().max(20_000).optional(),
  // What the desktop sends INSTEAD of `value` for every element whose
  // content must not leave the page (addendum D) — a password input, an
  // autocomplete="cc-*" field, a <select>. Without it here zod would strip
  // the key silently and Jev would lose the only remaining signal that the
  // field is already filled, which is the whole reason `value` was dropped.
  hasValue: z.boolean().optional(),
  isPassword: z.boolean().optional(),
  ops: z.array(z.enum(["CLICK", "TYPE_TEXT", "SELECT"])).min(1),
  options: z.array(z.string().max(2_000)).max(1_000).optional(),
});

const historyEntrySchema = z.object({
  operation: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
});

const bodySchema = z.object({
  goal: z.string().min(1).max(2_000),
  url: z.string().max(4_000),
  title: z.string().max(500),
  // Not bounded here at the exact MAX_SNAPSHOT_ELEMENTS — decideBrowseStep
  // re-caps unconditionally regardless of what the client sent, so this is
  // only a coarse request-size guard against a pathological payload.
  elements: z.array(elementSchema).max(1_000),
  history: z.array(historyEntrySchema).max(50),
});

export async function browseStepRoutes(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  app.post(
    "/api/browse/step",
    {
      config: {
        // Each request is one Jev call, PLUS either a small STRUCTURED_MODEL
        // call (TYPE_TEXT) or a second, small Jev call (SELECT — see
        // chooseSelectOption in browseStep.ts) — cheap individually, but this
        // fires once per loop iteration of browse_task (up to 25), so a
        // per-IP cap well above a single legitimate task's step rate still
        // bounds a script hammering this endpoint directly.
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

      const input: BrowseStepInput = {
        goal: parsed.data.goal,
        url: parsed.data.url,
        title: parsed.data.title,
        elements: parsed.data.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
        history: parsed.data.history,
      };

      try {
        const result = await decideBrowseStep(client, config, input);
        return reply.send(result);
      } catch (err) {
        // decideBrowseStep is itself designed to never throw (it fails open
        // to a BLOCKED result) — this is a last-resort net so a genuinely
        // unexpected error still answers something machine-readable rather
        // than tearing down the frontend loop.
        app.log.error({ err }, "browse step failed unexpectedly");
        return reply
          .status(502)
          .send({ error: "failed to evaluate the next browsing step" });
      }
    },
  );
}
