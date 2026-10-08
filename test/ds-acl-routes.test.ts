// /api/ds role matrix over real HTTP: real Better Auth organizations, the real
// ds SQL and the real audit writer on PGlite.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Snapshot } from "../src/ds/snapshotSchema.js";
import { APP_ORIGIN, mintMcpToken, useAuthApp, useLocalAuthIssuer } from "./authHarness.js";
import { assert } from "./helpers.js";

const app = useAuthApp({}, { withDsStore: true });
const BASE = (JSON.parse(readFileSync(new URL("./fixtures/ds-diff/none-identical.json", import.meta.url), "utf8")) as { before: Snapshot }).before;

interface Account {
  cookie: string;
  userId: string;
  apiKey: string;
}
let hop = 0;
let seq = 0;

function call(credential: { cookie?: string; bearer?: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${app().url}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      "X-Forwarded-For": `203.0.113.${(++hop % 250) + 1}`,
      ...(credential.cookie ? { Cookie: credential.cookie } : {}),
      ...(credential.bearer ? { Authorization: `Bearer ${credential.bearer}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const as = (a: Account) => ({ cookie: a.cookie });
const json = async <T>(res: Response) => (await res.json()) as T;
const status = async (p: Promise<Response>) => (await p).status;

async function account(tag: string): Promise<Account> {
  const email = `${tag}${++seq}@example.test`;
  const cookie = await app().signUp(email);
  const session = await json<{ user: { id: string } }>(await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } }));
  const key = await json<{ key: string }>(
    await app().fetchAuth("/api/auth/api-key/create", { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ name: "ci" }) }),
  );
  return { cookie, userId: session.user.id, apiKey: key.key };
}

const orgPost = (cookie: string, path: string, body: unknown) =>
  app().fetchAuth(`/api/auth/organization/${path}`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify(body) });

let owner: Account, editor: Account, viewer: Account, stranger: Account;
let orgId = "";
const memberRowOf: Record<string, string> = {};

async function join(email: string, role: "editor" | "viewer", who: Account): Promise<void> {
  await orgPost(owner.cookie, "invite-member", { email, role, organizationId: orgId });
  const invitation = (await app().pglite.query<{ id: string }>(`SELECT id FROM invitation WHERE email = $1`, [email])).rows[0];
  expect((await orgPost(who.cookie, "accept-invitation", { invitationId: invitation.id })).status).toBe(200);
  const row = (await app().pglite.query<{ id: string }>(`SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [orgId, who.userId])).rows[0];
  memberRowOf[who.userId] = row.id;
}

beforeAll(async () => {
  [owner, editor, viewer, stranger] = [await account("own"), await account("edt"), await account("vwr"), await account("str")];
  const org = await json<{ id: string }>(await orgPost(owner.cookie, "create", { name: "Acme", slug: "acme-acl" }));
  orgId = org.id;
  const email = async (a: Account) => (await app().pglite.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [a.userId])).rows[0].email;
  await join(await email(editor), "editor", editor);
  await join(await email(viewer), "viewer", viewer);
});

