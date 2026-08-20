// Public canvas sharing: an unauthenticated create/update on
// POST /api/canvas/share, a public GET /api/canvas/:id, and an
// edit-token-gated DELETE /api/canvas/:id. `userId` is only shape-checked
// (isPlausibleUserId), never authenticated — same trust model as
// userSkillRoutes/showcasePublishRoutes. This route owns no store
// lifecycle (app.ts's onClose hook closes the shared SharedCanvasStore); it
// only turns HTTP requests into store calls.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { isPlausibleUserId } from "../lib/userId.js";
import type { SharedCanvasStore } from "../sharing/sharedCanvasStore.js";

// Same 1..64 bound as chat.ts's/userSkillRoutes' userId field, and same
// hard-400 stance as userSkillRoutes (not chat.ts's silent downgrade to
// "absent"): this route writes an internet-reachable, publicly-readable
// document, so a shape-invalid id is rejected outright rather than quietly
// treated as anonymous.
const userIdSchema = z.string().min(1).max(64).refine(isPlausibleUserId);

// A document is an already-serialized PenDocument JSON string. 8,000,000
// chars comfortably covers a large real canvas (well under the route's own
// 12 MB bodyLimit once JSON-escaped inside the request body) while still
// bounding worst-case memory/Postgres row size. An explicit .max() message
// (not zod's default "String must contain at most 8000000 character(s)")
// so the frontend's size-error mapper (pen-editor/src/lib/shareCanvas.ts,
// which matches /large|size|too big/i) can actually recognize this case and
// show the user a "canvas too large" message instead of a generic error.
const shareBodySchema = z.object({
  userId: userIdSchema,
  title: z.string().min(1).max(200),
  document: z
    .string()
    .min(2)
    .max(8_000_000, "This canvas is too large to share (limit ~8 MB)."),
  shareId: z.string().min(1).max(64).optional(),
  editToken: z.string().min(1).max(128).optional(),
});

const getParamsSchema = z.object({ id: z.string().min(1).max(64) });

const deleteParamsSchema = z.object({ id: z.string().min(1).max(64) });
// editToken travels in the DELETE body, not the query string — a query
// param lands verbatim in Fastify's request-logged URL, and pino's default
// logger only masks an exact lowercase `token=` (see maskTokenInUrl in
// app.ts, hardened but still URL-shaped), so any *token=... query param is
// one grep away from a plaintext log line. `fetch` sends a DELETE body
// fine, and @fastify/cors' `methods`/`allowedHeaders` (src/plugins/cors.ts)
// already cover DELETE + Content-Type, so nothing about the transport
// forces the token onto the URL.
const deleteBodySchema = z.object({ editToken: z.string().min(1).max(128) });

// A cheap sanity gate, deliberately NOT a scene-schema duplicate: the real
// PenDocument shape lives in the frontend (pen-editor/src/types/scene.ts)
// and changes independently of this backend. Re-validating every node type
// here would drift out of sync with that schema and start rejecting valid
// documents the moment the frontend adds a field — this only confirms the
// payload is JSON shaped roughly like a document (an object with a `pages`
// array), which is enough to catch a client bug or a stray non-document
// POST without taking on the frontend's schema as a dependency.
function looksLikePenDocument(document: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as { pages?: unknown }).pages)
  );
}

// A cost guard against one owner writing unbounded rows into a Postgres
// instance that traces/memory/showcase also share — not a product limit
// (there's no reason a real user would ever hit this from normal use). 50
// is generous headroom over any plausible number of concurrently-shared
// canvases while still bounding worst case. Checked only before an insert:
// an update overwrites an existing row and adds none, so gating it there
// too would block a legitimate re-share for no reason.
const MAX_SHARES_PER_OWNER = 50;

