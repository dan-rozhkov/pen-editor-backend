// The real OrgAuditWriter: organization membership events into audit_log
// (migration 020). Ids and role enums only; the hooks never see emails here.
import { insertAudit, type AuditQueryable } from "../ds/audit.js";
import type { OrgAuditWriter } from "./orgAudit.js";

interface AuditPool {
  connect(): Promise<AuditQueryable & { release(): void }>;
}

export function createOrgAuditWriter(pool: AuditPool): OrgAuditWriter {
  return {
    async write(event) {
      const client = await pool.connect();
      try {
        await insertAudit(client, {
          // A change with no session behind it (nothing today) is the system's.
          actorId: event.actorUserId ?? "system",
          actorKind: event.actorUserId ? "user" : "system",
          orgId: event.organizationId,
          action: event.action,
          targetType: "member",
          targetId: event.targetUserId,
          meta: { role: event.role, ...(event.previousRole ? { previousRole: event.previousRole } : {}) },
        });
      } finally {
        client.release();
      }
    },
  };
}

/** Whether any design-system library (live or archived) still belongs to the organization. */
export function orgHasLibraries(pool: AuditPool): (organizationId: string) => Promise<boolean> {
  return async (organizationId) => {
    const client = await pool.connect();
    try {
      return (await client.query("SELECT 1 FROM ds_libraries WHERE org_id = $1 LIMIT 1", [organizationId])).rows.length > 0;
    } finally {
      client.release();
    }
  };
}
