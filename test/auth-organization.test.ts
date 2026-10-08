import { describe, expect, it } from "vitest";
import { useAuthApp } from "./authHarness.js";
import { ORG_ROLES } from "../src/auth/organization.js";
import type { OrgAuditEvent } from "../src/auth/orgAudit.js";

const events: OrgAuditEvent[] = [];
const app = useAuthApp({}, { orgAudit: { write: async (e) => void events.push(e) } });

const post = (path: string, cookie: string, body: unknown) =>
  app().fetchAuth(`/api/auth/organization/${path}`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(body) });

describe("organization plugin", () => {
  it("runs sign up, create org, invite, accept", async () => {
    const owner = await app().signUp("owner@example.test");
    const created = await post("create", owner, { name: "Acme", slug: "acme" });
    expect(created.status).toBe(200);
    const org = (await created.json()) as { id: string; members: { role: string }[] };
    expect(org.members[0].role).toBe("owner");

    const invited = await post("invite-member", owner, { email: "ed@example.test", role: "editor", organizationId: org.id });
    expect(invited.status).toBe(200);
    const { id: invitationId } = (await invited.json()) as { id: string };
    const mail = app().emails.findLast((m) => m.to === "ed@example.test")!;
    expect(mail.subject).toContain("Acme");
    expect(mail.text).toContain(`/accept-invitation?id=${invitationId}`);

    const editor = await app().signUp("ed@example.test");
    const accepted = await post("accept-invitation", editor, { invitationId });
    expect(accepted.status).toBe(200);
    const members = await app().pglite.query<{ role: string }>(
      `SELECT m.role FROM member m JOIN "user" u ON u.id = m."userId" WHERE u.email = 'ed@example.test'`,
    );
    expect(members.rows).toEqual([{ role: "editor" }]);
  });

  it("a viewer cannot invite", async () => {
    const owner = await app().signUp("o2@example.test");
    const org = (await (await post("create", owner, { name: "Two", slug: "two" })).json()) as { id: string };
    await post("invite-member", owner, { email: "v@example.test", role: "viewer", organizationId: org.id });
    const invitationId = (
      await app().pglite.query<{ id: string }>(`SELECT id FROM invitation WHERE email = 'v@example.test'`)
    ).rows[0].id;
    const viewer = await app().signUp("v@example.test");
    await post("accept-invitation", viewer, { invitationId });
    const denied = await post("invite-member", viewer, { email: "x@example.test", role: "viewer", organizationId: org.id });
    expect(denied.status).toBe(403);
  });
});

describe("organization hooks", () => {
  it("report member add, role change and removal to the audit writer", async () => {
    const owner = await app().signUp("o3@example.test");
    const org = (await (await post("create", owner, { name: "Three", slug: "three" })).json()) as { id: string };
    await post("invite-member", owner, { email: "m3@example.test", role: "viewer", organizationId: org.id });
    const invitationId = (
      await app().pglite.query<{ id: string }>(`SELECT id FROM invitation WHERE email = 'm3@example.test'`)
    ).rows[0].id;
    const member = await app().signUp("m3@example.test");
    await post("accept-invitation", member, { invitationId });
    const row = (
      await app().pglite.query<{ id: string; userId: string }>(
        `SELECT m.id, m."userId" FROM member m JOIN "user" u ON u.id = m."userId" WHERE u.email = 'm3@example.test'`,
      )
    ).rows[0];
    await post("update-member-role", owner, { memberId: row.id, role: "editor", organizationId: org.id });
    await post("remove-member", owner, { memberIdOrEmail: row.id, organizationId: org.id });

    const mine = events.filter((e) => e.organizationId === org.id && e.targetUserId === row.userId);
    expect(mine.map((e) => e.action)).toEqual(["member.add", "member.role_change", "member.remove"]);
    expect(mine[1]).toMatchObject({ role: "editor", previousRole: "viewer" });
  });
});

describe("library role matrix", () => {
  const can = (role: keyof typeof ORG_ROLES, action: string) =>
    ORG_ROLES[role].authorize({ library: [action] as never }).success;

  it.each([
    ["owner", ["read", "comment", "write", "publish", "approve", "admin"]],
    ["editor", ["read", "comment", "write", "publish", "approve"]],
    ["viewer", ["read", "comment"]],
  ] as const)("%s", (role, allowed) => {
    for (const action of ["read", "comment", "write", "publish", "approve", "admin"]) {
      expect(can(role, action), `${role}:${action}`).toBe(allowed.includes(action as never));
    }
  });
});
