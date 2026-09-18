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

export async function opencodeRoutes(app: FastifyInstance, _config: Config) {
  app.post("/api/opencode/validate", async (request, reply) => {
    const apiKey = readOpenCodeKeyHeader(request.headers["x-opencode-key"]);
    if (!apiKey) {
      return reply.status(400).send({
        error:
          "Validating an OpenCode key requires the key itself (X-OpenCode-Key header).",
        code: "opencode_key_required",
      });
    }

    // A malformed body just falls back to the default provider rather than
    // 400ing — the only thing this endpoint truly needs is the header.
    const parsedBody = validateBodySchema.safeParse(request.body ?? {});
    const provider =
      parsedBody.success && parsedBody.data.provider
        ? parsedBody.data.provider
        : "opencode-go";
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
        // valid?" — not an error on OUR api, hence 200.
        return reply.send({ ok: false, reason: "invalid_key" });
      }
      if (!upstream.ok) {
        return reply.send({ ok: false, reason: "upstream_error" });
      }

      const payload = await upstream.json().catch(() => undefined);
      const models = extractModelIds(payload);
      return reply.send({ ok: true, provider, models });
    } catch {
      // Network failure, timeout, or a non-JSON body from upstream — all
      // collapse to the same "we couldn't check it" answer. The key itself
      // is never included in this error path.
      return reply.send({ ok: false, reason: "upstream_error" });
    }
  });
}
