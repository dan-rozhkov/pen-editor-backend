// Seam between the Better Auth organization hooks (src/auth/organization.ts)
// and the audit log. 8.1 ships only the no-op writer; task 8.3 supplies the
// real one (INSERT into audit_log) and passes it to createAuth().

export type OrgAuditAction = "member.add" | "member.remove" | "member.role_change";

export interface OrgAuditEvent {
  action: OrgAuditAction;
  organizationId: string;
  /** The account the change is about. */
  targetUserId: string;
  /** The account that made the change, when the hook knows it. */
  actorUserId: string | null;
  /** Role after the change (`member.remove`: the role removed). */
  role: string;
  /** Role before a `member.role_change`. */
  previousRole?: string;
}

export interface OrgAuditWriter {
  write(event: OrgAuditEvent): Promise<void>;
}

export const noopOrgAuditWriter: OrgAuditWriter = { write: async () => {} };
