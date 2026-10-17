import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// /api/chat rate limiting, two layers, both on @fastify/rate-limit's store:
//  1. The route's own `config.rateLimit` (default onRequest hook, IP only): a
//     cheap TOTAL cap (300/min) for every turn, checked before the body is
//     parsed, so big bodies are still cut off early.
//  2. A main-turn cap (60/min) checked in the handler once the body is parsed
//     (`checkMainTurnLimit`). Nested browse turns (the desktop browse
//     subagent; 4 parallel runs make ~120 requests/min) are on its allow list,
//     so they only face the total cap.
//
// Trade-off, stated plainly: `agentMode: "browse"` comes from the request body
// and nothing verifies it, so any caller can skip the 60/min main cap by
// setting it. Such a turn stays under the 300/min total, and it is cheap: the
// browse subagent runs on BROWSE_AGENT_MODEL, without reasoning, with browse
// tools only. A verified nested-turn token would close this; that is not done.
//
// Why `createRateLimit` and not `app.rateLimit(...)` as a preHandler: the
// plugin marks a request as "already rate limited" on layer 1, and its route
// handler returns early on that mark, so a second handler never counts.
// `createRateLimit` counts without that mark; it only reports, so this module
// raises the same 429 the plugin raises. The store is the plugin's in-memory
// one: per process, same multi-replica caveat as src/plugins/rateLimit.ts.

export const CHAT_TOTAL_MAX_PER_MINUTE = 300;
export const CHAT_MAIN_MAX_PER_MINUTE = 60;

/** A turn is a browse turn only when the server runs the browse subagent. */
export function isBrowseTurn(agentMode: string | undefined, browseMode: string | undefined): boolean {
  return agentMode === "browse" && browseMode === "agent";
}

// "retry in 1 minute" / "retry in 43 seconds": the wording of the plugin's
// default message, for windows up to a minute.
function formatAfter(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** Builds the main-turn check. Call once, after the rate-limit plugin is registered. */
export function createMainTurnLimiter(
  app: FastifyInstance,
  browseMode: string | undefined,
  max: number,
) {
  const check = (
    app as unknown as {
      createRateLimit: (o: object) => (req: FastifyRequest) => Promise<{
        isAllowed: boolean;
        isExceeded: boolean;
        max: number;
        ttlInSeconds: number;
      }>;
    }
  ).createRateLimit({
    max,
    timeWindow: "1 minute",
    // A distinct key, so it never shares a counter with the layer-1 (IP) key.
    keyGenerator: (req: FastifyRequest) => `main:${req.ip}`,
    allowList: (req: FastifyRequest) =>
      isBrowseTurn((req.body as { agentMode?: string } | undefined)?.agentMode, browseMode),
  });

  /** Throws the plugin-shaped 429 when this IP is over the main-turn cap. */
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const r = await check(request);
    if (r.isAllowed || !r.isExceeded) return;
    reply.header("x-ratelimit-limit", r.max);
    reply.header("x-ratelimit-remaining", 0);
    reply.header("x-ratelimit-reset", r.ttlInSeconds);
    reply.header("retry-after", r.ttlInSeconds);
    throw Object.assign(new Error(`Rate limit exceeded, retry in ${formatAfter(r.ttlInSeconds)}`), {
      statusCode: 429,
    });
  };
}
