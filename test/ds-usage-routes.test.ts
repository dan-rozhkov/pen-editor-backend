// /api/ds usage routes over real HTTP: real Better Auth organizations and the
// real ds SQL on PGlite. Consumers (viewers) report; the owner administers.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LINT_RULE_IDS } from "../src/ai/tools.js";
import type { Snapshot } from "../src/ds/snapshotSchema.js";
import { APP_ORIGIN, mintMcpToken, useAuthApp, useLocalAuthIssuer } from "./authHarness.js";
import { recordingAnalyticsClient } from "./chatHarness.js";
import { as, createAccount, json, orgPostOn, type Account } from "./dsAccounts.js";

const analytics = recordingAnalyticsClient();
const app = useAuthApp({}, { withDsStore: true, analytics });
useLocalAuthIssuer(app);
const BASE = (JSON.parse(readFileSync(new URL("./fixtures/ds-diff/none-identical.json", import.meta.url), "utf8")) as { before: Snapshot }).before;

let hop = 0;
const call = (c: { cookie?: string; bearer?: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app().url}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      "X-Forwarded-For": `203.0.113.${(++hop % 250) + 1}`,
      ...(c.cookie ? { Cookie: c.cookie } : {}),
      ...(c.bearer ? { Authorization: `Bearer ${c.bearer}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const doc = () => randomUUID();

const orgPost = (cookie: string, path: string, body: unknown) => orgPostOn(app(), cookie, path, body);

let owner: Account;
let editor: Account;
let viewer: Account;
let stranger: Account;
let orgId = "";
let lib = "";

async function join(who: Account, role: "editor" | "viewer") {
  const email = (await app().pglite.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [who.userId])).rows[0].email;
  await orgPost(owner.cookie, "invite-member", { email, role, organizationId: orgId });
  const inv = (await app().pglite.query<{ id: string }>(`SELECT id FROM invitation WHERE email = $1`, [email])).rows[0];
  expect((await orgPost(who.cookie, "accept-invitation", { invitationId: inv.id })).status).toBe(200);
}

const METRICS = {
  schemaVersion: 1,
  nodes: 120,
  tokens: { bindable: 10, bound: 7, boundToLibrary: 5, literal: 3, use: { var_brand: 3 } },
  components: { instances: 5, detached: 1, use: { button: 4 }, detachedByKey: { button: 1 } },
  lint: { "hardcoded-value": 3 },
};
const put = (c: { cookie?: string; bearer?: string }, key: string, body: unknown = { version: "1.0.0", metrics: METRICS }, id = lib) =>
  call(c, "PUT", `/api/ds/libraries/${id}/usage/${key}`, body);

beforeAll(async () => {
  [owner, editor, viewer, stranger] = await Promise.all(["own", "edt", "vwr", "str"].map((t) => createAccount(app(), t)));
  orgId = (await json<{ id: string }>(await orgPost(owner.cookie, "create", { name: "Acme", slug: "acme-usage" }))).id;
  await join(editor, "editor");
  await join(viewer, "viewer");
  const created = await call(as(owner), "POST", "/api/ds/libraries", { name: "Kit", orgId });
  lib = (await json<{ id: string }>(created)).id;
  const pub = await call(as(owner), "POST", `/api/ds/libraries/${lib}/versions`, { baseVersion: null, bump: "minor", snapshot: BASE }, { "Idempotency-Key": randomUUID() });
  expect(pub.status).toBe(201);
});

describe("usage routes", () => {
  it("any reader reports (204), idempotently; a stranger gets 404; signed out gets 401", async () => {
    const key = doc();
    for (const who of [viewer, editor, owner]) expect((await put(as(who), key)).status).toBe(204);
    expect((await put(as(viewer), key)).status).toBe(204);
    expect((await app().pglite.query("SELECT 1 FROM ds_usage WHERE document_key = $1", [key])).rows).toHaveLength(1);
    expect((await put(as(stranger), doc())).status).toBe(404);
    expect((await put({}, doc())).status).toBe(401);
    expect((await put(as(owner), doc(), undefined, "lib_missing")).status).toBe(404);
  });

  it("an API key and an OAuth agent may report (read access); the report is stored under the account", async () => {
    const key = doc();
    expect((await put({ bearer: viewer.apiKey }, key)).status).toBe(204);
    expect((await app().pglite.query<{ reporter_id: string }>("SELECT reporter_id FROM ds_usage WHERE document_key = $1", [key])).rows[0].reporter_id).toBe(viewer.userId);
    const token = await mintMcpToken(app(), viewer.userId);
    expect((await put({ bearer: token }, doc())).status).toBe(204);
  });

  it("validates: uuid key, version, shape, unknown ids (counts only), size", async () => {
    expect((await put(as(owner), "not-a-uuid")).status).toBe(400);
    expect((await put(as(owner), doc(), { version: "x", metrics: METRICS })).status).toBe(400);
    expect((await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, nodes: -1 } })).status).toBe(400);
    expect((await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, title: "MARKER-title" } })).status).toBe(400);
    const unknownVersion = await put(as(owner), doc(), { version: "7.0.0", metrics: METRICS });
    expect([unknownVersion.status, (await json<{ error: string }>(unknownVersion)).error]).toEqual([422, "unknown_version"]);
    const ids = await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, tokens: { ...METRICS.tokens, use: { "MARKER-id": 1 } } } });
    const body = await json<{ error: string; details: { count: number } }>(ids);
    expect([ids.status, body.error, body.details]).toEqual([422, "unknown_ids", { count: 1 }]);
    expect(JSON.stringify(body)).not.toContain("MARKER");
    const many = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`var_${"x".repeat(30)}_${i}`, 1]));
    const big = await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, tokens: { ...METRICS.tokens, use: many } } });
    expect(big.status).toBe(413);
  });

  it("summary: readers see it, strangers do not; it carries counts, never a document title or a name of a person", async () => {
    const s = await call(as(viewer), "GET", `/api/ds/libraries/${lib}/usage/summary`);
    expect(s.status).toBe(200);
    const body = await json<{ documents: { total: number; behind: number }; coverage: { token: { avg: number } }; unusedTokens: unknown[] }>(s);
    expect(body.documents.total).toBeGreaterThan(0);
    expect(body.documents.behind).toBe(0);
    expect(body.coverage.token.avg).toBeCloseTo(0.7);
    expect(body.unusedTokens.length).toBe(3);
    expect((await call(as(stranger), "GET", `/api/ds/libraries/${lib}/usage/summary`)).status).toBe(404);
    expect((await call({}, "GET", `/api/ds/libraries/${lib}/usage/summary`)).status).toBe(401);
  });

  it("delete: the reporter or the owner; another reader gets 403; a stranger 404", async () => {
    const key = doc();
    await put(as(viewer), key);
    expect((await call(as(editor), "DELETE", `/api/ds/libraries/${lib}/usage/${key}`)).status).toBe(403);
    expect((await call(as(stranger), "DELETE", `/api/ds/libraries/${lib}/usage/${key}`)).status).toBe(404);
    expect((await call(as(viewer), "DELETE", `/api/ds/libraries/${lib}/usage/${key}`)).status).toBe(204);
    await put(as(viewer), key);
    expect((await call(as(owner), "DELETE", `/api/ds/libraries/${lib}/usage/${key}`)).status).toBe(204);
    expect((await app().pglite.query("SELECT 1 FROM ds_usage WHERE document_key = $1", [key])).rows).toHaveLength(0);
  });

  it("accepts every lint rule id of the lint tool and nothing else", async () => {
    const all = Object.fromEntries(LINT_RULE_IDS.map((r) => [r, 1]));
    expect((await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, lint: all } })).status).toBe(204);
    expect((await put(as(owner), doc(), { version: "1.0.0", metrics: { ...METRICS, lint: { ...all, "made-up": 1 } } })).status).toBe(400);
  });

  it("documents list: editor and owner only, paginated, short key, both sorts", async () => {
    const path = `/api/ds/libraries/${lib}/usage/documents`;
    expect((await call(as(viewer), "GET", path)).status).toBe(403);
    expect((await call(as(stranger), "GET", path)).status).toBe(404);
    const first = await json<{ items: Array<{ documentKey: string; version: string; tokenCoverage: number | null; behind: boolean }>; nextCursor: string | null }>(
      await call(as(editor), "GET", `${path}?limit=2`),
    );
    expect(first.items).toHaveLength(2);
    expect(first.items[0].documentKey).toHaveLength(8);
    expect(first.nextCursor).toBe("2");
    const second = await json<{ items: unknown[] }>(await call(as(owner), "GET", `${path}?limit=2&cursor=${first.nextCursor}&sort=coverage`));
    expect(second.items.length).toBeGreaterThan(0);
    expect((await call(as(owner), "GET", `${path}?cursor=abc`)).status).toBe(400);
  });

  it("emits ds_usage_reported with buckets only", async () => {
    const before = analytics.events.length;
    await put(as(owner), doc());
    const event = analytics.events.slice(before).find((e) => e.event === "ds_usage_reported");
    expect(event?.properties).toMatchObject({ nodes_bucket: "100-1000", token_coverage_bucket: "50-75", has_lint: true, replaced: false });
    expect(JSON.stringify(analytics.events)).not.toContain("var_brand");
  });

  it("purging the library removes its reports", async () => {
    const id = (await json<{ id: string }>(await call(as(owner), "POST", "/api/ds/libraries", { name: "Temp", orgId }))).id;
    await call(as(owner), "POST", `/api/ds/libraries/${id}/versions`, { baseVersion: null, bump: "minor", snapshot: BASE }, { "Idempotency-Key": randomUUID() });
    const key = doc();
    expect((await put(as(owner), key, undefined, id)).status).toBe(204);
    await call(as(owner), "DELETE", `/api/ds/libraries/${id}`);
    expect((await call(as(owner), "DELETE", `/api/ds/libraries/${id}?purge=true`)).status).toBe(204);
    expect((await app().pglite.query("SELECT 1 FROM ds_usage WHERE library_id = $1", [id])).rows).toHaveLength(0);
  });
});
