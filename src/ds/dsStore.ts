// All SQL against `ds_libraries` / `ds_versions`. Same shape as
// sharedCanvasStore.ts: a pool-shaped dependency tests can inject, a plain
// object implementing the interface, one module-level singleton for production
// wiring. Unlike the other stores, publish needs a real transaction
// (BEGIN / SELECT ... FOR UPDATE / INSERT / COMMIT), so the pool also exposes
// connect(). Every method takes the owner id and filters on it in SQL (reads
// join ds_libraries): a library that belongs to somebody else is
// indistinguishable from one that does not exist, whatever the caller checked
// before.
import { createPgPool } from "../tracing/traceStore.js";
import type { Migration, DiffSummary } from "./diff.js";
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
  | { kind: "limit"; live: number; total: number };
export type PurgeLibraryResult = "purged" | "not_found" | "not_archived";
export type VersionLookup = { kind: "no_library" } | { kind: "no_version" } | { kind: "ok"; version: DsVersion };
export type UpdatesLookup =
  | { kind: "no_library" }
  | { kind: "no_version" }
  | { kind: "ok"; latest: string | null; items: DsUpdateItem[]; hasMore: boolean };
export type UpdateLibraryResult = { kind: "updated"; library: DsLibrary } | { kind: "not_found" } | { kind: "name_taken" } | { kind: "archived" };

export interface DsStore {
  createLibrary(input: { id: string; ownerId: string; name: string; description: string }): Promise<CreateLibraryResult>;
  listLibraries(ownerId: string, page: { limit: number; cursor: string | null }): Promise<Page<DsLibrary>>;
  /** Null when the library does not exist or belongs to someone else. */
  getLibrary(id: string, ownerId: string): Promise<{ library: DsLibrary; latest: DsLatestVersionMeta | null } | null>;
  updateLibrary(id: string, ownerId: string, patch: { name?: string; description?: string }): Promise<UpdateLibraryResult>;
  /** Idempotent: archiving an archived library is still true. False = not found. */
  archiveLibrary(id: string, ownerId: string): Promise<boolean>;
  /** Hard delete, only of an archived library (its versions go with it). */
  purgeLibrary(id: string, ownerId: string): Promise<PurgeLibraryResult>;
  /** One transaction: lock the library row, let `decide` rule, insert the version. */
  publish(
    input: { libraryId: string; ownerId: string; publishedBy: string; idempotencyKey: string },
    decide: (ctx: PublishContext) => PublishDecision,
  ): Promise<PublishOutcome>;
  /** Read-only twin of publish's context, for preview. */
  getPublishContext(libraryId: string, ownerId: string): Promise<Omit<PublishContext, "replay"> | null>;
  /** Null when the library does not exist or belongs to someone else. */
  listVersions(libraryId: string, ownerId: string, page: { limit: number; cursor: string | null }): Promise<Page<DsVersionListItem> | null>;
  /** `version` may be "latest". */
  getVersion(libraryId: string, ownerId: string, version: string): Promise<VersionLookup>;
  /** Versions strictly after `from`, oldest first. */
  listUpdates(libraryId: string, ownerId: string, from: string, limit: number): Promise<UpdatesLookup>;
  close(): Promise<void>;
}

interface LibraryRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  latest_version: string | null;
  latest_published_at: string | Date | null;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  cursor_ts?: string;
}

const LIBRARY_COLUMNS = "id, owner_id, name, description, latest_version, latest_published_at, archived_at, created_at, updated_at";
// Keyset cursors must carry the timestamp at Postgres precision (microseconds):
// a JS Date truncates to milliseconds and would silently skip or repeat rows.
const CURSOR_TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const date = (v: string | Date | null): Date | null => (v === null ? null : new Date(v));

