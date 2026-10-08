// Design-system library API: /api/ds/*. Account-only (a session cookie, an sf_
// API key or an OAuth token; an anonymous id is never enough, see
// requireAccount), role-checked per library (src/ds/access.ts), cursor-paginated lists
// without snapshots, immutable ETag'd versions, idempotent publish. Errors are
// always { error, message, details? }. Spec:
// pen-editor/docs/superpowers/plans/2026-10-08-phase6-8-library-adoption-governance-plan.md
// sections 1 and 6.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";
import type { AnalyticsClient } from "../analytics/posthog.js";
import { requireAccount } from "../auth/actor.js";
import { createBearerVerifier } from "../auth/bearer.js";
import type { Config } from "../config.js";
import { decide, type DsAction, type DsRole, type Principal } from "../ds/access.js";
import { parseAuditCursor } from "../ds/audit.js";
import { canonicalJson, sha256Hex } from "../ds/canonical.js";
import { parseLibraryCursor, parseVersionCursor, type DsLibrary, type DsStore } from "../ds/dsStore.js";
import { containsNul } from "../ds/nul.js";
import { analyze, checkBaseAndSnapshot, decidePublish, prepareSnapshot, type PreparedSnapshot } from "../ds/publish.js";
import { parseVersion } from "../ds/semver.js";
import { MAX_USAGE_METRICS_BYTES, usageAnalytics, usageMetricsSchema } from "../ds/usage.js";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CHANGELOG_BYTES = 512 * 1024;
// The snapshot cap plus headroom for the changelog and the JSON envelope.
const PUBLISH_BODY_LIMIT = 6 * 1024 * 1024;
const WRITE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };
const READ_LIMIT = { rateLimit: { max: 120, timeWindow: "1 minute" } };

const noNul = <T extends ZodType>(schema: T) => schema.refine((v) => !containsNul(v), "Strings may not contain U+0000.");

const idParam = z.object({ id: z.string().min(1).max(64) });
const deleteQuery = z.object({ purge: z.enum(["true", "false"]).optional() });
const versionParams = z.object({ id: z.string().min(1).max(64), version: z.string().min(1).max(32) });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
const versionString = z.string().refine((v) => parseVersion(v) !== null, "Expected MAJOR.MINOR.PATCH");
const createBody = z.object({
  orgId: z.string().min(1).max(64).optional(),
  name: noNul(z.string().trim().min(1).max(120)),
  description: noNul(z.string().max(2000)).default(""),
});
const patchBody = z
  .object({
    name: noNul(z.string().trim().min(1).max(120)).optional(),
    description: noNul(z.string().max(2000)).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, "Nothing to update.");
const baseVersionField = versionString.nullable();
const previewBody = z.object({ baseVersion: baseVersionField, snapshot: z.unknown() });
const publishBody = z.object({
  baseVersion: baseVersionField,
  bump: z.enum(["major", "minor", "patch"]),
  snapshot: z.unknown(),
  changelog: noNul(z.record(z.string(), z.unknown())).default({}),
  notes: noNul(z.string().max(2000)).default(""),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(64).optional(),
  action: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(40).optional(),
});
const updatesQuery = z.object({
  from: versionString,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const usageParams = z.object({ id: z.string().min(1).max(64), documentKey: z.string().uuid() });
const usageBody = z.object({ version: versionString, metrics: usageMetricsSchema });
const usageDocumentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().regex(/^\d{1,5}$/).optional(),
  sort: z.enum(["reportedAt", "coverage"]).default("reportedAt"),
});
const USAGE_BODY_LIMIT = 128 * 1024;
const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{8,128}$/);

function send(reply: FastifyReply, status: number, error: string, message: string, details?: Record<string, unknown>) {
  return reply.status(status).send({ error, message, ...(details ? { details } : {}) });
}

