import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isOriginAllowed, parseEnvList, type Config } from "../config.js";
import {
  isQuiverConfigured,
  streamVectorGeneration,
  QuiverError,
  QuiverTimeoutError,
} from "../services/quiver.js";
import { UnsafeSvgError } from "../services/fal.js";
import type { AnalyticsClient } from "../analytics/posthog.js";
import { abortOnClientDisconnect } from "./clientDisconnect.js";

const bodySchema = z.object({
  prompt: z.string().min(1),
  instructions: z.string().optional(),
});

export async function vectorRoutes(
  app: FastifyInstance,
  config: Config,
  // Null by default so every existing caller (tests, ad hoc scripts) is
  // unaffected — same undefined/null-elsewhere contract chat.ts's
  // `analytics` param follows, and the same shape falRoutes/
  // generateImageRoutes take.
  analytics: AnalyticsClient | null = null,
) {
  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);

  app.post(
    "/api/vector/generate",
    {
      config: {
        // Each request triggers a paid external call to a dedicated vector
        // model, and the route is unauthenticated — same reasoning as
        // /api/generate-image and the fal.ai routes. Capped tighter than
        // those two (20/min) because Quiver's own svg_generate operation
        // class is itself rate-limited to 20/min upstream; staying well
        // under that leaves headroom for other server-side Quiver callers
        // and avoids this route alone exhausting the upstream budget.
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!isQuiverConfigured(config)) {
        return reply.status(503).send({
          error: "Vector generation is not configured on this server (QUIVER_API_KEY unset).",
        });
      }

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Missing or invalid 'prompt'" });
      }

      const abortController = abortOnClientDisconnect(reply);

      const startedAt = Date.now();
      let streamStarted = false;
      try {
        const generator = streamVectorGeneration(config, {
          prompt: parsed.data.prompt,
          instructions: parsed.data.instructions,
          signal: abortController.signal,
        });

        for await (const event of generator) {
          if (!streamStarted) {
            streamStarted = true;
            // Tell Fastify we're taking over the raw response ourselves —
            // same reply.hijack() mechanics as chat.ts's SSE route. Must
            // happen exactly once, right before the first raw write: before
            // this point a 400/503/500 can still go out through the normal
            // reply.status().send() path.
            reply.hijack();
            // CORS must be set by hand here: hijack() takes the raw socket and
            // bypasses Fastify's plugins, @fastify/cors included. Without this
            // the editor is served from a different origin than the API in
            // production and the browser discards the whole stream. A local
            // curl smoke cannot catch it — curl sends no Origin. Same
            // reflect-the-allowlist rule as chat.ts's SSE route (an empty
            // allowlist means dev mode and reflects any origin).
            const origin = request.headers.origin;
            const corsHeaders: Record<string, string> =
              origin && isOriginAllowed(allowedOrigins, origin)
                ? { "Access-Control-Allow-Origin": origin }
                : {};
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              Vary: "Origin",
              ...corsHeaders,
              // Disables buffering on nginx-style reverse proxies (Render's
              // edge included) so SSE chunks reach the client as they're
              // written instead of piling up until a buffer threshold.
              "X-Accel-Buffering": "no",
            });
          }
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        if (!streamStarted) {
          // The generator finished (or threw before yielding) without ever
          // producing an event — treat as an upstream failure rather than
          // silently sending nothing.
          throw new QuiverError("Quiver stream produced no output", 502);
        }
        reply.raw.end();
        analytics?.capture({
          event: "vector_generated",
          distinctId: "api",
          // No real person behind this fixed "api" distinctId — see the same
          // flag on api_request in app.ts.
          properties: { ok: true, duration_ms: Date.now() - startedAt, $process_person_profile: false },
        });
      } catch (err) {
        if (abortController.signal.aborted && !(err instanceof QuiverTimeoutError)) {
          analytics?.capture({
            event: "vector_generated",
            distinctId: "api",
            properties: {
              ok: false,
              error_kind: "aborted",
              duration_ms: Date.now() - startedAt,
              $process_person_profile: false,
            },
          });
          // Client disconnected. If the stream already started,
          // reply.hijack() gave us ownership of the raw response and it must
          // be closed. If it never started, Fastify still owns `reply` —
          // calling reply.raw.end() there and then returning undefined trips
          // FST_ERR_PROMISE_NOT_FULFILLED, and Fastify's error handler then
          // tries to write a 500 onto an already-ended response
          // (ERR_STREAM_WRITE_AFTER_END). Match fal.ts/generateImage.ts:
          // leave `reply` alone in that case and just return.
          if (streamStarted && !reply.raw.writableEnded) reply.raw.end();
          return;
        }

        request.log.error(
          {
            err,
            code: err instanceof QuiverError ? err.code : undefined,
            requestId: err instanceof QuiverError ? err.requestId : undefined,
          },
          "vector generation failed",
        );
        analytics?.capture({
          event: "vector_generated",
          distinctId: "api",
          properties: {
            ok: false,
            // Distinguish "Quiver gave us something we refuse to use" from a
            // real server/provider failure — same convention as
            // routes/fal.ts's vectorize route.
            ...(err instanceof UnsafeSvgError ? { error_kind: "unsafe_svg" } : {}),
            duration_ms: Date.now() - startedAt,
            $process_person_profile: false,
          },
        });

        if (!streamStarted) {
          // No byte has gone out yet — a real HTTP status code is still
          // possible.
          if (err instanceof QuiverTimeoutError) {
            return reply.status(504).send({ error: err.message });
          }
          if (err instanceof UnsafeSvgError) {
            // A rejection of untrusted upstream content, not a server bug —
            // 422 (Unprocessable Content), same as /api/vectorize.
            return reply.status(422).send({ error: err.message });
          }
          if (err instanceof QuiverError) {
            // Collapse rather than reflect Quiver's real status/code/message
            // to an unauthenticated caller: it turns an operator
            // misconfiguration (e.g. an expired QUIVER_API_KEY, surfaced as
            // 401 invalid_api_key) into a client-facing auth error, makes an
            // upstream 429 indistinguishable from this route's own
            // @fastify/rate-limit 429 (so client retry logic backs off
            // against the wrong thing), and can leak billing state on
            // 402/403. Peer routes (fal.ts, generateImage.ts) collapse the
            // same way; the real status/code/requestId are still in the log
            // line above for operators.
            return reply.status(500).send({ error: "Vector generation failed" });
          }
          return reply.status(500).send({ error: (err as Error).message });
        }

        // The response has already started as an SSE stream — the status
        // line is long gone, so the only way to report a failure is an
        // `error` event frame inside the stream itself. Same collapsing as
        // the pre-stream branch above: a QuiverError's real message/code
        // must not reach the client.
        const message =
          err instanceof QuiverTimeoutError || err instanceof UnsafeSvgError
            ? err.message
            : err instanceof QuiverError
              ? "Vector generation failed"
              : err instanceof Error
                ? err.message
                : String(err);
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        reply.raw.end();
      }
    },
  );
}
