import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { createSystemOne, type SystemOneClient } from "../services/systemone.js";
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
// Exported so routes/browseLocate.ts (same element shape, same truncation
// rules) doesn't redeclare this schema.
export const elementSchema = z
  .object({
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
    checked: z.boolean().optional(),
    isPassword: z.boolean().optional(),
    // Browse-speed contract (2026-09-24), scroll containers: a scroll
    // container entry (`{index, tag, label, ops: [], scrollable: true}`) has
    // no CLICK/TYPE_TEXT/SELECT of its own — it exists only so browse_act's
    // scroll action can target it by index. A bare `.min(1)` here would
    // reject that legitimate shape (400ing every step on a page that has
    // one), so an empty `ops` is instead allowed below, in `.superRefine`,
    // gated on `scrollable: true` — a genuinely empty `ops` on a
    // non-scrollable element still fails validation.
    ops: z.array(z.enum(["CLICK", "TYPE_TEXT", "SELECT"])),
    options: z.array(z.string().max(2_000)).max(1_000).optional(),
    // Browse-speed contract (2026-09-24) item 5: the desktop snapshot now also
    // marks a scroll container (`scrollable`, pass this element's index to
    // browse_act's scroll action to scroll inside it) and, once
    // snapshot/perform pierce iframes, which one an element lives in
    // (`frame`). Both are cheap to fold into decideBrowseStep's per-element
    // digest line (elementDigestLine in ../ai/browseStep.js) — optional here
    // so zod doesn't silently strip them from an older/non-conforming client.
    scrollable: z.boolean().optional(),
    frame: z.string().max(200).optional(),
  })
  .superRefine((el, ctx) => {
    if (el.ops.length === 0 && !el.scrollable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ops must contain at least 1 element(s) unless scrollable is true",
        path: ["ops"],
      });
    }
  });

const historyEntrySchema = z.object({
  operation: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
});

// Browse-speed contract item 5: the client's own scroll position, sent
// alongside `elements` so a WAIT/SCROLL decision can see whether the page is
// already at the bottom rather than guessing. Optional — an older client
// that doesn't send it degrades to exactly today's behavior.
const scrollSchema = z.object({
  y: z.number(),
  height: z.number(),
  atBottom: z.boolean().optional(),
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
  scroll: scrollSchema.optional(),
});

/**
 * Registers one stateless Jev-backed browse route — shared by
 * /api/browse/step and /api/browse/locate so the TYPESAFE_API_KEY gate
 * (503), body validation (400) and the last-resort catch (502) can't drift
 * between them. Both `decide` functions are themselves designed never to
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
    decide: (client: SystemOneClient, body: Body) => Promise<unknown>;
    failureMessage: string;
  },
): void {
  app.post(
    route.path,
    {
      config: {
        // One Jev call per request (plus, for /api/browse/step, a small
        // STRUCTURED_MODEL call for TYPE_TEXT or a second small Jev call for
        // SELECT — see chooseSelectOption in browseStep.ts). Cheap
        // individually, but browse_task fires one per loop iteration (up to
        // 25), so a per-IP cap well above a legitimate task's step rate still
        // bounds a script hammering these endpoints directly.
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

      const parsed = route.bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }

      try {
        return reply.send(await route.decide(client, parsed.data));
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
  registerJevBrowseRoute(app, config, {
    path: "/api/browse/step",
    bodySchema,
    decide: async (client, body) => {
      const input: BrowseStepInput = {
        goal: body.goal,
        url: body.url,
        title: body.title,
        elements: body.elements.slice(0, MAX_SNAPSHOT_ELEMENTS),
        history: body.history,
        scroll: body.scroll,
      };
      const result = await decideBrowseStep(client, config, input);
      // One line per decision so a stuck browse_task can be diagnosed from
      // the server log. Only the decision's own fields — never page text;
      // a cascade `reason` is model-written and may quote the page.
      app.log.info(
        {
          browseStep: {
            step: body.history.length,
            outcome: result.outcome,
            operation: result.operation,
            confidence: result.confidence,
            cascade: result.cascade === true,
            reason: result.cascade ? undefined : result.reason,
            cascadeNote: result.cascadeNote,
          },
        },
        "browse step decided",
      );
      return result;
    },
    failureMessage: "failed to evaluate the next browsing step",
  });
}
