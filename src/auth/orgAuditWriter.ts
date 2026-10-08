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
