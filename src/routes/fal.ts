import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { removeBackground, vectorizeImage, FalTimeoutError } from "../services/fal.js";
import type { AnalyticsClient } from "../analytics/posthog.js";

const bodySchema = z.object({ image_url: z.string().url() });

export async function falRoutes(
  app: FastifyInstance,
  config: Config,
  // Null by default so every existing caller (tests, ad hoc scripts) is
  // unaffected — same undefined/null-elsewhere contract chat.ts's
  // `analytics` param follows.
  analytics: AnalyticsClient | null = null,
) {
  app.post(
    "/api/remove-background",
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
        return reply.status(503).send({ error: "Background removal is not configured on this deployment" });
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
        const { url } = await removeBackground(config, parsed.data.image_url, abortController.signal);
        analytics?.capture({
          event: "background_removed",
          distinctId: "api",
          // No real person behind this fixed "api" distinctId — see the same
          // flag on api_request in app.ts.
          properties: { ok: true, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
        return reply.send({ url });
      } catch (err) {
        // A user closing the tab mid-call aborts the in-flight request (see
        // the reply.raw "close" handler above), which surfaces here as the
        // same AbortError the provider call throws. That's a normal cancel,
        // not a provider failure — capture it with a distinct error_kind
        // instead of folding it into `ok: false`, so it doesn't inflate the
        // provider error rate.
        if (abortController.signal.aborted) {
          analytics?.capture({
            event: "background_removed",
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
          event: "background_removed",
          distinctId: "api",
          properties: { ok: false, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
        if (err instanceof FalTimeoutError) {
          return reply.status(504).send({ error: err.message });
        }
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    "/api/vectorize",
    {
      config: {
        // Same reasoning as /api/remove-background above: paid, unauthenticated.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!config.FAL_KEY) {
        return reply.status(503).send({ error: "Vectorization is not configured on this deployment" });
      }

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Missing or invalid 'image_url'" });
      }

      const abortController = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      const startedAt = Date.now();
      try {
        const { url, svg } = await vectorizeImage(config, parsed.data.image_url, abortController.signal);
        analytics?.capture({
          event: "image_vectorized",
          distinctId: "api",
          properties: { ok: true, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
        return reply.send({ url, svg });
      } catch (err) {
        if (abortController.signal.aborted) {
          analytics?.capture({
            event: "image_vectorized",
            distinctId: "api",
            properties: {
              ok: false,
              error_kind: "aborted",
              duration_ms: Date.now() - startedAt,
              $process_person_profile: false,
            },
          });
          return;
        }
        request.log.error(err);
        analytics?.capture({
          event: "image_vectorized",
          distinctId: "api",
          properties: { ok: false, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
        if (err instanceof FalTimeoutError) {
          return reply.status(504).send({ error: err.message });
        }
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );
}
