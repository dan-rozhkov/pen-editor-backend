import { describe, expect, it, vi } from "vitest";
import { useAuthApp } from "./authHarness.js";
import { ORG_ROLES } from "../src/auth/organization.js";
import { invitationMessage } from "../src/auth/email.js";
import type { OrgAuditEvent } from "../src/auth/orgAudit.js";

const events: OrgAuditEvent[] = [];
let auditFails = false;
let failSendTo: string | null = null;
const app = useAuthApp(
  {},
  {
    orgAudit: {
      write: async (e) => {
        if (auditFails) throw new Error("audit down");
        events.push(e);
      },
    },
    beforeSend: (m) => {
      if (m.to === failSendTo) throw new Error("send failed");
    },
  },
);

const post = (path: string, cookie: string, body: unknown) =>
  app().fetchAuth(`/api/auth/organization/${path}`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(body) });

async function orgWithMember(tag: string, role: string) {
  const owner = await app().signUp(`${tag}-o@example.test`);
  const org = (await (await post("create", owner, { name: tag, slug: tag })).json()) as { id: string };
  const email = `${tag}-m@example.test`;
  await post("invite-member", owner, { email, role, organizationId: org.id });
  const invitationId = (await app().pglite.query<{ id: string }>(`SELECT id FROM invitation WHERE email = $1`, [email])).rows[0].id;
  const member = await app().signUp(email);
  await post("accept-invitation", member, { invitationId });
  const row = (await app().pglite.query<{ id: string; userId: string }>(`SELECT id, "userId" FROM member WHERE "organizationId" = $1 AND role = $2`, [org.id, role])).rows[0];
  return { owner, member, org, row };
}

describe("invitation link", () => {
  it("points at the editor under /app", async () => {
    const owner = await app().signUp("link-o@example.test");
    const org = (await (await post("create", owner, { name: "Link", slug: "link" })).json()) as { id: string };
    const r = await post("invite-member", owner, { email: "link-m@example.test", role: "viewer", organizationId: org.id });
    const { id } = (await r.json()) as { id: string };
    expect(app().emails.findLast((m) => m.to === "link-m@example.test")!.text).toContain(`https://app.example.test/app/accept-invitation?id=${id}`);
  });
});

describe("role allowlist", () => {
  it.each(["admin", "member", "owner,editor", "nonsense"])("invite with %s is a 400 (or forbidden for owner)", async (role) => {
    const owner = await app().signUp(`r-${role.replace(/\W/g, "")}@example.test`);
    const org = (await (await post("create", owner, { name: "R", slug: `r-${role.replace(/\W/g, "")}` })).json()) as { id: string };
    const res = await post("invite-member", owner, { email: "x@example.test", role, organizationId: org.id });
    expect(res.status).toBe(400);
  });

  it("update-member-role rejects a role outside owner/editor/viewer", async () => {
    const { owner, org, row } = await orgWithMember("upd", "viewer");
    const res = await post("update-member-role", owner, { memberId: row.id, role: "admin", organizationId: org.id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/owner, editor, viewer/);
  });
});

describe("audit coverage", () => {
  it("records leaving and organization deletion", async () => {
    const { owner, member, org, row } = await orgWithMember("leave", "editor");
    await post("leave", member, { organizationId: org.id });
    expect(events.some((e) => e.action === "member.remove" && e.organizationId === org.id && e.targetUserId === row.userId && e.actorUserId === row.userId)).toBe(true);

    const second = await orgWithMember("del", "viewer");
    const del = await post("delete", second.owner, { organizationId: second.org.id });
    expect(del.status).toBe(200);
    const removed = events.filter((e) => e.action === "member.remove" && e.organizationId === second.org.id);
    expect(removed.map((e) => e.role).sort()).toEqual(["owner", "viewer"]);
    expect(owner).toBeTruthy();
  });

  it("fills actorUserId where the hook knows the actor", async () => {
    const { org, row } = await orgWithMember("actor", "viewer");
    const adds = events.filter((e) => e.action === "member.add" && e.organizationId === org.id);
    expect(adds).toHaveLength(2); // creator + accepted invitee
    expect(adds.every((e) => e.actorUserId !== null)).toBe(true);
    expect(adds.find((e) => e.targetUserId === row.userId)!.actorUserId).toBe(row.userId);
  });

  it("an audit failure never fails the API", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    auditFails = true;
    try {
      const owner = await app().signUp("fail-o@example.test");
      const res = await post("create", owner, { name: "Fail", slug: "fail-audit" });
      expect(res.status).toBe(200);
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain("fail-o@example.test");
    } finally {
      auditFails = false;
      log.mockRestore();
    }
  });
});

describe("limits and email hygiene", () => {
  it("caps organizations per user at 5", async () => {
    const owner = await app().signUp("lim-o@example.test");
    for (let i = 0; i < 5; i++) expect((await post("create", owner, { name: `L${i}`, slug: `lim-${i}` })).status).toBe(200);
    expect((await post("create", owner, { name: "L6", slug: "lim-6" })).status).toBe(403);
  });

  it("keeps user text out of the subject and strips control characters from the body", () => {
    const m = invitationMessage("a@b.test", "https://x.test/u", "Evil\r\nBcc: x\u0007<b>" + "n".repeat(200), "Mallory\nInjected", "viewer");
    expect(m.subject).toBe("You are invited to a Sideform organization");
    expect([...m.text].some((c) => c.charCodeAt(0) < 32 && c !== "\n")).toBe(false);
    expect(m.text.split("\n")[0]).not.toContain("\n");
    expect(m.text).not.toContain("n".repeat(81));
    expect(m.html).not.toContain("<b>");
  });
});

describe("failed invitation send", () => {
  it("can be retried", async () => {
    const owner = await app().signUp("retry-o@example.test");
    const org = (await (await post("create", owner, { name: "Retry", slug: "retry" })).json()) as { id: string };
    failSendTo = "retry-m@example.test";
    const first = await post("invite-member", owner, { email: "retry-m@example.test", role: "viewer", organizationId: org.id });
    // Better Auth sends in the background, so the API call itself may succeed
    // while the email is lost; either way the retry below must work.
    expect(app().emails.some((m) => m.to === "retry-m@example.test")).toBe(false);
    void first;
    failSendTo = null;
    const second = await post("invite-member", owner, { email: "retry-m@example.test", role: "viewer", organizationId: org.id });
    expect(second.status).toBe(200);
    expect(app().emails.some((m) => m.to === "retry-m@example.test")).toBe(true);
  });
});

describe("viewer base statements", () => {
  it("includes the member base statement", () => {
    expect(ORG_ROLES.viewer.authorize({ ac: ["read"] }).success).toBe(true);
    expect(ORG_ROLES.viewer.authorize({ member: ["create"] }).success).toBe(false);
  });
});