function toLibrary(row: LibraryRow): DsLibrary {
  return {
    id: row.id,
    ownerId: row.owner_id,
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

  const fetchLibrary = async (q: Pick<DsPool, "query">, id: string, ownerId: string, lock = false): Promise<DsLibrary | null> => {
    const r = (await q.query(
      `SELECT ${LIBRARY_COLUMNS} FROM ds_libraries WHERE id = $1 AND owner_id = $2${lock ? " FOR UPDATE" : ""}`,
      [id, ownerId],
    )) as { rows: LibraryRow[] };
    return r.rows[0] ? toLibrary(r.rows[0]) : null;
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
    async createLibrary({ id, ownerId, name, description }) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // READ COMMITTED lets two creates both count 19 and both insert. The
        // transaction-scoped lock queues an owner's creates behind each other
        // (and is released by COMMIT/ROLLBACK, so a crash cannot leak it).
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ds_libraries:${ownerId}`]);
        const counts = (await client.query(
          `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS live, count(*)::int AS total
             FROM ds_libraries WHERE owner_id = $1`,
          [ownerId],
        )) as { rows: Array<{ live: number; total: number }> };
        const { live, total } = counts.rows[0] ?? { live: 0, total: 0 };
        if (live >= MAX_LIBRARIES_PER_OWNER || total >= MAX_TOTAL_LIBRARIES_PER_OWNER) {
          await client.query("ROLLBACK");
          return { kind: "limit", live, total };
        }
        const r = (await client.query(
          `INSERT INTO ds_libraries (id, owner_id, name, description) VALUES ($1, $2, $3, $4) RETURNING ${LIBRARY_COLUMNS}`,
          [id, ownerId, name, description],
        )) as { rows: LibraryRow[] };
        await client.query("COMMIT");
        return { kind: "created", library: toLibrary(r.rows[0]) };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (uniqueViolation(err, "owner_name")) return { kind: "name_taken" };
        throw err;
      } finally {
        client.release();
      }
    },

    async listLibraries(ownerId, { limit, cursor }) {
      const params: unknown[] = [ownerId];
      let where = "owner_id = $1 AND archived_at IS NULL";
      const key = cursor ? parseLibraryCursor(cursor) : null;
      if (key) {
        params.push(key.createdAt, key.id);
        where += " AND (created_at, id) < ($2::timestamptz, $3)";
      }
      params.push(limit + 1);
      const r = (await db.query(
        `SELECT ${LIBRARY_COLUMNS}, ${CURSOR_TS} AS cursor_ts FROM ds_libraries
          WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      )) as { rows: LibraryRow[] };
      const rows = r.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        items: rows.map(toLibrary),
        nextCursor: r.rows.length > limit && last ? encodeCursor([last.cursor_ts as string, last.id]) : null,
      };
    },

    async getLibrary(id, ownerId) {
      const library = await fetchLibrary(db, id, ownerId);
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

    async updateLibrary(id, ownerId, patch) {
      try {
        const r = (await db.query(
          `UPDATE ds_libraries
              SET name = COALESCE($3, name), description = COALESCE($4, description), updated_at = now()
            WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
            RETURNING ${LIBRARY_COLUMNS}`,
          [id, ownerId, patch.name ?? null, patch.description ?? null],
        )) as { rows: LibraryRow[] };
        if (r.rows[0]) return { kind: "updated", library: toLibrary(r.rows[0]) };
      } catch (err) {
        if (uniqueViolation(err, "owner_name")) return { kind: "name_taken" };
        throw err;
      }
      const existing = await fetchLibrary(db, id, ownerId);
      return existing ? { kind: "archived" } : { kind: "not_found" };
    },

    async archiveLibrary(id, ownerId) {
      const r = (await db.query(
        `UPDATE ds_libraries SET archived_at = COALESCE(archived_at, now()), updated_at = now()
          WHERE id = $1 AND owner_id = $2 RETURNING id`,
        [id, ownerId],
      )) as { rows: unknown[] };
      return r.rows.length > 0;
    },

    async purgeLibrary(id, ownerId) {
      const r = (await db.query(
        "DELETE FROM ds_libraries WHERE id = $1 AND owner_id = $2 AND archived_at IS NOT NULL RETURNING id",
        [id, ownerId],
      )) as { rows: unknown[] };
      if (r.rows.length > 0) return "purged";
      return (await fetchLibrary(db, id, ownerId)) ? "not_archived" : "not_found";
    },

    async publish({ libraryId, ownerId, publishedBy, idempotencyKey }, decide) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const library = await fetchLibrary(client, libraryId, ownerId, true);
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

    async getPublishContext(libraryId, ownerId) {
      const library = await fetchLibrary(db, libraryId, ownerId);
      return library ? loadContext(db, library) : null;
    },

    async listVersions(libraryId, ownerId, { limit, cursor }) {
      const params: unknown[] = [libraryId, ownerId];
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
           FROM ds_libraries l LEFT JOIN ds_versions v ON ${on}
          WHERE l.id = $1 AND l.owner_id = $2
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

    async getVersion(libraryId, ownerId, version) {
      const r = (await db.query(
        `SELECT v.version, v.bump, v.base_version, v.snapshot, v.snapshot_hash, v.changelog, v.summary,
                v.migrations, v.notes, v.published_by, v.published_at
           FROM ds_libraries l
           LEFT JOIN ds_versions v ON v.library_id = l.id AND v.version = ${version === "latest" ? "l.latest_version" : "$3"}
          WHERE l.id = $1 AND l.owner_id = $2`,
        version === "latest" ? [libraryId, ownerId] : [libraryId, ownerId, version],
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

    async listUpdates(libraryId, ownerId, from, limit) {
      const parts = parseVersion(from);
      if (!parts) {
        // Not a version of anything; still tell "not yours" apart.
        return (await fetchLibrary(db, libraryId, ownerId)) ? { kind: "no_version" } : { kind: "no_library" };
      }
      const r = (await db.query(
        `SELECT l.latest_version,
                EXISTS (SELECT 1 FROM ds_versions f WHERE f.library_id = l.id AND f.version = $3) AS from_exists,
                v.version, v.bump, v.notes, v.changelog, v.migrations
           FROM ds_libraries l
           LEFT JOIN ds_versions v ON v.library_id = l.id AND (v.major, v.minor, v.patch) > ($4, $5, $6)
          WHERE l.id = $1 AND l.owner_id = $2
          ORDER BY v.major, v.minor, v.patch LIMIT $7`,
        [libraryId, ownerId, from, parts.major, parts.minor, parts.patch, limit + 1],
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