function parse<S extends ZodType>(schema: S, data: unknown, reply: FastifyReply, where = "request"): z.output<S> | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  // Paths and messages only: an issue never echoes the offending value back.
  void send(reply, 400, "invalid_request", `Invalid ${where}.`, {
    issues: result.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return null;
}

/** A cursor this server did not issue is a client bug: say so instead of restarting the list. */
function badCursor(cursor: string | undefined, valid: (cursor: string) => unknown, reply: FastifyReply): boolean {
  if (cursor === undefined || valid(cursor) !== null) return false;
  void send(reply, 400, "invalid_cursor", "The cursor is not valid. Start again without a cursor.");
  return true;
}

function libraryJson(l: DsLibrary) {
  return {
    id: l.id,
    name: l.name,
    description: l.description,
    ownerId: l.ownerId,
    orgId: l.orgId,
    role: l.role,
    latestVersion: l.latestVersion,
    latestPublishedAt: l.latestPublishedAt,
    archivedAt: l.archivedAt,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

/**
 * One serialization per request on the happy path: a valid snapshot is
 * measured by its canonical JSON (the very string that is hashed and stored).
 * Only an invalid one is re-serialized, so an oversized junk body still gets
 * 413 rather than a pile of validation issues.
 */
function snapshotTooLarge(prepared: PreparedSnapshot, raw: unknown): boolean {
  const size = prepared.validation.ok ? Buffer.byteLength(prepared.json, "utf8") : Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  return size > MAX_SNAPSHOT_BYTES;
}

export async function dsRoutes(
  app: FastifyInstance,
  config: Config,
  store: DsStore | null,
  analytics: AnalyticsClient,
): Promise<void> {
  // Encapsulated so the error handler below only shapes /api/ds errors.
  await app.register(async (scope) => {
    scope.setErrorHandler((err: Error & { statusCode?: number; code?: string }, request, reply) => {
      const status = err.statusCode ?? 500;
      if (status >= 500) {
        request.log.error({ err }, "[ds] request failed");
        return send(reply, 500, "internal_error", "Unexpected server error.");
      }
      const code =
        status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : status === 429 ? "rate_limited" : "bad_request";
      return send(reply, status, code, status === 429 ? "Too many requests. Try again later." : err.message);
    });

    const verifyBearer = app.auth ? createBearerVerifier(app.auth, config) : null;

    type Handler = (ctx: { store: DsStore; principal: Principal }, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    const guarded =
      (handler: Handler) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!store) return send(reply, 503, "ds_unavailable", "Design-system libraries are not configured on this server.");
        const principal = await requireAccount(request, reply, verifyBearer);
        if (!principal) return reply;
        return handler({ store, principal }, request, reply);
      };

    const notFound = (reply: FastifyReply, what = "Library") => send(reply, 404, "not_found", `${what} not found.`);

    const forbidden = (reply: FastifyReply, code: "forbidden" | "agent_cannot_approve") =>
      send(
        reply,
        403,
        code,
        code === "agent_cannot_approve" ? "An agent cannot publish or approve changes." : "Your role does not allow this action.",
      );

    /**
     * Role gate for reads that need more than "read" (preview, audit); writes
     * are gated inside their transaction by the store. 404 when the caller has no role on it (it
     * may not exist), 403 when the role or the kind of caller is too low.
     * Null = reply already sent.
     */
    const authorize = async (
      store: DsStore,
      principal: Principal,
      libraryId: string,
      action: DsAction,
      reply: FastifyReply,
    ): Promise<DsRole | null> => {
      const role = await store.getRole(libraryId, principal.userId);
      if (!role) {
        await notFound(reply);
        return null;
      }
      const decision = decide(principal, role, action);
      if (!decision.ok) {
        await forbidden(reply, decision.code);
        return null;
      }
      return role;
    };

    // ---- libraries -------------------------------------------------------

    scope.post(
      "/api/ds/libraries",
      { config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const body = parse(createBody, request.body, reply, "body");
        if (!body) return reply;
        const id = `lib_${randomBytes(9).toString("base64url")}`;
        const result = await store.createLibrary({ id, principal, orgId: body.orgId ?? null, name: body.name, description: body.description });
        if (result.kind === "org_not_found") return notFound(reply, "Organization");
        if (result.kind === "forbidden") return send(reply, 403, "forbidden", "Your role does not allow this action.");
        if (result.kind === "name_taken") return send(reply, 409, "name_taken", "A library with this name already exists here.");
        if (result.kind === "limit") {
          return send(reply, 422, "library_limit", "You have reached the limit of libraries. Delete an archived library to free a slot.", {
            live: result.live,
            total: result.total,
          });
        }
        return reply.status(201).header("Location", `/api/ds/libraries/${id}`).send(libraryJson(result.library));
      }),
    );

    scope.get(
      "/api/ds/libraries",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const query = parse(pageQuery, request.query, reply, "query");
        if (!query || badCursor(query.cursor, parseLibraryCursor, reply)) return reply;
        const page = await store.listLibraries(principal.userId, { limit: query.limit, cursor: query.cursor ?? null });
        return reply.send({ items: page.items.map(libraryJson), nextCursor: page.nextCursor });
      }),
    );

    scope.get(
      "/api/ds/libraries/:id",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        if (!params) return reply;
        const found = await store.getLibrary(params.id, principal.userId);
        if (!found) return notFound(reply);
        return reply.send({ ...libraryJson(found.library), latest: found.latest });
      }),
    );

    scope.patch(
      "/api/ds/libraries/:id",
      { config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const body = params && parse(patchBody, request.body, reply, "body");
        if (!params || !body) return reply;
        const result = await store.updateLibrary(params.id, principal, body);
        if (result.kind === "not_found") return notFound(reply);
        if (result.kind === "forbidden") return forbidden(reply, result.code);
        if (result.kind === "archived") return send(reply, 409, "archived", "This library is archived.");
        if (result.kind === "name_taken") return send(reply, 409, "name_taken", "A library with this name already exists here.");
        return reply.send(libraryJson(result.library));
      }),
    );

    scope.delete(
      "/api/ds/libraries/:id",
      { config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const query = params && parse(deleteQuery, request.query, reply, "query");
        if (!params || !query) return reply;
        if (query.purge === "true") {
          // Hard delete, only after an archive: consumers had their chance to move.
          const purged = await store.purgeLibrary(params.id, principal);
          if (typeof purged === "object") return forbidden(reply, purged.code);
          if (purged === "not_found") return notFound(reply);
          if (purged === "not_archived") return send(reply, 409, "not_archived", "Archive the library before deleting it for good.");
          return reply.status(204).send();
        }
        // Archive only: consumers stay pinned and old versions stay readable.
        const archived = await store.archiveLibrary(params.id, principal);
        if (typeof archived === "object") return forbidden(reply, archived.code);
        return archived === "archived" ? reply.status(204).send() : notFound(reply);
      }),
    );

    // ---- preview and publish --------------------------------------------

    scope.post(
      "/api/ds/libraries/:id/preview",
      { bodyLimit: PUBLISH_BODY_LIMIT, config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const body = params && parse(previewBody, request.body, reply, "body");
        if (!params || !body) return reply;
        // A preview is the first half of a publish: same permission.
        if (!(await authorize(store, principal, params.id, "publish", reply))) return reply;
        const prepared = prepareSnapshot(body.snapshot);
        if (snapshotTooLarge(prepared, body.snapshot)) return send(reply, 413, "snapshot_too_large", "The snapshot is larger than 4 MB.");
        const ctx = await store.getPublishContext(params.id, principal.userId);
        if (!ctx) return notFound(reply);
        const checked = checkBaseAndSnapshot(ctx, body.baseVersion, prepared.validation);
        if ("kind" in checked) return send(reply, checked.status, checked.code, checked.message, checked.details);
        const analysis = analyze(ctx.latest?.snapshot ?? null, checked.snapshot, ctx.latest?.version ?? null);
        return reply.send({
          latestVersion: ctx.latest?.version ?? null,
          requiredBump: analysis.requiredBump,
          nextVersions: analysis.nextVersions,
          summary: analysis.diff.summary,
          violations: analysis.violations.map(({ code, entity, message }) => ({ code, entity, message })),
          migrations: analysis.migrations,
        });
      }),
    );

    scope.post(
      "/api/ds/libraries/:id/versions",
      { bodyLimit: PUBLISH_BODY_LIMIT, config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        if (!params) return reply;
        const key = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
        if (!key.success) {
          return send(reply, 400, "idempotency_key_required", "Send an Idempotency-Key header of 8 to 128 printable characters.");
        }
        const body = parse(publishBody, request.body, reply, "body");
        if (!body) return reply;
        const prepared = prepareSnapshot(body.snapshot);
        if (snapshotTooLarge(prepared, body.snapshot)) return send(reply, 413, "snapshot_too_large", "The snapshot is larger than 4 MB.");
        const changelogJson = JSON.stringify(body.changelog);
        if (Buffer.byteLength(changelogJson, "utf8") > MAX_CHANGELOG_BYTES) {
          return send(reply, 413, "changelog_too_large", "The changelog is larger than 512 KB.");
        }
        // Identity of the request without re-serializing the snapshot: its hash stands in for it.
        const snapshotDigest = prepared.validation.ok ? prepared.hash : sha256Hex(canonicalJson(body.snapshot ?? null));

        const outcome = await store.publish(
          { libraryId: params.id, principal, idempotencyKey: key.data },
          decidePublish({
            baseVersion: body.baseVersion,
            bump: body.bump,
            snapshot: prepared,
            changelog: body.changelog,
            notes: body.notes,
            idempotencyKey: key.data,
            requestHash: sha256Hex(canonicalJson({ baseVersion: body.baseVersion, bump: body.bump, notes: body.notes, changelog: body.changelog, snapshotDigest })),
          }),
        );
        if (outcome.kind === "not_found") return notFound(reply);
        if (outcome.kind === "forbidden") return forbidden(reply, outcome.code);
        if (outcome.kind === "reject") return send(reply, outcome.status, outcome.code, outcome.message, outcome.details);

        const location = `/api/ds/libraries/${params.id}/versions/${outcome.result.version}`;
        reply.header("Location", location);
        if (outcome.kind === "replay") reply.header("Idempotent-Replayed", "true");
        else {
          // Counts and enums only: never names, markup or labels. The publish
          // is committed; nothing here may turn it into an error.
          try {
            analytics.capture({
              event: "ds_published",
              distinctId: principal.userId,
              properties: { bump: outcome.result.bump, ...outcome.summary },
            });
          } catch (err) {
            request.log.warn({ err }, "[ds] analytics capture failed");
          }
        }
        return reply.status(outcome.kind === "replay" ? 200 : 201).send(outcome.result);
      }),
    );

    // ---- versions --------------------------------------------------------

    scope.get(
      "/api/ds/libraries/:id/versions",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const query = params && parse(pageQuery, request.query, reply, "query");
        if (!params || !query || badCursor(query.cursor, parseVersionCursor, reply)) return reply;
        const page = await store.listVersions(params.id, principal.userId, { limit: query.limit, cursor: query.cursor ?? null });
        return page ? reply.send(page) : notFound(reply);
      }),
    );

    scope.get(
      "/api/ds/libraries/:id/versions/:version",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(versionParams, request.params, reply, "path");
        if (!params) return reply;
        const isLatest = params.version === "latest";
        if (!isLatest && parseVersion(params.version) === null) return notFound(reply, "Version");
        const found = await store.getVersion(params.id, principal.userId, params.version);
        if (found.kind === "no_library") return notFound(reply);
        if (found.kind === "no_version") return notFound(reply, "Version");
        const { version } = found;
        // The hash alone repeats when a later version reverts to an earlier snapshot.
        const etag = `"${version.version}:${version.snapshotHash}"`;
        reply.header("ETag", etag);
        // A pinned version never changes; "latest" moves with every publish.
        reply.header("Cache-Control", isLatest ? "private, no-cache" : "private, max-age=31536000, immutable");
        if (matchesEtag(request.headers["if-none-match"], etag)) return reply.status(304).send();
        return reply.send(version);
      }),
    );

    scope.get(
      "/api/ds/libraries/:id/updates",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const query = params && parse(updatesQuery, request.query, reply, "query");
        if (!params || !query) return reply;
        const updates = await store.listUpdates(params.id, principal.userId, query.from, query.limit);
        if (updates.kind === "no_library") return notFound(reply);
        if (updates.kind === "no_version") return notFound(reply, "Version");
        const last = updates.items[updates.items.length - 1];
        return reply.send({
          current: query.from,
          latest: updates.latest,
          items: updates.items,
          // When true, ask again with from = nextFrom before applying anything.
          hasMore: updates.hasMore,
          nextFrom: updates.hasMore && last ? last.version : null,
        });
      }),
    );

    // ---- adoption usage (counts only) ------------------------------------

    scope.put(
      "/api/ds/libraries/:id/usage/:documentKey",
      { bodyLimit: USAGE_BODY_LIMIT, config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(usageParams, request.params, reply, "path");
        const body = params && parse(usageBody, request.body, reply, "body");
        if (!params || !body) return reply;
        if (Buffer.byteLength(JSON.stringify(body.metrics), "utf8") > MAX_USAGE_METRICS_BYTES) {
          return send(reply, 413, "metrics_too_large", "The usage report is larger than 64 KB.");
        }
        const result = await store.reportUsage({
          libraryId: params.id,
          principal,
          documentKey: params.documentKey,
          version: body.version,
          metrics: body.metrics,
        });
        if (result.kind === "not_found") return notFound(reply);
        if (result.kind === "forbidden") return forbidden(reply, result.code);
        if (result.kind === "unknown_version") return send(reply, 422, "unknown_version", "This library has no such version.");
        if (result.kind === "unknown_ids") {
          return send(reply, 422, "unknown_ids", "The report names variables or components that are not in this version.", { count: result.count });
        }
        // Buckets only: the report is committed, nothing here may fail the request.
        try {
          analytics.capture({
            event: "ds_usage_reported",
            distinctId: principal.userId,
            properties: { ...usageAnalytics(body.metrics), replaced: result.replaced },
          });
        } catch (err) {
          request.log.warn({ err }, "[ds] analytics capture failed");
        }
        return reply.status(204).send();
      }),
    );

    scope.delete(
      "/api/ds/libraries/:id/usage/:documentKey",
      { config: WRITE_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(usageParams, request.params, reply, "path");
        if (!params) return reply;
        const result = await store.deleteUsage({ libraryId: params.id, principal, documentKey: params.documentKey });
        if (result === "not_found") return notFound(reply);
        if (typeof result === "object") return forbidden(reply, result.code);
        return reply.status(204).send();
      }),
    );

    scope.get(
      "/api/ds/libraries/:id/usage/summary",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        if (!params) return reply;
        const summary = await store.getUsageSummary(params.id, principal);
        if (summary === null) return notFound(reply);
        if ("kind" in summary) return forbidden(reply, summary.code);
        return reply.send(summary);
      }),
    );

    scope.get(
      "/api/ds/libraries/:id/usage/documents",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const query = params && parse(usageDocumentsQuery, request.query, reply, "query");
        if (!params || !query) return reply;
        const page = await store.listUsageDocuments(params.id, principal, {
          limit: query.limit,
          offset: query.cursor ? Number(query.cursor) : 0,
          sort: query.sort,
        });
        if (page === null) return notFound(reply);
        if ("kind" in page) return forbidden(reply, page.code);
        return reply.send(page);
      }),
    );

    // ---- audit -----------------------------------------------------------

    scope.get(
      "/api/ds/libraries/:id/audit",
      { config: READ_LIMIT },
      guarded(async ({ store, principal }, request, reply) => {
        const params = parse(idParam, request.params, reply, "path");
        const query = params && parse(auditQuery, request.query, reply, "query");
        if (!params || !query || badCursor(query.cursor, parseAuditCursor, reply)) return reply;
        if (!(await authorize(store, principal, params.id, "admin", reply))) return reply;
        const page = await store.listAudit(params.id, { limit: query.limit, cursor: query.cursor ?? null, action: query.action ?? null });
        return reply.send(page);
      }),
    );
  });
}
