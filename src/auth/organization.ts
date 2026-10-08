import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { noopOrgAuditWriter, type OrgAuditEvent, type OrgAuditWriter } from "./orgAudit.js";
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
    ...memberAc.statements,
    library: ["read", "comment"],
  }),
};

export const ORGANIZATION_LIMIT = 5;
export const INVITATION_LIMIT = 50;
export const MEMBERSHIP_LIMIT = 100;

const ALLOWED_ROLES = Object.keys(ORG_ROLES);

// The plugin also accepts its built-in `admin` / `member` roles and
// comma-joined multi-roles; this product has exactly the three above.
function assertAllowedRole(role: unknown): void {
  if (typeof role !== "string" || !ALLOWED_ROLES.includes(role)) {
    throw new APIError("BAD_REQUEST", { message: `Role must be one of: ${ALLOWED_ROLES.join(", ")}` });
  }
}

export interface OrganizationOptions {
  sendEmail: EmailSender;
  /** Origin the invitation link points at (the frontend). */
  appOrigin: string;
  audit?: OrgAuditWriter;
}

export function createOrganizationPlugin({ sendEmail, appOrigin, audit = noopOrgAuditWriter }: OrganizationOptions) {
  // The change has already committed when an after* hook runs, so an audit
  // failure must not turn a successful API call into an error. Logged without
  // PII (no emails or names): action and ids only.
  const safeWrite = async (event: OrgAuditEvent): Promise<void> => {
    try {
      await audit.write(event);
    } catch (err) {
      console.error(
        `[auth] org audit write failed action=${event.action} org=${event.organizationId} target=${event.targetUserId}: ${err instanceof Error ? err.name : "error"}`,
      );
    }
  };
  // Members of an organization being deleted, captured before the cascade.
  const doomed = new Map<string, { userId: string; role: string }[]>();

  const plugin = organization({
    ac,
    roles: ORG_ROLES,
    creatorRole: "owner",
    organizationLimit: ORGANIZATION_LIMIT,
    invitationLimit: INVITATION_LIMIT,
    membershipLimit: MEMBERSHIP_LIMIT,
    // A failed send leaves the invitation row behind; without this a retry
    // would answer "already invited" and the invitee could never be reached.
    cancelPendingInvitationsOnReInvite: true,
    sendInvitationEmail: async ({ id, email, organization: org, inviter, role }) => {
      const url = `${appOrigin}/app/accept-invitation?id=${encodeURIComponent(id)}`;
      await sendEmail(invitationMessage(email, url, org.name, inviter.user.name || inviter.user.email, role));
    },
    // actorUserId: filled where the hook data names the actor. Hooks whose
    // `user` is only the AFFECTED account (remove-member, update-member-role)
    // leave it null; 8.3 reads the actor from the request session there.
    organizationHooks: {
      beforeCreateInvitation: async ({ invitation }) => assertAllowedRole(invitation.role),
      beforeAddMember: async ({ member }) => assertAllowedRole(member.role),
      beforeUpdateMemberRole: async ({ newRole }) => assertAllowedRole(newRole),
      afterCreateOrganization: async ({ organization: org, member, user }) => {
        await safeWrite({
          action: "member.add",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: user.id,
          role: member.role,
        });
      },
      // No afterAddMember: it also fires for the creator of a new
      // organization (already audited above, with its actor) and otherwise
      // only for the server-only addMember API, which nothing here calls.
      // Accepting an invitation is the normal way to join. The session user is the invitee and joined by their own action.
      afterAcceptInvitation: async ({ member, organization: org, user }) => {
        await safeWrite({
          action: "member.add",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: user.id,
          role: member.role,
        });
      },
      afterRemoveMember: async ({ member, organization: org }) => {
        await safeWrite({
          action: "member.remove",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
        });
      },
      afterUpdateMemberRole: async ({ member, previousRole, organization: org }) => {
        await safeWrite({
          action: "member.role_change",
          organizationId: org.id,
          targetUserId: member.userId,
          actorUserId: null,
          role: member.role,
          previousRole,
        });
      },
      beforeDeleteOrganization: async ({ organization: org }, ctx) => {
        const rows = (await ctx?.context.adapter.findMany({
          model: "member",
          where: [{ field: "organizationId", value: org.id }],
        })) as { userId: string; role: string }[] | undefined;
        doomed.set(org.id, rows ?? []);
      },
      afterDeleteOrganization: async ({ organization: org, user }) => {
        const members = doomed.get(org.id) ?? [];
        doomed.delete(org.id);
        for (const m of members) {
          await safeWrite({
            action: "member.remove",
            organizationId: org.id,
            targetUserId: m.userId,
            actorUserId: user.id,
            role: m.role,
          });
        }
      },
    },
  });

  // /organization/leave has no hook of its own: audit it from an after-route
  // hook. The endpoint returns the removed member; an error response is an
  // APIError, which carries no userId and is skipped.
  return {
    ...plugin,
    hooks: {
      after: [
        {
          matcher: (context: { path?: string }) => context.path === "/organization/leave",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as { userId?: unknown; organizationId?: unknown; role?: unknown } | undefined;
            if (
              !returned ||
              returned instanceof Error ||
              typeof returned.userId !== "string" ||
              typeof returned.organizationId !== "string"
            ) {
              return;
            }
            await safeWrite({
              action: "member.remove",
              organizationId: returned.organizationId,
              targetUserId: returned.userId,
              actorUserId: returned.userId,
              role: typeof returned.role === "string" ? returned.role : "",
            });
          }),
        },
      ],
    },
  };
}
