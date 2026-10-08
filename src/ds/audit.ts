// The audit_log writer (migration 020). Ids, hashes, counts and enums only:
// never names, markup, changelog text or emails. Library writes call
// insertAudit on the SAME client as the change, inside its transaction, so a
// rollback leaves no row and a committed change always has one.
import type { Principal } from "./access.js";

export type AuditAction =
  | "library.create"
  | "library.update"
  | "library.archive"
  | "library.purge"
  | "version.publish"
  | "member.add"
  | "member.remove"
  | "member.role_change";

export type AuditActorKind = Principal["kind"] | "system";

export interface AuditEntry {
  libraryId?: string | null;
  orgId?: string | null;
  actorId: string;
  actorKind: AuditActorKind;
  clientId?: string | null;
  action: AuditAction;
  targetType: "library" | "version" | "member";
  targetId: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  meta?: Record<string, string | number | boolean | string[]>;
}

export interface AuditQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function actorOf(principal: Principal): Pick<AuditEntry, "actorId" | "actorKind" | "clientId"> {
  return { actorId: principal.userId, actorKind: principal.kind, clientId: principal.clientId ?? principal.keyId ?? null };
}

export async function insertAudit(q: AuditQueryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_log
       (library_id, org_id, actor_id, actor_kind, client_id, action, target_type, target_id, before_hash, after_hash, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      e.libraryId ?? null, e.orgId ?? null, e.actorId, e.actorKind, e.clientId ?? null, e.action,
      e.targetType, e.targetId, e.beforeHash ?? null, e.afterHash ?? null, JSON.stringify(e.meta ?? {}),
    ],
  );
}

export interface AuditItem {
  id: string;
  at: Date;
  action: string;
  actorId: string;
  actorKind: string;
  clientId: string | null;
  orgId: string | null;
  targetType: string;
  targetId: string;
  beforeHash: string | null;
  afterHash: string | null;
  meta: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  at: string | Date;
  action: string;
  actor_id: string;
  actor_kind: string;
  client_id: string | null;
  org_id: string | null;
  target_type: string;
  target_id: string;
  before_hash: string | null;
  after_hash: string | null;
  meta: Record<string, unknown>;
}

const AUDIT_ID_RE = /^[1-9]\d{0,17}$/;

export function encodeAuditCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/** The decoded audit id, or null when it is not a cursor this server issued. */
export function parseAuditCursor(cursor: string): string | null {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  return AUDIT_ID_RE.test(id) ? id : null;
}

/**
 * One library's history, newest first: its own events plus, for an
 * organization library, the organization's membership events.
 */
export async function listAudit(
  q: AuditQueryable,
  libraryId: string,
  page: { limit: number; cursor: string | null; action: string | null },
): Promise<{ items: AuditItem[]; nextCursor: string | null }> {
  const after = page.cursor ? parseAuditCursor(page.cursor) : null;
  const r = (await q.query(
    `SELECT a.id::text AS id, a.at, a.action, a.actor_id, a.actor_kind, a.client_id, a.org_id,
            a.target_type, a.target_id, a.before_hash, a.after_hash, a.meta
       FROM ds_libraries l
       JOIN audit_log a ON a.library_id = l.id OR (a.library_id IS NULL AND l.org_id IS NOT NULL AND a.org_id = l.org_id)
      WHERE l.id = $1
        AND ($2::text IS NULL OR a.action = $2)
        AND ($3::bigint IS NULL OR a.id < $3::bigint)
      ORDER BY a.id DESC LIMIT $4`,
    [libraryId, page.action, after, page.limit + 1],
  )) as { rows: AuditRow[] };
  const rows = r.rows.slice(0, page.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => ({
      id: row.id,
      at: new Date(row.at),
      action: row.action,
      actorId: row.actor_id,
      actorKind: row.actor_kind,
      clientId: row.client_id,
      orgId: row.org_id,
      targetType: row.target_type,
      targetId: row.target_id,
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      meta: row.meta,
    })),
    nextCursor: r.rows.length > page.limit && last ? encodeAuditCursor(last.id) : null,
  };
}
