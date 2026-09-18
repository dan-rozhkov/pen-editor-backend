import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OPENCODE_BASE_URLS } from "../ai/opencode.js";
import type { Config } from "../config.js";

// Why this route exists at all: the browser cannot validate a pasted
// OpenCode key by calling opencode.ai directly — that origin has no CORS
// allowance for us, so a fetch from the composer's "Validate key" button
// would just die on preflight. This route is a thin, server-side relay:
// it forwards the key upstream once, on the user's behalf, and never stores
// it anywhere (see readOpenCodeKeyHeader below — same header, same
// never-log contract as the chat route's OpenCode branch).

const UPSTREAM_TIMEOUT_MS = 10_000;

const validateBodySchema = z.object({
  provider: z.enum(["opencode", "opencode-go"]).optional(),
});

// Same header, same contract as src/routes/chat.ts's readOpenCodeKeyHeader
// (kept as its own small copy rather than a shared import so this route's
// key-handling has no dependency on chat.ts at all — one less place a
// future refactor of the chat route could accidentally affect this one).
// Fastify lowercases header names; a header sent twice arrives as an array,
// so the first non-empty value wins. Blank/whitespace-only counts as absent.
function readOpenCodeKeyHeader(
  value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Upstream's /models response shape is not pinned by any contract we own,
// so this parses defensively: the documented OpenAI-compatible shape is
// `{data: [{id, ...}, ...]}`, but a bare array is tolerated too. Anything
// else (an unexpected shape, a non-JSON body) yields an empty list rather
// than throwing — a validate call that can't read the model list is still a
// successful key check, just with nothing to show for "which models".
function extractModelIds(payload: unknown): string[] {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : [];
  return entries
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

type OpenCodeProviderId = "opencode" | "opencode-go";

type CheckResult =
  | { kind: "ok"; models: string[] }
  | { kind: "invalid_key" }
  | { kind: "upstream_error" };

// Checks one API key against one OpenCode base. Factored out of the route
// handler so the "provider unspecified" branch below can try both bases
// without duplicating the upstream call/timeout/error handling.
async function checkOpenCodeKey(
  provider: OpenCodeProviderId,
  apiKey: string,
): Promise<CheckResult> {
  const baseUrl = OPENCODE_BASE_URLS[provider];
  try {
    const upstream = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      // Bounded so a hanging upstream can't hold this connection open
      // indefinitely — this is a user-triggered "check my key" click, not
      // a background job that can afford to wait.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (upstream.status === 401 || upstream.status === 403) {
      // A rejected key is an ordinary, expected answer to "is this key
      // valid?" — not an error on OUR api.
      return { kind: "invalid_key" };
    }
    if (!upstream.ok) {
      return { kind: "upstream_error" };
    }

    const payload = await upstream.json().catch(() => undefined);
    return { kind: "ok", models: extractModelIds(payload) };
  } catch {
    // Network failure, timeout, or a non-JSON body from upstream — all
    // collapse to the same "we couldn't check it" answer. The key itself
    // is never included in this error path.
    return { kind: "upstream_error" };
  }
}

export async function opencodeRoutes(app: FastifyInstance, _config: Config) {
  app.post(
    "/api/opencode/validate",
    {
      // Unauthenticated relay that reports whether an arbitrary caller-
      // supplied key is accepted by opencode.ai, from our IP — without a
      // limit this is a free credential-checking oracle for anyone else's
      // stolen/guessed OpenCode keys. Same conservative 10/min/IP budget as
      // the other unauthenticated outbound relay, /api/prototype-link.
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const apiKey = readOpenCodeKeyHeader(request.headers["x-opencode-key"]);
      if (!apiKey) {
        return reply.status(400).send({
          error:
            "Validating an OpenCode key requires the key itself (X-OpenCode-Key header).",
          code: "opencode_key_required",
        });
      }

      // A malformed body is treated as "no provider specified" rather than
      // 400ing — the only thing this endpoint truly needs is the header.
      const parsedBody = validateBodySchema.safeParse(request.body ?? {});
      const requestedProvider =
        parsedBody.success && parsedBody.data.provider
          ? parsedBody.data.provider
          : undefined;

      if (requestedProvider) {
        // Caller named an exact base — check only that one, so this branch
        // never makes a second outgoing request.
        const result = await checkOpenCodeKey(requestedProvider, apiKey);
        if (result.kind === "ok") {
          return reply.send({ ok: true, provider: requestedProvider, models: result.models });
        }
        return reply.send({ ok: false, reason: result.kind });
      }

      // No provider given: the only caller (the composer's "Validate key"
      // dialog) always sends an empty body, and the two OpenCode bases are
      // keyed by DIFFERENT subscriptions (Go's flat plan vs. Zen's
      // pay-as-you-go) — a key good on one is routinely rejected by the
      // other. Defaulting to a single hardcoded base (Go) meant a
      // Zen-only key always failed validation here even though the same
      // key would work fine in a real chat turn on a Zen model. Try Go
      // first, then Zen, and report whichever base actually accepted the
      // key — the response's own `provider` field is what tells the caller
      // which one that was.
      const goResult = await checkOpenCodeKey("opencode-go", apiKey);
      if (goResult.kind === "ok") {
        return reply.send({ ok: true, provider: "opencode-go", models: goResult.models });
      }
      if (goResult.kind !== "invalid_key") {
        // A non-auth failure (timeout, network error, upstream 5xx) isn't
        // evidence the key is bad — don't mask it by trying the second base
        // and reporting THAT base's unrelated outcome instead.
        return reply.send({ ok: false, reason: goResult.kind });
      }
      const zenResult = await checkOpenCodeKey("opencode", apiKey);
      if (zenResult.kind === "ok") {
        return reply.send({ ok: true, provider: "opencode", models: zenResult.models });
      }
      return reply.send({ ok: false, reason: zenResult.kind });
    },
  );
}