export async function sharedCanvasRoutes(
  app: FastifyInstance,
  config: Config,
  store: SharedCanvasStore | null,
): Promise<void> {
  app.post(
    "/api/canvas/share",
    {
      // A serialized canvas document can be large; the app-wide 10 MB
      // bodyLimit (src/app.ts) is sized for base64 images, not this route —
      // same reasoning as showcasePublish.ts's own PUBLISH_BODY_LIMIT
      // override.
      bodyLimit: 12 * 1024 * 1024,
      config: {
        // Unauthenticated (userId is only shape-checked) and a real write —
        // 20/min/IP is generous for one editing session sharing/re-sharing a
        // canvas while bounding an automated spam loop.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply
          .status(503)
          .send({ error: "Canvas sharing isn't configured on this server." });
      }

      const parsed = shareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues[0]?.message ?? "Invalid request body",
        });
      }
      const { userId, title, document, shareId, editToken } = parsed.data;

      if (!looksLikePenDocument(document)) {
        return reply
          .status(400)
          .send({ error: "document must be a JSON object with a pages array" });
      }

      // Exactly one of shareId/editToken present means the caller almost
      // certainly meant to update an existing share (it dropped/mangled the
      // other half) rather than create a new one. Silently falling through
      // to create here — the old `if (shareId && editToken)` behaviour —
      // would leave the caller believing they updated their link while the
      // old link keeps serving stale content and an orphan row accumulates
      // in Postgres, so this is a hard 400 instead.
      if (Boolean(shareId) !== Boolean(editToken)) {
        return reply
          .status(400)
          .send({ error: "shareId and editToken must be provided together" });
      }

      if (shareId && editToken) {
        let updatedAt: Date | null;
        try {
          updatedAt = await store.update({ id: shareId, editToken, title, document });
        } catch (err) {
          app.log.error({ err }, "[shared-canvas] update failed");
          return reply.status(500).send({ error: "Failed to update this share." });
        }
        if (!updatedAt) {
          return reply.status(404).send({
            error: "This share link no longer exists, or the edit token is wrong.",
          });
        }
        return reply.send({ id: shareId, editToken, updatedAt });
      }

      try {
        const existing = await store.countByOwner(userId);
        if (existing >= MAX_SHARES_PER_OWNER) {
          return reply.status(400).send({
            error:
              "You've reached the limit of shared canvases. Stop sharing an old canvas first.",
          });
        }
      } catch (err) {
        app.log.error({ err }, "[shared-canvas] countByOwner failed");
        return reply.status(500).send({ error: "Failed to create this share." });
      }

      // 9 random bytes -> 12 base64url chars: short enough to paste
      // comfortably, long enough that a 9-byte id space isn't realistically
      // guessable. 24 random bytes -> 32 base64url chars for the edit token,
      // which only ever needs to resist guessing, not be short.
      const id = randomBytes(9).toString("base64url");
      const newEditToken = randomBytes(24).toString("base64url");
      try {
        await store.insert({ id, ownerId: userId, editToken: newEditToken, title, document });
      } catch (err) {
        app.log.error({ err }, "[shared-canvas] insert failed");
        return reply.status(500).send({ error: "Failed to create this share." });
      }
      return reply.status(201).send({ id, editToken: newEditToken, createdAt: new Date() });
    },
  );

  // Public: no userId — this is the link recipients follow, and it must
  // work for anyone, not just the sharer's own browser. It IS rate limited
  // though, unlike most public GETs in this codebase: it returns
  // multi-megabyte no-store payloads, which makes it a cheap amplification
  // vector against a single instance if left wide open. 120/min/IP is
  // deliberately far looser than the write route's 20/min — this is a cost
  // guard, not access control, and must not meaningfully throttle a real
  // viewer loading a shared canvas.
  app.get(
    "/api/canvas/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!store) {
        return reply
          .status(503)
          .send({ error: "Canvas sharing isn't configured on this server." });
      }
      const params = getParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "Invalid id" });
      }
      let canvas;
      try {
        canvas = await store.get(params.data.id);
      } catch (err) {
        app.log.error({ err }, "[shared-canvas] get failed");
        return reply.status(500).send({ error: "Failed to load this share." });
      }
      if (!canvas) {
        return reply.status(404).send({ error: "not found" });
      }
      // A share can be updated in place by its owner at any time, so this
      // response must never be cached — a stale cached copy would silently
      // show viewers an out-of-date canvas.
      reply.header("Cache-Control", "no-store");
      return reply.send({
        id: canvas.id,
        title: canvas.title,
        document: canvas.document,
        createdAt: canvas.createdAt,
        updatedAt: canvas.updatedAt,
      });
    },
  );

  app.delete("/api/canvas/:id", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Canvas sharing isn't configured on this server." });
    }
    const params = deleteParamsSchema.safeParse(request.params);
    // editToken travels in the JSON body, not the query string — see
    // deleteBodySchema's comment above for why.
    const body = deleteBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "Invalid id or missing editToken" });
    }
    let removed: boolean;
    try {
      removed = await store.remove(params.data.id, body.data.editToken);
    } catch (err) {
      app.log.error({ err }, "[shared-canvas] remove failed");
      return reply.status(500).send({ error: "Failed to delete this share." });
    }
    if (!removed) {
      return reply.status(404).send({
        error: "This share link no longer exists, or the edit token is wrong.",
      });
    }
    return reply.status(204).send();
  });
}
