import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
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
  /** True when design-system libraries still belong to the organization (deleting it is then refused). */
  hasLibraries?: (organizationId: string) => Promise<boolean>;
}

export function createOrganizationPlugin({ sendEmail, appOrigin, audit = noopOrgAuditWriter, hasLibraries }: OrganizationOptions) {
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
  // Role of a member before an update-member-role call, by member id.
  const previousRoles = new Map<string, string>();

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
    // actorUserId: filled where the hook data names the actor. remove-member
    // and update-member-role only hand their hooks the AFFECTED account, so
    // those two are audited from the after-route hooks below, where the
    // actor's session is at hand.
    organizationHooks: {
      beforeCreateInvitation: async ({ invitation }) => assertAllowedRole(invitation.role),
      beforeAddMember: async ({ member }) => assertAllowedRole(member.role),
      beforeUpdateMemberRole: async ({ member, newRole }) => {
        assertAllowedRole(newRole);
        previousRoles.set(member.id, member.role);
      },
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
      beforeDeleteOrganization: async ({ organization: org }, ctx) => {
        // 019 makes ds_libraries.org_id RESTRICT: say why instead of a 500.
        if (hasLibraries && (await hasLibraries(org.id))) {
          doomed.delete(org.id);
          throw new APIError("CONFLICT", { message: "Purge or move the organization's design-system libraries first" });
        }
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

  // Hooks that run after the route. /organization/leave has no organization
  // hook of its own; remove-member and update-member-role get theirs here for
  // the actor (organizationHooks only name the affected account). An error
  // response is an APIError, which carries no member and is skipped. A call
  // with no session behind it (server-side, never from HTTP today) records
  // actor_kind "system" by design: the writer maps actorUserId null to it.
  // remove-member returns {member}; update-member-role returns the member itself.
  const returnedMember = (ctx: { context: { returned?: unknown } }) => {
    const returned = ctx.context.returned as Record<string, unknown> | undefined;
    if (!returned || returned instanceof Error) return null;
    const m = (returned.member ?? returned) as { id?: unknown; userId?: unknown; organizationId?: unknown; role?: unknown };
    return typeof m.userId === "string" && typeof m.organizationId === "string" && typeof m.role === "string"
      ? { id: String(m.id), userId: m.userId, organizationId: m.organizationId, role: m.role }
      : null;
  };
  const sessionUserId = async (ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<string | null> =>
    (await getSessionFromCtx(ctx).catch(() => null))?.user.id ?? null;

  return {
    ...plugin,
    hooks: {
      after: [
        {
          matcher: (context: { path?: string }) => context.path === "/organization/remove-member",
          handler: createAuthMiddleware(async (ctx) => {
            const member = returnedMember(ctx);
            if (!member) return;
            await safeWrite({
              action: "member.remove",
              organizationId: member.organizationId,
              targetUserId: member.userId,
              actorUserId: await sessionUserId(ctx),
              role: member.role,
            });
          }),
        },
        {
          matcher: (context: { path?: string }) => context.path === "/organization/update-member-role",
          handler: createAuthMiddleware(async (ctx) => {
            const member = returnedMember(ctx);
            if (!member) return;
            const previousRole = previousRoles.get(member.id);
            previousRoles.delete(member.id);
            await safeWrite({
              action: "member.role_change",
              organizationId: member.organizationId,
              targetUserId: member.userId,
              actorUserId: await sessionUserId(ctx),
              role: member.role,
              ...(previousRole ? { previousRole } : {}),
            });
          }),
        },
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