async function orgLibrary(name = `Kit ${randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await call(as(owner), "POST", "/api/ds/libraries", { name, orgId });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}
const WITH_VAR: Snapshot = {
  ...BASE,
  variables: [...BASE.variables, { id: "var_extra", name: "Extra", type: "color", collectionId: "theme", valuesByMode: { light: "#0050ff", dark: "#4080ff" } }],
};
const publish = (c: { cookie?: string; bearer?: string }, id: string, baseVersion: string | null = null, snapshot: Snapshot = BASE) =>
  call(c, "POST", `/api/ds/libraries/${id}/versions`, { baseVersion, bump: "minor", snapshot }, { "Idempotency-Key": randomUUID() });
// A library's own history, without the organization's membership events.
const ownEvents = (items: Array<{ targetType: string }>) => items.filter((i) => i.targetType !== "member");

describe("organization libraries: role x route matrix", () => {
  it("answers each role per action: viewer reads, editor writes and publishes, owner administers, strangers see nothing", async () => {
    const id = await orgLibrary();
    const base = `/api/ds/libraries/${id}`;
    const rows: Array<[string, Account, number[]]> = [
      // [who, account, [GET, PATCH, preview, publish, audit, archive]]
      ["viewer", viewer, [200, 403, 200, 403, 403, 403]],
      ["stranger", stranger, [404, 404, 404, 404, 404, 404]],
    ];
    for (const [who, acct, expected] of rows) {
      const got = [
        await status(call(as(acct), "GET", base)),
        await status(call(as(acct), "PATCH", base, { description: "x" })),
        await status(call(as(acct), "POST", `${base}/preview`, { baseVersion: null, snapshot: BASE })),
        await status(publish(as(acct), id)),
        await status(call(as(acct), "GET", `${base}/audit`)),
        await status(call(as(acct), "DELETE", base)),
      ];
      expect(got, who).toEqual(expected);
    }
    // editor: everything but admin.
    expect(await status(call(as(editor), "GET", base))).toBe(200);
    expect(await status(call(as(editor), "PATCH", base, { description: "by editor" }))).toBe(200);
    expect(await status(publish(as(editor), id))).toBe(201);
    expect(await status(call(as(editor), "GET", `${base}/audit`))).toBe(403);
    expect(await status(call(as(editor), "DELETE", base))).toBe(403);
    expect(await status(call(as(editor), "DELETE", `${base}?purge=true`))).toBe(403);
    // owner: admin as well.
    expect(await status(call(as(owner), "GET", `${base}/audit`))).toBe(200);
    expect(await status(call(as(owner), "DELETE", base))).toBe(204);
    expect(await status(call(as(owner), "DELETE", `${base}?purge=true`))).toBe(204);
  });

  it("lists the libraries a principal can read, with the role per item", async () => {
    const id = await orgLibrary();
    const personal = (await json<{ id: string }>(await call(as(editor), "POST", "/api/ds/libraries", { name: `Mine ${randomUUID().slice(0, 6)}` }))).id;
    const list = async (a: Account) =>
      Object.fromEntries((await json<{ items: Array<{ id: string; role: string; orgId: string | null }> }>(await call(as(a), "GET", "/api/ds/libraries?limit=100"))).items.map((i) => [i.id, i]));
    expect((await list(viewer))[id]).toMatchObject({ role: "viewer", orgId });
    expect((await list(editor))[id]).toMatchObject({ role: "editor", orgId });
    expect((await list(owner))[id]).toMatchObject({ role: "owner", orgId });
    expect((await list(editor))[personal]).toMatchObject({ role: "owner", orgId: null });
    expect((await list(stranger))[id]).toBeUndefined();
    expect((await list(owner))[personal]).toBeUndefined();
  });

  it("creating inside an organization needs a write role there; a stranger gets 404", async () => {
    expect(await status(call(as(viewer), "POST", "/api/ds/libraries", { name: "Nope", orgId }))).toBe(403);
    expect(await status(call(as(stranger), "POST", "/api/ds/libraries", { name: "Nope", orgId }))).toBe(404);
    expect(await status(call(as(editor), "POST", "/api/ds/libraries", { name: `Ed ${randomUUID().slice(0, 6)}`, orgId }))).toBe(201);
  });

  it("keeps names unique per organization, not across them", async () => {
    const name = `Same ${randomUUID().slice(0, 6)}`;
    expect(await status(call(as(owner), "POST", "/api/ds/libraries", { name, orgId }))).toBe(201);
    expect(await status(call(as(editor), "POST", "/api/ds/libraries", { name, orgId }))).toBe(409);
    expect(await status(call(as(owner), "POST", "/api/ds/libraries", { name }))).toBe(201);
  });

  it("applies a demotion on the very next request", async () => {
    const id = await orgLibrary();
    const promoted = await account("flip");
    const email = (await app().pglite.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [promoted.userId])).rows[0].email;
    await join(email, "editor", promoted);
    expect(await status(call(as(promoted), "PATCH", `/api/ds/libraries/${id}`, { description: "ok" }))).toBe(200);
    const res = await orgPost(owner.cookie, "update-member-role", { memberId: memberRowOf[promoted.userId], role: "viewer", organizationId: orgId });
    expect(res.status).toBe(200);
    expect(await status(call(as(promoted), "PATCH", `/api/ds/libraries/${id}`, { description: "again" }))).toBe(403);
    expect(await status(call(as(promoted), "GET", `/api/ds/libraries/${id}`))).toBe(200);
    // Removal: the library disappears.
    await orgPost(owner.cookie, "remove-member", { memberIdOrEmail: memberRowOf[promoted.userId], organizationId: orgId });
    expect(await status(call(as(promoted), "GET", `/api/ds/libraries/${id}`))).toBe(404);
  });
});

describe("personal libraries stay owner-only", () => {
  it("hides a personal library from an organization's other members", async () => {
    const id = (await json<{ id: string }>(await call(as(owner), "POST", "/api/ds/libraries", { name: `Solo ${randomUUID().slice(0, 6)}` }))).id;
    expect(await status(call(as(editor), "GET", `/api/ds/libraries/${id}`))).toBe(404);
    expect(await status(call(as(owner), "GET", `/api/ds/libraries/${id}`))).toBe(200);
    expect(await status(publish(as(owner), id))).toBe(201);
    expect(await status(call(as(owner), "GET", `/api/ds/libraries/${id}/audit`))).toBe(200);
  });
});

describe("machine principals", () => {
  useLocalAuthIssuer(app);

  it("an agent token reads, and can never publish, write, administer or create", async () => {
    const id = await orgLibrary();
    const bearer = await mintMcpToken(app(), editor.userId);
    const c = { bearer };
    expect(await status(call(c, "GET", `/api/ds/libraries/${id}`))).toBe(200);
    expect(await status(call(c, "GET", "/api/ds/libraries"))).toBe(200);
    const denied = await publish(c, id);
    expect(denied.status).toBe(403);
    expect(await json<{ error: string }>(denied)).toMatchObject({ error: "agent_cannot_approve" });
    expect(await status(call(c, "PATCH", `/api/ds/libraries/${id}`, { description: "x" }))).toBe(403);
    expect(await status(call(c, "DELETE", `/api/ds/libraries/${id}`))).toBe(403);
    expect(await status(call(c, "GET", `/api/ds/libraries/${id}/audit`))).toBe(403);
    expect(await status(call(c, "POST", "/api/ds/libraries", { name: "Agent kit" }))).toBe(403);
  });

  it("an sf_ key reads the owner's libraries and cannot publish or write", async () => {
    const id = await orgLibrary();
    const c = { bearer: editor.apiKey };
    expect(await status(call(c, "GET", `/api/ds/libraries/${id}`))).toBe(200);
    expect(await status(publish(c, id))).toBe(403);
    expect(await status(call(c, "PATCH", `/api/ds/libraries/${id}`, { description: "x" }))).toBe(403);
  });

  it("a stranger's token gets 404, a bad credential 401, and the bearer wins over a cookie", async () => {
    const id = await orgLibrary();
    expect(await status(call({ bearer: stranger.apiKey }, "GET", `/api/ds/libraries/${id}`))).toBe(404);
    const bad = await call({ bearer: "garbage" }, "GET", "/api/ds/libraries");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(await status(call({ bearer: "sf_not-a-real-key", cookie: owner.cookie }, "GET", `/api/ds/libraries/${id}`))).toBe(401);
  });
});

interface AuditItem {
  id: string;
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
const auditPage = async (c: Account, id: string, qs = "") =>
  json<{ items: AuditItem[]; nextCursor: string | null }>(await call(as(c), "GET", `/api/ds/libraries/${id}/audit${qs}`));

describe("audit log", () => {
  it("records create, update, publish, archive and purge with the acting account", async () => {
    const id = await orgLibrary();
    await call(as(editor), "PATCH", `/api/ds/libraries/${id}`, { description: "d" });
    const first = await json<{ snapshotHash: string }>(await publish(as(editor), id));
    const second = await json<{ version: string; snapshotHash: string }>(await publish(as(owner), id, "1.0.0", WITH_VAR));
    await call(as(owner), "DELETE", `/api/ds/libraries/${id}`);
    await call(as(owner), "DELETE", `/api/ds/libraries/${id}`); // idempotent: no second row
    const page = await auditPage(owner, id);
    const own = ownEvents(page.items);
    expect(own.map((i) => i.action)).toEqual(["library.archive", "version.publish", "version.publish", "library.update", "library.create"]);
    const [archive, pub2, pub1, update, create] = own;
    expect([create.actorId, update.actorId, pub1.actorId, pub2.actorId, archive.actorId]).toEqual([
      owner.userId, editor.userId, editor.userId, owner.userId, owner.userId,
    ]);
    expect(own.every((i) => i.actorKind === "user" && i.orgId === orgId && i.clientId === null)).toBe(true);
    expect(pub1).toMatchObject({ targetType: "version", beforeHash: null, afterHash: first.snapshotHash, meta: { bump: "initial" } });
    expect(pub2).toMatchObject({ beforeHash: first.snapshotHash, afterHash: second.snapshotHash });
    expect(update.meta).toEqual({ fields: ["description"] });
    // Counts and enums only: nothing but ids, hashes and small enums in a row.
    expect(JSON.stringify(page.items)).not.toMatch(/@example\.test/);
    // Purge keeps the history in the table even though the route can no longer read it.
    await call(as(owner), "DELETE", `/api/ds/libraries/${id}?purge=true`);
    const rows = (await app().pglite.query<{ action: string }>(`SELECT action FROM audit_log WHERE library_id = $1 ORDER BY id`, [id])).rows;
    expect(rows.map((r) => r.action)).toEqual(["library.create", "library.update", "version.publish", "version.publish", "library.archive", "library.purge"]);
    expect(await status(call(as(owner), "GET", `/api/ds/libraries/${id}/audit`))).toBe(404);
  });

  it("writes nothing for a refused or failed request", async () => {
    const id = await orgLibrary();
    await call(as(viewer), "PATCH", `/api/ds/libraries/${id}`, { description: "x" });
    await publish(as(viewer), id);
    await call(as(owner), "POST", `/api/ds/libraries/${id}/versions`, { baseVersion: null, bump: "minor", snapshot: { nope: true } }, { "Idempotency-Key": randomUUID() });
    expect(ownEvents((await auditPage(owner, id)).items).map((i) => i.action)).toEqual(["library.create"]);
  });

  it("pages newest first with a cursor, filters by action and rejects a foreign cursor", async () => {
    const id = await orgLibrary();
    for (let i = 0; i < 3; i++) await call(as(owner), "PATCH", `/api/ds/libraries/${id}`, { description: `d${i}` });
    const first = await auditPage(owner, id, "?limit=2&action=library.update");
    expect(first.items).toHaveLength(2);
    assert(first.nextCursor !== null);
    const second = await auditPage(owner, id, `?limit=2&action=library.update&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.action)).toEqual(["library.update"]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(3);
    const everything = await auditPage(owner, id, "?limit=100");
    expect(everything.items.map((i) => BigInt(i.id))).toEqual([...everything.items.map((i) => BigInt(i.id))].sort((a, b) => (a > b ? -1 : 1)));
    expect(await status(call(as(owner), "GET", `/api/ds/libraries/${id}/audit?cursor=nope`))).toBe(400);
    expect(await status(call(as(owner), "GET", `/api/ds/libraries/${id}/audit?action=DROP%20TABLE`))).toBe(400);
  });

  it("records membership changes with the acting account, and shows them on the organization's libraries", async () => {
    const id = await orgLibrary();
    const joiner = await account("join");
    const email = (await app().pglite.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [joiner.userId])).rows[0].email;
    await join(email, "viewer", joiner);
    await orgPost(owner.cookie, "update-member-role", { memberId: memberRowOf[joiner.userId], role: "editor", organizationId: orgId });
    await orgPost(owner.cookie, "remove-member", { memberIdOrEmail: memberRowOf[joiner.userId], organizationId: orgId });
    const rows = (
      await app().pglite.query<{ action: string; actor_id: string; actor_kind: string; target_id: string; meta: Record<string, string> }>(
        `SELECT action, actor_id, actor_kind, target_id, meta FROM audit_log WHERE org_id = $1 AND library_id IS NULL AND target_id = $2 ORDER BY id`,
        [orgId, joiner.userId],
      )
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(["member.add", "member.role_change", "member.remove"]);
    expect(rows[0]).toMatchObject({ actor_id: joiner.userId, actor_kind: "user", meta: { role: "viewer" } });
    // The two hooks that only know the affected account read the actor from the session.
    expect(rows[1]).toMatchObject({ actor_id: owner.userId, actor_kind: "user", meta: { role: "editor", previousRole: "viewer" } });
    expect(rows[2]).toMatchObject({ actor_id: owner.userId, actor_kind: "user", meta: { role: "editor" } });
    const seen = (await auditPage(owner, id, "?action=member.role_change")).items;
    expect(seen.some((i) => i.targetId === joiner.userId && i.actorId === owner.userId)).toBe(true);
  });

  it("is append-only", async () => {
    const id = await orgLibrary();
    await expect(app().pglite.query(`UPDATE audit_log SET action = 'x' WHERE library_id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(app().pglite.query(`DELETE FROM audit_log WHERE library_id = $1`, [id])).rejects.toThrow(/append-only/);
  });
});
