import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { noopOrgAuditWriter, type OrgAuditWriter } from "./orgAudit.js";
import { invitationMessage, type EmailSender } from "./email.js";

// Actions on a design-system library (Phase 8). `admin` = manage members and
// archive. The plugin's own statements (organization / member / invitation)
// stay, so the owner can still manage the org itself.
export const statements = {
  ...defaultStatements,
  library: ["read", "comment", "write", "publish", "approve", "admin"],
} as const;

export const ac = createAccessControl(statements);

export const ORG_ROLES = {
  owner: ac.newRole({
    ...ownerAc.statements,
    library: ["read", "comment", "write", "publish", "approve", "admin"],
  }),
  editor: ac.newRole({
    ...memberAc.statements,
    library: ["read", "comment", "write", "publish", "approve"],
  }),
  viewer: ac.newRole({
    library: ["read", "comment"],
  }),
};

export interface OrganizationOptions {
  sendEmail: EmailSender;
  /** Origin the invitation link points at (the frontend). */
  appOrigin: string;
  audit?: OrgAuditWriter;
}

export function createOrganizationPlugin({ sendEmail, appOrigin, audit = noopOrgAuditWriter }: OrganizationOptions) {
  // The hooks' `user` is the AFFECTED account, not the actor, so actorUserId is
  // null here; 8.3 resolves the actor from the request when it writes the row.
  return organization({
    ac,
    roles: ORG_ROLES,
    creatorRole: "owner",
    sendInvitationEmail: async ({ id, email, role, organization: org, inviter }) => {
      const url = `${appOrigin}/accept-invitation?id=${encodeURIComponent(id)}`;
      await sendEmail(invitationMessage(email, url, org.name, inviter.user.name || inviter.user.email, role));
    },
    organizationHooks: {
      afterAddMember: async ({ member, organization: org }) => {
        await audit.write({
          action: "member.add",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
        });
      },
      // Accepting an invitation is the normal way to join; it does not fire
      // afterAddMember (that is the direct add-member API), so audit both.
      afterAcceptInvitation: async ({ member, organization: org }) => {
        await audit.write({
          action: "member.add",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
        });
      },
      afterRemoveMember: async ({ member, organization: org }) => {
        await audit.write({
          action: "member.remove",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
        });
      },
      afterUpdateMemberRole: async ({ member, previousRole, organization: org }) => {
        await audit.write({
          action: "member.role_change",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
          previousRole,
        });
      },
    },
  });
}
