import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { removeBackground, vectorizeImage, FalTimeoutError, UnsafeSvgError } from "../services/fal.js";
import type { AnalyticsClient } from "../analytics/posthog.js";

const bodySchema = z.object({ image_url: z.string().url() });
type Body = z.infer<typeof bodySchema>;

interface FalRouteOptions {
  path: string;
  // Shown as the 503 body when FAL_KEY is unset — the rest of the request
  // handling (rate limit, body validation, abort/timeout/error mapping,
  // analytics) is identical between routes, only this message and the event
  // name below differ in a way worth stating per-route.
  disabledMessage: string;
  analyticsEvent: string;
  // Calls the actual fal.ai service function and shapes its result into the
  // exact JSON the route sends back (e.g. remove_background drops
  // contentType, vectorize keeps svg) — this is the one genuinely
  // route-specific piece of behavior.
  run: (body: Body, signal: AbortSignal) => Promise<Record<string, unknown>>;
}

// Shared skeleton for both fal.ai-backed routes: the FAL_KEY gate, body
// validation, client-disconnect abort wiring, timing, and the
// aborted/FalTimeoutError/UnsafeSvgError/generic error → status code +
// analytics mapping. /api/remove-background and /api/vectorize differ only
// in which service function they call and how they shape its result — see
// FalRouteOptions.run — plus /api/vectorize's extra UnsafeSvgError → 422
// branch, which this helper supports unconditionally (it's a no-op for a
// route whose `run` never throws that error).
function registerFalRoute(
  app: FastifyInstance,
  config: Config,
  analytics: AnalyticsClient | null,
  options: FalRouteOptions,
) {
  app.post(
    options.path,
    {
      config: {
        // Each request triggers a paid external call to fal.ai, and the
        // route is unauthenticated, so it stays capped per IP — same limit
        // and reasoning as /api/generate-image.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!config.FAL_KEY) {
        return reply.status(503).send({ error: options.disabledMessage });
      }

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Missing or invalid 'image_url'" });
      }

      // Watch the response rather than the request. IncomingMessage emits
      // "close" after an ordinary request body finishes, which would abort
      // the call immediately. A response close before writableEnded means
      // the client actually disconnected while waiting for the result.
      const abortController = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      const startedAt = Date.now();
      try {
        const body = await options.run(parsed.data, abortController.signal);
        analytics?.capture({
          event: options.analyticsEvent,
          distinctId: "api",
          // No real person behind this fixed "api" distinctId — see the same
          // flag on api_request in app.ts.
          properties: { ok: true, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
        return reply.send(body);
      } catch (err) {
        // A user closing the tab mid-call aborts the in-flight request (see
        // the reply.raw "close" handler above), which surfaces here as the
        // same AbortError the provider call throws. That's a normal cancel,
        // not a provider failure — capture it with a distinct error_kind
        // instead of folding it into `ok: false`, so it doesn't inflate the
        // provider error rate.
        if (abortController.signal.aborted) {
          analytics?.capture({
            event: options.analyticsEvent,
            distinctId: "api",
            properties: {
              ok: false,
              error_kind: "aborted",
              duration_ms: Date.now() - startedAt,
              $process_person_profile: false,
            },
          });
          // The client already disconnected — nothing to send back.
          return;
        }
        request.log.error(err);
        analytics?.capture({
          event: options.analyticsEvent,
          distinctId: "api",
          properties: {
            ok: false,
            // Distinguish "fal gave us something we refuse to use" from a
            // real server/provider failure — this is expected to fire
            // essentially never against real tracer output (see
            // assertSvgIsInert), so a spike here is itself a signal. Only
            // ever set for /api/vectorize; harmless no-op elsewhere.
            ...(err instanceof UnsafeSvgError ? { error_kind: "unsafe_svg" } : {}),
            duration_ms: Date.now() - startedAt,
            $process_person_profile: false,
          },
        });
        if (err instanceof FalTimeoutError) {
          return reply.status(504).send({ error: err.message });
        }
        if (err instanceof UnsafeSvgError) {
          // A rejection of untrusted upstream content, not a server bug —
          // 422 (Unprocessable Content), not 500, with the specific reason.
          return reply.status(422).send({ error: err.message });
        }
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );
}

export async function falRoutes(
  app: FastifyInstance,
  config: Config,
  // Null by default so every existing caller (tests, ad hoc scripts) is
  // unaffected — same undefined/null-elsewhere contract chat.ts's
  // `analytics` param follows.
  analytics: AnalyticsClient | null = null,
) {
  registerFalRoute(app, config, analytics, {
    path: "/api/remove-background",
    disabledMessage: "Background removal is not configured on this deployment",
    analyticsEvent: "background_removed",
    run: async (body, signal) => {
      const { url } = await removeBackground(config, body.image_url, signal);
      return { url };
    },
  });

  registerFalRoute(app, config, analytics, {
    path: "/api/vectorize",
    disabledMessage: "Vectorization is not configured on this deployment",
    analyticsEvent: "image_vectorized",
    run: async (body, signal) => {
      const { url, svg } = await vectorizeImage(config, body.image_url, signal);
      return { url, svg };
    },
  });
}
