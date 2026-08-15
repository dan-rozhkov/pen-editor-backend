import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { generateImage, ImageGenerationTimeoutError } from "../services/imageGen.js";
import type { AnalyticsClient } from "../analytics/posthog.js";

const bodySchema = z.object({ prompt: z.string().min(1) });

export async function generateImageRoutes(
  app: FastifyInstance,
  config: Config,
  // Null by default so every existing caller (tests, ad hoc scripts) is
  // unaffected — same undefined/null-elsewhere contract chat.ts's
  // `analytics` param follows.
  analytics: AnalyticsClient | null = null,
) {
  app.post("/api/generate-image", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Missing or invalid 'prompt'" });
    }

    // Watch the response rather than the request. IncomingMessage emits
    // "close" after an ordinary request body finishes, which would abort
    // image generation immediately. A response close before writableEnded
    // means the client actually disconnected while waiting for the image.
    const abortController = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) {
        abortController.abort();
      }
    });

    const startedAt = Date.now();
    try {
      const { url } = await generateImage(config, parsed.data.prompt, abortController.signal);
      analytics?.capture({
        event: "image_generated",
        distinctId: "api",
        // No real person behind this fixed "api" distinctId — see the same
        // flag on api_request in app.ts.
        properties: { ok: true, duration_ms: Date.now() - startedAt, $process_person_profile: false },
      });
      return reply.send({ url });
    } catch (err) {
      // A user closing the tab mid-generation aborts the in-flight request
      // (see the reply.raw "close" handler above), which surfaces here as
      // the same AbortError the provider call throws. That's a normal
      // cancel, not a provider failure — capture it with a distinct
      // error_kind instead of folding it into `ok: false`, so it doesn't
      // inflate the provider error rate.
      if (abortController.signal.aborted) {
        analytics?.capture({
          event: "image_generated",
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
        event: "image_generated",
        distinctId: "api",
        properties: { ok: false, duration_ms: Date.now() - startedAt, $process_person_profile: false },
      });
      if (err instanceof ImageGenerationTimeoutError) {
        return reply.status(504).send({ error: err.message });
      }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
