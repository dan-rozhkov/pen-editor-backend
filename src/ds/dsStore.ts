// All SQL against `ds_libraries` / `ds_versions`. Same shape as
// sharedCanvasStore.ts: a pool-shaped dependency tests can inject, a plain
// object implementing the interface, one module-level singleton for production
// wiring. Unlike the other stores, publish needs a real transaction
// (BEGIN / SELECT ... FOR UPDATE / INSERT / COMMIT), so the pool also exposes
// connect(). Every method takes the caller's account id and filters on it in
// SQL (reads join ds_libraries and the caller's `member` row): a library the
// caller has no role on is indistinguishable from one that does not exist,
// whatever the caller checked before. Writes take the Principal and re-check
// its role inside the transaction; each one writes its audit_log row on the
// same client, so the row and the change commit or roll back together.
import { createPgPool } from "../tracing/traceStore.js";
import type { Migration, DiffSummary } from "./diff.js";
import { can, isDsRole, type DsAction, type DsRole, type Principal } from "./access.js";
import { actorOf, insertAudit, listAudit, type AuditItem } from "./audit.js";
import { parseVersion, type Semver } from "./semver.js";
import type { Snapshot } from "./snapshotSchema.js";

export interface DsClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface DsPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<DsClient>;
  end(): Promise<void>;
}

const DS_POOL_CONNECTION_TIMEOUT_MS = 5_000;

/** Live (not archived) libraries per owner. */
export const MAX_LIBRARIES_PER_OWNER = 20;
/** Live plus archived: archiving frees a live slot, only a purge frees storage. */
export const MAX_TOTAL_LIBRARIES_PER_OWNER = 40;
export const MAX_VERSIONS_PER_LIBRARY = 500;

export interface DsLibrary {
  id: string;
  ownerId: string;
  /** The organization the library belongs to; null = a personal library. */
  orgId: string | null;
  /** The caller's role on this library. */
  role: DsRole;
  name: string;
  description: string;
  latestVersion: string | null;
  latestPublishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DsLatestVersionMeta {
  version: string;
  bump: string;
  publishedAt: Date;
  publishedBy: string;
  snapshotHash: string;
}

export interface DsVersionListItem {
  version: string;
  bump: string;
  publishedAt: Date;
  publishedBy: string;
  summary: DiffSummary;
}

export interface DsVersion extends DsVersionListItem {
  baseVersion: string | null;
  notes: string;
  snapshot: Snapshot;
  snapshotHash: string;
  changelog: unknown;
  migrations: Migration[];
}

export interface DsUpdateItem {
  version: string;
  bump: string;
  notes: string;
  changelog: unknown;
  migrations: Migration[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PublishedVersion {
  version: string;
  bump: string;
  publishedAt: Date;
  publishedBy: string;
  snapshotHash: string;
}

export interface NewVersion {
  version: string;
  bump: "initial" | "major" | "minor" | "patch";
  baseVersion: string | null;
  /** Canonical JSON of the validated snapshot: serialized once, hashed and stored as is. */
  snapshotJson: string;
  snapshotHash: string;
  changelog: unknown;
  summary: DiffSummary;
  migrations: Migration[];
  notes: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface PublishContext {
  library: DsLibrary;
  latest: { version: string; snapshot: Snapshot; snapshotHash: string } | null;
  /** The version already stored under this Idempotency-Key, if any. */
  replay: (PublishedVersion & { requestHash: string | null }) | null;
  versionCount: number;
}

export interface PublishRejection {
  kind: "reject";
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type PublishDecision = PublishRejection | { kind: "replay"; result: PublishedVersion } | { kind: "insert"; version: NewVersion };

export type PublishOutcome =
  | { kind: "not_found" }
  | PublishRejection
  | { kind: "replay"; result: PublishedVersion }
  | { kind: "created"; result: PublishedVersion; summary: DiffSummary };

export type CreateLibraryResult =
  | { kind: "created"; library: DsLibrary }
  | { kind: "name_taken" }
  /** The organization does not exist or the caller is not a member. */
  | { kind: "org_not_found" }
  | { kind: "forbidden" }
  | { kind: "limit"; live: number; total: number };
export type PurgeLibraryResult = "purged" | "not_found" | "not_archived";
export type VersionLookup = { kind: "no_library" } | { kind: "no_version" } | { kind: "ok"; version: DsVersion };
export type UpdatesLookup =
  | { kind: "no_library" }
  | { kind: "no_version" }
  | { kind: "ok"; latest: string | null; items: DsUpdateItem[]; hasMore: boolean };
export type UpdateLibraryResult = { kind: "updated"; library: DsLibrary } | { kind: "not_found" } | { kind: "name_taken" } | { kind: "archived" };

export interface DsStore {
  /** `orgId` set = the library belongs to that organization (the caller needs write there). */
  createLibrary(input: { id: string; principal: Principal; orgId?: string | null; name: string; description: string }): Promise<CreateLibraryResult>;
  /** Personal libraries of `userId` plus every organization library they are a member of. */
  listLibraries(userId: string, page: { limit: number; cursor: string | null }): Promise<Page<DsLibrary>>;
  /** Null when the library does not exist or the caller has no role on it. */
  getLibrary(id: string, userId: string): Promise<{ library: DsLibrary; latest: DsLatestVersionMeta | null } | null>;
  /** The caller's role on the library, or null when there is none (or no library). */
  getRole(id: string, userId: string): Promise<DsRole | null>;
  updateLibrary(id: string, principal: Principal, patch: { name?: string; description?: string }): Promise<UpdateLibraryResult>;
  /** Idempotent: archiving an archived library is still true. False = not found (or role too low). */
  archiveLibrary(id: string, principal: Principal): Promise<boolean>;
  /** Hard delete, only of an archived library (its versions go with it). */
  purgeLibrary(id: string, principal: Principal): Promise<PurgeLibraryResult>;
  /** One transaction: lock the library row, let `decide` rule, insert the version and its audit row. */
  publish(
    input: { libraryId: string; principal: Principal; idempotencyKey: string },
    decide: (ctx: PublishContext) => PublishDecision,
  ): Promise<PublishOutcome>;
  /** Read-only twin of publish's context, for preview. */
  getPublishContext(libraryId: string, userId: string): Promise<Omit<PublishContext, "replay"> | null>;
  /** Null when the library does not exist or the caller has no role on it. */
  listVersions(libraryId: string, userId: string, page: { limit: number; cursor: string | null }): Promise<Page<DsVersionListItem> | null>;
  /** `version` may be "latest". */
  getVersion(libraryId: string, userId: string, version: string): Promise<VersionLookup>;
  /** Versions strictly after `from`, oldest first. */
  listUpdates(libraryId: string, userId: string, from: string, limit: number): Promise<UpdatesLookup>;
  /** The library's audit history, newest first. The caller checks the admin role first. */
  listAudit(libraryId: string, page: { limit: number; cursor: string | null; action: string | null }): Promise<Page<AuditItem>>;
  close(): Promise<void>;
}

interface LibraryRow {
  id: string;
  owner_id: string;
  org_id: string | null;
  role: string;
  name: string;
  description: string;
  latest_version: string | null;
  latest_published_at: string | Date | null;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  cursor_ts?: string;
}

// The caller's role on library `l`, resolved in SQL. A personal library
// (org_id NULL) belongs to its owner alone. An organization library takes the
// best role the caller's `member` row names; a role outside owner / editor /
// viewer (a legacy or multi-role string) grants nothing. `$u` is the
// placeholder holding the caller's account id.
const ROLE_RANK = `CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`;
const libraryFrom = (u: string) => `ds_libraries l
  LEFT JOIN LATERAL (
    SELECT role FROM member
     WHERE "organizationId" = l.org_id AND "userId" = ${u} AND role IN ('owner', 'editor', 'viewer')
     ORDER BY ${ROLE_RANK} LIMIT 1
  ) m ON true`;
const roleSql = (u: string) => `(CASE WHEN l.org_id IS NULL THEN (CASE WHEN l.owner_id = ${u} THEN 'owner' END) ELSE m.role END)`;
const LIBRARY_COLUMNS = (u: string) =>
  `l.id, l.owner_id, l.org_id, ${roleSql(u)} AS role, l.name, l.description, l.latest_version, l.latest_published_at, l.archived_at, l.created_at, l.updated_at`;
// Keyset cursors must carry the timestamp at Postgres precision (microseconds):
// a JS Date truncates to milliseconds and would silently skip or repeat rows.
const CURSOR_TS = `to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const date = (v: string | Date | null): Date | null => (v === null ? null : new Date(v));

function toLibrary(row: LibraryRow): DsLibrary {
  return {
    id: row.id,
    ownerId: row.owner_id,
    orgId: row.org_id,
    role: row.role as DsRole,
    name: row.name,
    description: row.description,
    latestVersion: row.latest_version,
    latestPublishedAt: date(row.latest_published_at),
    archivedAt: date(row.archived_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, arity: number): string[] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(parsed) && parsed.length === arity && parsed.every((p) => typeof p === "string")) return parsed as string[];
  } catch {
    // fall through
  }
  return null;
}

// A year range Postgres accepts for sure, microsecond precision, always UTC.
const CURSOR_TS_RE = /^((?:19|20|21)\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,6})?Z$/;
const CURSOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The decoded library cursor, or null when it is not one this server could have issued. */
export function parseLibraryCursor(cursor: string): { createdAt: string; id: string } | null {
  const parts = decodeCursor(cursor, 2);
  if (!parts) return null;
  const [createdAt, id] = parts;
  const m = CURSOR_TS_RE.exec(createdAt);
  if (!m || !CURSOR_ID_RE.test(id)) return null;
  // Date.parse rolls Feb 31 over; the round trip does not.
  const ms = Date.parse(`${m[1]}Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) return null;
  return { createdAt, id };
}

export function parseVersionCursor(cursor: string): Semver | null {
  const parts = decodeCursor(cursor, 1);
  return parts ? parseVersion(parts[0]) : null;
}

function uniqueViolation(err: unknown, constraintPart: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string } | null;
  if (e?.code !== "23505") return false;
  return `${e.constraint ?? ""} ${e.message ?? ""}`.includes(constraintPart);
}

interface VersionRow {
  version: string;
  bump: string;
  base_version: string | null;
  snapshot: Snapshot;
  snapshot_hash: string;
  changelog: unknown;
  summary: DiffSummary;
  migrations: Migration[];
  notes: string;
  published_by: string;
  published_at: string | Date;
  request_hash?: string | null;
  major?: number;
  minor?: number;
  patch?: number;
}

export function createDsStore(connectionString: string | undefined, pool?: DsPool): DsStore | null {
  if (!pool && !connectionString) return null;
  const db: DsPool =
    pool ?? (createPgPool(connectionString!, { connectionTimeoutMillis: DS_POOL_CONNECTION_TIMEOUT_MS }) as unknown as DsPool);
  // More than one buildApp() can share one store object; a real pg.Pool throws
  // on a second end().
  let closed = false;

  /** The library, when `userId` holds any role on it. `lock` takes the row lock (FOR UPDATE OF l). */
  const fetchLibrary = async (q: Pick<DsPool, "query">, id: string, userId: string, lock = false): Promise<DsLibrary | null> => {
    const r = (await q.query(
      `SELECT ${LIBRARY_COLUMNS("$2")} FROM ${libraryFrom("$2")}
        WHERE l.id = $1 AND ${roleSql("$2")} IS NOT NULL${lock ? " FOR UPDATE OF l" : ""}`,
      [id, userId],
    )) as { rows: LibraryRow[] };
    return r.rows[0] ? toLibrary(r.rows[0]) : null;
  };

  /** Locks the library and requires `action` of the principal; anything less reads as "not found". */
  const lockFor = async (client: DsClient, id: string, principal: Principal, action: DsAction): Promise<DsLibrary | null> => {
    const library = await fetchLibrary(client, id, principal.userId, true);
    return library && can(principal, library.role, action) ? library : null;
  };

  const inTransaction = async <T>(fn: (client: DsClient) => Promise<T>): Promise<T> => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  const loadContext = async (q: Pick<DsPool, "query">, library: DsLibrary) => {
    let latest: PublishContext["latest"] = null;
    if (library.latestVersion) {
      const r = (await q.query(
        "SELECT version, snapshot, snapshot_hash FROM ds_versions WHERE library_id = $1 AND version = $2",
        [library.id, library.latestVersion],
      )) as { rows: Array<{ version: string; snapshot: Snapshot; snapshot_hash: string }> };
      if (r.rows[0]) latest = { version: r.rows[0].version, snapshot: r.rows[0].snapshot, snapshotHash: r.rows[0].snapshot_hash };
    }
    const c = (await q.query("SELECT count(*)::int AS count FROM ds_versions WHERE library_id = $1", [library.id])) as {
      rows: Array<{ count: number }>;
    };
    return { library, latest, versionCount: c.rows[0]?.count ?? 0 };
  };

  return {
    async createLibrary({ id, principal, orgId = null, name, description }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // READ COMMITTED lets two creates both count 19 and both insert. The
        // transaction-scoped lock queues an account's creates behind each other
        // (and is released by COMMIT/ROLLBACK, so a crash cannot leak it).
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ds_libraries:${principal.userId}`]);
        let role: DsRole = "owner";
        if (orgId !== null) {
          const m = (await client.query(
            `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 AND role IN ('owner', 'editor', 'viewer')
              ORDER BY ${ROLE_RANK} LIMIT 1`,
            [orgId, principal.userId],
          )) as { rows: Array<{ role: string }> };
          if (!m.rows[0] || !isDsRole(m.rows[0].role)) {
            await client.query("ROLLBACK");
            return { kind: "org_not_found" };
          }
          role = m.rows[0].role;
        }
        if (!can(principal, role, "write")) {
          await client.query("ROLLBACK");
          return { kind: "forbidden" };
        }
        const counts = (await client.query(
          `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS live, count(*)::int AS total
             FROM ds_libraries WHERE owner_id = $1`,
          [principal.userId],
        )) as { rows: Array<{ live: number; total: number }> };
        const { live, total } = counts.rows[0] ?? { live: 0, total: 0 };
        if (live >= MAX_LIBRARIES_PER_OWNER || total >= MAX_TOTAL_LIBRARIES_PER_OWNER) {
          await client.query("ROLLBACK");
          return { kind: "limit", live, total };
        }
        await client.query("INSERT INTO ds_libraries (id, owner_id, org_id, name, description) VALUES ($1, $2, $3, $4, $5)", [
          id, principal.userId, orgId, name, description,
        ]);
        await insertAudit(client, {
          ...actorOf(principal),
          libraryId: id,
          orgId,
          action: "library.create",
          targetType: "library",
          targetId: id,
          meta: { scope: orgId === null ? "personal" : "org" },
        });
        const library = await fetchLibrary(client, id, principal.userId);
        if (!library) throw new Error("created library is not readable by its creator");
        await client.query("COMMIT");
        return { kind: "created", library };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (uniqueViolation(err, "owner_name") || uniqueViolation(err, "org_name")) return { kind: "name_taken" };
        throw err;
      } finally {
        client.release();
      }
    },

    async listLibraries(userId, { limit, cursor }) {
      const params: unknown[] = [userId];
      let where = `${roleSql("$1")} IS NOT NULL AND l.archived_at IS NULL`;
      const key = cursor ? parseLibraryCursor(cursor) : null;
      if (key) {
        params.push(key.createdAt, key.id);
        where += " AND (l.created_at, l.id) < ($2::timestamptz, $3)";
      }
      params.push(limit + 1);
      const r = (await db.query(
        `SELECT ${LIBRARY_COLUMNS("$1")}, ${CURSOR_TS} AS cursor_ts FROM ${libraryFrom("$1")}
          WHERE ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length}`,
        params,
      )) as { rows: LibraryRow[] };
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map(toLibrary),
        nextCursor: r.rows.length > limit && last ? encodeCursor([last.cursor_ts as string, last.id]) : null,
      };
    },

    async getLibrary(id, userId) {
      const library = await fetchLibrary(db, id, userId);
      if (!library) return null;
      let latest: DsLatestVersionMeta | null = null;
      if (library.latestVersion) {
        const r = (await db.query(
          "SELECT version, bump, published_at, published_by, snapshot_hash FROM ds_versions WHERE library_id = $1 AND version = $2",
          [id, library.latestVersion],
        )) as { rows: Array<{ version: string; bump: string; published_at: string | Date; published_by: string; snapshot_hash: string }> };
        const row = r.rows[0];
        if (row) {
          latest = {
            version: row.version,
            bump: row.bump,
            publishedAt: new Date(row.published_at),
            publishedBy: row.published_by,
            snapshotHash: row.snapshot_hash,
          };
        }
      }
      return { library, latest };
    },

    async getRole(id, userId) {
      return (await fetchLibrary(db, id, userId))?.role ?? null;
    },

    async updateLibrary(id, principal, patch) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const library = await lockFor(client, id, principal, "write");
        if (!library) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        if (library.archivedAt) {
          await client.query("ROLLBACK");
          return { kind: "archived" };
        }
        await client.query(
          `UPDATE ds_libraries SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now() WHERE id = $1`,
          [id, patch.name ?? null, patch.description ?? null],
        );
        await insertAudit(client, {
          ...actorOf(principal),
          libraryId: id,
          orgId: library.orgId,
          action: "library.update",
          targetType: "library",
          targetId: id,
          meta: { fields: [patch.name !== undefined ? "name" : "", patch.description !== undefined ? "description" : ""].filter(Boolean) },
        });
        const updated = await fetchLibrary(client, id, principal.userId);
        await client.query("COMMIT");
        return updated ? { kind: "updated", library: updated } : { kind: "not_found" };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (uniqueViolation(err, "owner_name") || uniqueViolation(err, "org_name")) return { kind: "name_taken" };
        throw err;
      } finally {
        client.release();
      }
    },

    async archiveLibrary(id, principal) {
      return inTransaction(async (client) => {
        const library = await lockFor(client, id, principal, "admin");
        if (!library) return false;
        // Idempotent: only the first archive changes anything, so only it is audited.
        if (!library.archivedAt) {
          await client.query("UPDATE ds_libraries SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
          await insertAudit(client, {
            ...actorOf(principal),
            libraryId: id,
            orgId: library.orgId,
            action: "library.archive",
            targetType: "library",
            targetId: id,
          });
        }
        return true;
      });
    },

    async purgeLibrary(id, principal) {
      return inTransaction(async (client): Promise<PurgeLibraryResult> => {
        const library = await lockFor(client, id, principal, "admin");
        if (!library) return "not_found";
        if (!library.archivedAt) return "not_archived";
        const versions = (await client.query("SELECT count(*)::int AS count FROM ds_versions WHERE library_id = $1", [id])) as {
          rows: Array<{ count: number }>;
        };
        await client.query("DELETE FROM ds_libraries WHERE id = $1", [id]);
        await insertAudit(client, {
          ...actorOf(principal),
          libraryId: id,
          orgId: library.orgId,
          action: "library.purge",
          targetType: "library",
          targetId: id,
          meta: { versions: versions.rows[0]?.count ?? 0 },
        });
        return "purged";
      });
    },

    async publish({ libraryId, principal, idempotencyKey }, decide) {
      const publishedBy = principal.userId;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const library = await lockFor(client, libraryId, principal, "publish");
        if (!library) {
          await client.query("ROLLBACK");
          return { kind: "not_found" };
        }
        const base = await loadContext(client, library);
        const replayRows = (await client.query(
          `SELECT version, bump, published_at, published_by, snapshot_hash, request_hash
             FROM ds_versions WHERE library_id = $1 AND idempotency_key = $2`,
          [libraryId, idempotencyKey],
        )) as { rows: Array<VersionRow & { snapshot_hash: string }> };
        const rr = replayRows.rows[0];
        const decision = decide({
          ...base,
          replay: rr
            ? {
                version: rr.version,
                bump: rr.bump,
                publishedAt: new Date(rr.published_at),
                publishedBy: rr.published_by,
                snapshotHash: rr.snapshot_hash,
                requestHash: rr.request_hash ?? null,
              }
            : null,
        });
        if (decision.kind !== "insert") {
          await client.query("ROLLBACK");
          return decision;
        }
        const v = decision.version;
        const parsed = parseVersion(v.version);
        if (!parsed) throw new Error(`publish produced an invalid version "${v.version}"`);
        const { major, minor, patch } = parsed;
        const inserted = (await client.query(
          `INSERT INTO ds_versions
             (library_id, version, major, minor, patch, bump, base_version, snapshot, snapshot_hash,
              changelog, summary, migrations, notes, published_by, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16)
           RETURNING published_at`,
          [
            libraryId, v.version, major, minor, patch, v.bump, v.baseVersion, v.snapshotJson, v.snapshotHash,
            JSON.stringify(v.changelog), JSON.stringify(v.summary), JSON.stringify(v.migrations), v.notes, publishedBy,
            v.idempotencyKey, v.requestHash,
          ],
        )) as { rows: Array<{ published_at: string | Date }> };
        const publishedAt = new Date(inserted.rows[0].published_at);
        await client.query(
          "UPDATE ds_libraries SET latest_version = $2, latest_published_at = $3, updated_at = now() WHERE id = $1",
          [libraryId, v.version, publishedAt],
        );
        await insertAudit(client, {
          ...actorOf(principal),
          libraryId,
          orgId: library.orgId,
          action: "version.publish",
          targetType: "version",
          targetId: v.version,
          beforeHash: base.latest?.snapshotHash ?? null,
          afterHash: v.snapshotHash,
          meta: { bump: v.bump },
        });
        await client.query("COMMIT");
        return {
          kind: "created",
          result: { version: v.version, bump: v.bump, publishedAt, publishedBy, snapshotHash: v.snapshotHash },
          summary: v.summary,
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        // The (library_id, version) key is the backstop behind the row lock.
        if (uniqueViolation(err, "ds_versions")) {
          return { kind: "reject", status: 409, code: "version_conflict", message: "Another publish created this version first. Reload and review." };
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async getPublishContext(libraryId, userId) {
      const library = await fetchLibrary(db, libraryId, userId);
      return library ? loadContext(db, library) : null;
    },

    async listVersions(libraryId, userId, { limit, cursor }) {
      const params: unknown[] = [libraryId, userId];
      let on = "v.library_id = l.id";
      const key = cursor ? parseVersionCursor(cursor) : null;
      if (key) {
        params.push(key.major, key.minor, key.patch);
        on += " AND (v.major, v.minor, v.patch) < ($3, $4, $5)";
      }
      params.push(limit + 1);
      // LEFT JOIN: an existing library with no (more) versions still yields a
      // row, which is how "empty" differs from "not yours" in one query.
      const r = (await db.query(
        `SELECT v.version, v.bump, v.summary, v.published_by, v.published_at
           FROM ${libraryFrom("$2")} LEFT JOIN ds_versions v ON ${on}
          WHERE l.id = $1 AND ${roleSql("$2")} IS NOT NULL
          ORDER BY v.major DESC, v.minor DESC, v.patch DESC LIMIT $${params.length}`,
        params,
      )) as { rows: Array<Partial<VersionRow>> };
      if (r.rows.length === 0) return null;
      const found = r.rows.filter((row): row is VersionRow => row.version != null);
      const rows = found.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map((row) => ({
          version: row.version,
          bump: row.bump,
          publishedAt: new Date(row.published_at),
          publishedBy: row.published_by,
          summary: row.summary,
        })),
        nextCursor: found.length > limit && last ? encodeCursor([last.version]) : null,
      };
    },

    async getVersion(libraryId, userId, version) {
      const r = (await db.query(
        `SELECT v.version, v.bump, v.base_version, v.snapshot, v.snapshot_hash, v.changelog, v.summary,
                v.migrations, v.notes, v.published_by, v.published_at
           FROM ${libraryFrom("$2")}
           LEFT JOIN ds_versions v ON v.library_id = l.id AND v.version = ${version === "latest" ? "l.latest_version" : "$3"}
          WHERE l.id = $1 AND ${roleSql("$2")} IS NOT NULL`,
        version === "latest" ? [libraryId, userId] : [libraryId, userId, version],
      )) as { rows: Array<Partial<VersionRow>> };
      const row = r.rows[0];
      if (!row) return { kind: "no_library" };
      if (row.version == null) return { kind: "no_version" };
      const v = row as VersionRow;
      return {
        kind: "ok",
        version: {
          version: v.version,
          bump: v.bump,
          baseVersion: v.base_version,
          publishedAt: new Date(v.published_at),
          publishedBy: v.published_by,
          notes: v.notes,
          snapshot: v.snapshot,
          snapshotHash: v.snapshot_hash,
          changelog: v.changelog,
          summary: v.summary,
          migrations: v.migrations,
        },
      };
    },

    async listUpdates(libraryId, userId, from, limit) {
      const parts = parseVersion(from);
      if (!parts) {
        // Not a version of anything; still tell "no access" apart.
        return (await fetchLibrary(db, libraryId, userId)) ? { kind: "no_version" } : { kind: "no_library" };
      }
      const r = (await db.query(
        `SELECT l.latest_version,
                EXISTS (SELECT 1 FROM ds_versions f WHERE f.library_id = l.id AND f.version = $3) AS from_exists,
                v.version, v.bump, v.notes, v.changelog, v.migrations
           FROM ${libraryFrom("$2")}
           LEFT JOIN ds_versions v ON v.library_id = l.id AND (v.major, v.minor, v.patch) > ($4, $5, $6)
          WHERE l.id = $1 AND ${roleSql("$2")} IS NOT NULL
          ORDER BY v.major, v.minor, v.patch LIMIT $7`,
        [libraryId, userId, from, parts.major, parts.minor, parts.patch, limit + 1],
      )) as { rows: Array<Partial<VersionRow> & { latest_version: string | null; from_exists: boolean }> };
      const first = r.rows[0];
      if (!first) return { kind: "no_library" };
      if (!first.from_exists) return { kind: "no_version" };
      const found = r.rows.filter((row): row is typeof row & VersionRow => row.version != null);
      return {
        kind: "ok",
        latest: first.latest_version,
        items: found.slice(0, limit).map((row) => ({
          version: row.version,
          bump: row.bump,
          notes: row.notes,
          changelog: row.changelog,
          migrations: row.migrations,
        })),
        hasMore: found.length > limit,
      };
    },

    listAudit(libraryId, page) {
      return listAudit(db, libraryId, page);
    },

    async close() {
      if (closed) return;
      closed = true;
      await db.end();
    },
  };
}

let shared: { url: string; store: DsStore } | null = null;

export function getSharedDsStore(url: string | undefined): DsStore | null {
  if (!url) return null;
  if (shared?.url === url) return shared.store;
  if (shared) {
    // Only tests that rebuild Config per case ever change the URL.
    shared.store.close().catch((err) => console.error("[ds] failed to close previous pool:", err));
  }
  const store = createDsStore(url);
  if (!store) return null;
  shared = { url, store };
  return store;
}

/** Test-only: drops the module-level singleton. */
export function __resetSharedDsStore(): void {
  shared = null;
}
