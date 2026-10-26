import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { claimAnonData, type ClaimPool } from "../src/auth/claim.js";
import { deleteAccount } from "../src/auth/deleteAccount.js";
import { useAuthApp } from "./authHarness.js";

const ANON = "11111111-1111-4111-8111-111111111111";
const ANON_B = "33333333-3333-4333-8333-333333333333";

const app = useAuthApp();

async function accountId(cookie: string): Promise<string> {
  const res = await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } });
  return (await res.json()).user.id;
}

const claim = (cookie: string | undefined, body: unknown) =>
  app().fetchAuth("/api/account/claim-anon", {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: JSON.stringify(body),
  });

const rows = async (sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
  (await app().pglite.query(sql, params)).rows as Array<Record<string, unknown>>;

describe("POST /api/account/claim-anon", () => {
  it("needs a session and a plausible anonId", async () => {
    expect((await claim(undefined, { anonId: ANON })).status).toBe(401);
    const cookie = await app().signUp("claim-validate@example.test");
    for (const anonId of ["test", "", 5]) {
      expect([anonId, (await claim(cookie, { anonId })).status]).toEqual([anonId, 400]);
    }
  });

  it("moves every anonymous row to the account, resolving key collisions in the account's favour", async () => {
    const cookie = await app().signUp("claim-move@example.test");
    const me = await accountId(cookie);
    const db = app().pglite;
    await db.query(
      `INSERT INTO agent_memory (user_id, target, entries) VALUES
         ($1, 'memory', '["anon note"]'), ($1, 'user', '["anon pref"]'), ($2, 'user', '["mine"]')`,
      [ANON, me],
    );
    await db.query(
      `INSERT INTO user_skills (user_id, name, body) VALUES
         ($1, 'shared-name', 'anon body'), ($1, 'only-anon', 'b'), ($2, 'shared-name', 'my body')`,
      [ANON, me],
    );
    await db.query(`INSERT INTO agent_review_state (user_id, turns_since_memory) VALUES ($1, 3), ($2, 1)`, [ANON, me]);
    await db.query(`INSERT INTO agent_memory_prefs (user_id, enabled) VALUES ($1, false)`, [ANON]);
    await db.query(
      `INSERT INTO shared_canvases (id, owner_id, edit_token, document) VALUES ('c1', $1, 't', '{}')`,
      [ANON],
    );
    await db.query(
      `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload) VALUES ($1, 'foreground', 'memory', 'add', '{}')`,
      [ANON],
    );

    const res = await claim(cookie, { anonId: ANON });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimed: true,
      moved: {
        agent_memory: 1,
        agent_review_state: 0,
        agent_memory_prefs: 1,
        agent_selfimprove_audit: 1,
        agent_scenarios: 0,
        user_skills: 1,
        shared_canvases: 1,
      },
    });

    expect(await rows(`SELECT target, entries FROM agent_memory WHERE user_id = $1 ORDER BY target`, [me])).toEqual([
      { target: "memory", entries: ["anon note"] },
      { target: "user", entries: ["mine"] },
    ]);
    expect(await rows(`SELECT name, body FROM user_skills WHERE user_id = $1 ORDER BY name`, [me])).toEqual([
      { name: "only-anon", body: "b" },
      { name: "shared-name", body: "my body" },
    ]);
    expect(await rows(`SELECT turns_since_memory FROM agent_review_state WHERE user_id = $1`, [me])).toEqual([
      { turns_since_memory: 1 },
    ]);
    expect(await rows(`SELECT enabled FROM agent_memory_prefs WHERE user_id = $1`, [me])).toEqual([{ enabled: false }]);
    expect(await rows(`SELECT owner_id FROM shared_canvases WHERE id = 'c1'`)).toEqual([{ owner_id: me }]);
    for (const [table, column] of [["agent_memory", "user_id"], ["user_skills", "user_id"], ["agent_review_state", "user_id"], ["agent_memory_prefs", "user_id"], ["shared_canvases", "owner_id"]]) {
      expect(await rows(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [ANON])).toEqual([]);
    }
    expect(await rows(`SELECT user_id FROM anon_claims WHERE anon_id = $1`, [ANON])).toEqual([{ user_id: me }]);
  });

  it("is one-shot: the same anonId answers 409 for the owner and for anyone else, and moves nothing", async () => {
    const first = await app().signUp("claim-first@example.test");
    const second = await app().signUp("claim-second@example.test");
    expect((await claim(first, { anonId: ANON_B })).status).toBe(200);

    await app().pglite.query(`INSERT INTO user_skills (user_id, name, body) VALUES ($1, 'late', 'b')`, [ANON_B]);
    for (const cookie of [first, second]) {
      const res = await claim(cookie, { anonId: ANON_B });
      expect([res.status, await res.json()]).toEqual([409, { error: "already_claimed" }]);
    }
    expect(await rows(`SELECT user_id FROM user_skills WHERE name = 'late'`)).toEqual([{ user_id: ANON_B }]);
  });
});

describe("claimAnonData transaction", () => {
  it("rolls back and releases the connection when a table update fails", async () => {
    const sqls: string[] = [];
    const release = vi.fn();
    const pool: ClaimPool = {
      connect: async () => ({
        release,
        query: async (sql) => {
          sqls.push(sql.split(/\s+/, 1)[0]);
          if (sql.startsWith("UPDATE user_skills")) throw new Error("boom");
          return { rows: [{ anon_id: "x" }], rowCount: 1 };
        },
      }),
    };
    await expect(claimAnonData(pool, "u", ANON)).rejects.toThrow("boom");
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("ROLLBACK");
    expect(sqls).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("claimAnonData concurrency", () => {
  const poolThatFailsOn = (match: string, error: unknown) => {
    const sqls: string[] = [];
    const pool: ClaimPool = {
      connect: async () => ({
        release: () => undefined,
        query: async (sql) => {
          sqls.push(sql);
          if (sql.startsWith(match)) throw error;
          return { rows: [{ anon_id: "x" }], rowCount: 1 };
        },
      }),
    };
    return { pool, sqls };
  };

  it("takes a per-account advisory lock right after BEGIN", async () => {
    const { pool, sqls } = poolThatFailsOn("UPDATE user_skills", new Error("stop"));
    await expect(claimAnonData(pool, "acct-1", ANON)).rejects.toThrow("stop");
    expect(sqls.slice(0, 2)).toEqual(["BEGIN", "SELECT pg_advisory_xact_lock(hashtext($1))"]);
  });

  it("turns a leftover unique violation into a rolled-back conflict, not a throw", async () => {
    const { pool, sqls } = poolThatFailsOn("UPDATE user_skills", Object.assign(new Error("dup"), { code: "23505" }));
    expect(await claimAnonData(pool, "acct-1", ANON)).toEqual({ claimed: false, reason: "conflict" });
    expect(sqls.at(-1)).toBe("ROLLBACK");
  });
});

describe("POST /api/account/connected-agents/revoke", () => {
  const revoke = (cookie: string | undefined, body: unknown) =>
    app().fetchAuth("/api/account/connected-agents/revoke", {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
      body: JSON.stringify(body),
    });
  const count = async (table: string, userId: string, clientId: string) =>
    (await rows(`SELECT 1 FROM "${table}" WHERE "userId" = $1 AND "clientId" = $2`, [userId, clientId])).length;

  async function seedGrant(userId: string, clientId: string): Promise<void> {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await app().pglite.query(
      `INSERT INTO "oauthClient" ("id","clientId","redirectUris") VALUES ($1,$1,'[]') ON CONFLICT DO NOTHING`,
      [clientId],
    );
    await app().pglite.query(
      `INSERT INTO "oauthConsent" ("id","clientId","userId","scopes","createdAt","updatedAt") VALUES ($1,$2,$3,'[]',$4,$4)`,
      [`c-${userId}-${clientId}`, clientId, userId, now],
    );
    await app().pglite.query(
      `INSERT INTO "oauthRefreshToken" ("id","token","clientId","userId","scopes","expiresAt","createdAt") VALUES ($1,$1,$2,$3,'[]',$4,$5)`,
      [`r-${userId}-${clientId}`, clientId, userId, later, now],
    );
    await app().pglite.query(
      `INSERT INTO "oauthAccessToken" ("id","token","clientId","userId","scopes","expiresAt","createdAt") VALUES ($1,$1,$2,$3,'[]',$4,$5)`,
      [`a-${userId}-${clientId}`, clientId, userId, later, now],
    );
  }

  it("needs a session and a clientId, and answers 503 when accounts are off", async () => {
    expect((await revoke(undefined, { clientId: "x" })).status).toBe(401);
    const cookie = await app().signUp("revoke-validate@example.test");
    expect((await revoke(cookie, {})).status).toBe(400);
    const off = await buildApp(makeConfig(), { logger: false });
    try {
      const res = await off.inject({ method: "POST", url: "/api/account/connected-agents/revoke", payload: { clientId: "x" } });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });

  it("deletes consent, refresh and access tokens for that user and client only", async () => {
    const cookie = await app().signUp("revoke-me@example.test");
    const other = await app().signUp("revoke-other@example.test");
    const [me, them] = [await accountId(cookie), await accountId(other)];
    await seedGrant(me, "agent-one");
    await seedGrant(me, "agent-two");
    await seedGrant(them, "agent-one");

    const res = await revoke(cookie, { clientId: "agent-one" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    for (const table of ["oauthConsent", "oauthRefreshToken", "oauthAccessToken"]) {
      expect([table, await count(table, me, "agent-one")]).toEqual([table, 0]);
      expect([table, await count(table, me, "agent-two")]).toEqual([table, 1]);
      expect([table, await count(table, them, "agent-one")]).toEqual([table, 1]);
    }
    expect(await (await revoke(cookie, { clientId: "never-existed" })).json()).toEqual({ revoked: true });
  });
});

describe("POST /api/account/delete", () => {
  const del = (cookie: string | undefined, body: unknown) =>
    app().fetchAuth("/api/account/delete", {
      method: "POST",
      headers: cookie ? { Cookie: cookie } : {},
      body: JSON.stringify(body),
    });
  const exec = (sql: string, params: unknown[] = []) => app().pglite.query(sql, params);

  it("needs a session, 503 when accounts are off", async () => {
    expect((await del(undefined, { confirmEmail: "x@example.test" })).status).toBe(401);
    const off = await buildApp(makeConfig(), { logger: false });
    try {
      const res = await off.inject({ method: "POST", url: "/api/account/delete", payload: { confirmEmail: "x" } });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }
  });

  it("refuses a missing or wrong confirmation email and deletes nothing", async () => {
    const cookie = await app().signUp("del-wrong@example.test");
    expect((await del(cookie, {})).status).toBe(400);
    expect((await del(cookie, { confirmEmail: "someone-else@example.test" })).status).toBe(400);
    const session = await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } });
    expect((await session.json()).user.email).toBe("del-wrong@example.test");
  });

  it("deletes app and auth rows of that account only, and clears the session cookie", async () => {
    const cookie = await app().signUp("del-me@example.test");
    const other = await app().signUp("del-other@example.test");
    const [me, them] = [await accountId(cookie), await accountId(other)];
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();

    for (const id of [me, them]) {
      await exec(`INSERT INTO agent_memory (user_id, target) VALUES ($1, 'user')`, [id]);
      await exec(`INSERT INTO user_skills (user_id, name, description, body) VALUES ($1, 's', 'd', 'b')`, [id]);
      await exec(`INSERT INTO anon_claims (anon_id, user_id) VALUES ($1, $2)`, [`anon-${id}`, id]);
      await exec(
        `INSERT INTO "apikey" ("id","configId","referenceId","key","createdAt","updatedAt") VALUES ($1,'default',$2,$1,$3,$3)`,
        [`k-${id}`, id, now],
      );
      await exec(
        `INSERT INTO "oauthClient" ("id","clientId","redirectUris","userId") VALUES ($1,$1,'[]',$2)`,
        [`cl-${id}`, id],
      );
      await exec(
        `INSERT INTO "oauthConsent" ("id","clientId","userId","scopes","createdAt","updatedAt") VALUES ($1,$2,$3,'[]',$4,$4)`,
        [`co-${id}`, `cl-${id}`, id, now],
      );
    }
    await exec(
      `INSERT INTO "verification" ("id","identifier","value","expiresAt") VALUES ('v-me','del-me@example.test','x',$1), ('v-them','del-other@example.test','x',$1)`,
      [later],
    );
    // Exact matching: neighbours whose address merely CONTAINS ours survive;
    // a magic-link / desktop-ott row of ours (JSON value) goes.
    const json = (v: unknown) => JSON.stringify(v);
    const extra: Array<[string, string, string]> = [
      ["v-ml-me", "magic-link:t1", json({ type: "magic-link", email: "del-me@example.test" })],
      ["v-ott-me", "desktop-ott:t2", json({ userId: me, challenge: "c" })],
      ["v-ml-ba", "magic-link:t3", json({ type: "magic-link", email: "bdel-me@example.test" })],
      ["v-ml-au", "magic-link:t4", json({ type: "magic-link", email: "del-me@example.test.au" })],
    ];
    for (const [id, identifier, value] of extra) {
      await exec(`INSERT INTO "verification" ("id","identifier","value","expiresAt") VALUES ($1,$2,$3,$4)`, [id, identifier, value, later]);
    }

    // Rows written under a claimed anon id AFTER the claim go too; the
    // mixed-case stored verification email matches case-insensitively.
    const lateAnon = `anon-${me}`;
    await exec(`INSERT INTO agent_memory (user_id, target) VALUES ($1, 'memory')`, [lateAnon]);
    await exec(`INSERT INTO shared_canvases (id, owner_id, edit_token, document) VALUES ('del-late-c', $1, 't', '{}')`, [lateAnon]);
    await exec(`INSERT INTO "verification" ("id","identifier","value","expiresAt") VALUES ('v-case-id','Del-Me@Example.test','x',$1)`, [later]);
    await exec(
      `INSERT INTO "verification" ("id","identifier","value","expiresAt") VALUES ('v-case-val','magic-link:c1',$2,$1)`,
      [later, json({ type: "magic-link", email: "DEL-ME@example.TEST" })],
    );

    const res = await del(cookie, { confirmEmail: "  DEL-ME@example.test " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    const cleared = res.headers.getSetCookie().find((c) => c.includes("better-auth.session_token="));
    expect(cleared).toMatch(/Max-Age=0/i);

    const gone = async (sql: string, id: string) => (await exec(sql, [id])).rows.length;
    for (const [sql, label] of [
      [`SELECT 1 FROM agent_memory WHERE user_id = $1`, "agent_memory"],
      [`SELECT 1 FROM user_skills WHERE user_id = $1`, "user_skills"],
      [`SELECT 1 FROM anon_claims WHERE user_id = $1`, "anon_claims"],
      [`SELECT 1 FROM "apikey" WHERE "referenceId" = $1`, "apikey"],
      [`SELECT 1 FROM "oauthClient" WHERE "userId" = $1`, "oauthClient"],
      [`SELECT 1 FROM "oauthConsent" WHERE "userId" = $1`, "oauthConsent"],
      [`SELECT 1 FROM "session" WHERE "userId" = $1`, "session"],
      [`SELECT 1 FROM "account" WHERE "userId" = $1`, "account"],
      [`SELECT 1 FROM "user" WHERE "id" = $1`, "user"],
    ] as const) {
      expect([label, await gone(sql, me)]).toEqual([label, 0]);
      expect([label, await gone(sql, them)]).toEqual([label, 1]);
    }
    expect((await exec(`SELECT 1 FROM "verification" WHERE "identifier" = 'del-me@example.test'`)).rows).toHaveLength(0);
    expect((await exec(`SELECT 1 FROM "verification" WHERE "identifier" = 'del-other@example.test'`)).rows).toHaveLength(1);
    const left = (await exec(`SELECT "id" FROM "verification"`)).rows.map((r) => (r as { id: string }).id);
    expect(left).toEqual(expect.arrayContaining(["v-ml-ba", "v-ml-au", "v-them"]));
    expect(left).not.toContain("v-ml-me");
    expect(left).not.toContain("v-ott-me");
    expect(left).not.toContain("v-case-id");
    expect(left).not.toContain("v-case-val");
    expect((await exec(`SELECT 1 FROM agent_memory WHERE user_id = $1`, [lateAnon])).rows).toHaveLength(0);
    expect((await exec(`SELECT 1 FROM shared_canvases WHERE owner_id = $1`, [lateAnon])).rows).toHaveLength(0);

    // A replayed cookie still carries the signed cookie-cache copy for a few
    // minutes; bypass it to prove the session row itself is gone.
    const after = await app().fetchAuth("/api/auth/get-session?disableCookieCache=true", { headers: { Cookie: cookie } });
    expect(await after.json()).toBeNull();
  });

  it("does not fail when an optional table is missing", async () => {
    // The PGlite harness has no pgvector, so the trace tables (raw_traces,
    // session_summaries) are absent, as in a deployment without them.
    expect((await exec(`SELECT to_regclass('public.session_summaries') AS t`)).rows[0]).toEqual({ t: null });
    const cookie = await app().signUp("del-missing@example.test");
    expect((await del(cookie, { confirmEmail: "del-missing@example.test" })).status).toBe(200);
  });
});

describe("deleteAccount trace cleanup", () => {
  it("returns a detached cleanup: nothing touches the trace tables until it is called", async () => {
    const seen: string[] = [];
    const client = {
      release() {},
      async query(sql: string) {
        seen.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ ok: true }] };
        if (sql.includes("FROM anon_claims")) return { rows: [{ anon_id: "a1" }] };
        return { rows: [], rowCount: 0 };
      },
    };
    const pool = { connect: async () => client } as unknown as ClaimPool;
    const { counts, cleanupTraces } = await deleteAccount(pool, { id: "u1", email: "u@example.test" });
    expect(counts).toBeTypeOf("object");
    expect(seen.some((q) => q.includes("raw_traces"))).toBe(false);
    await cleanupTraces();
    expect(seen.some((q) => q.includes('DELETE FROM "raw_traces"'))).toBe(true);
    expect(seen.some((q) => q.includes('DELETE FROM "session_summaries"'))).toBe(true);
  });
});

describe("claim merges agent_memory_prefs with opt-out winning", () => {
  const prefs = async (id: string) => rows(`SELECT enabled FROM agent_memory_prefs WHERE user_id = $1`, [id]);
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ["anon off, account on", false, true, false],
    ["anon on, account off", true, false, false],
    ["both on", true, true, true],
  ];
  it.each(cases)("%s", async (label, anonOn, mineOn, expected) => {
    const email = `claim-prefs-${label.replace(/\W+/g, "-")}@example.test`;
    const cookie = await app().signUp(email);
    const me = await accountId(cookie);
    const anon = crypto.randomUUID();
    await app().pglite.query(`INSERT INTO agent_memory_prefs (user_id, enabled) VALUES ($1, $2), ($3, $4)`, [anon, anonOn, me, mineOn]);
    expect((await claim(cookie, { anonId: anon })).status).toBe(200);
    expect(await prefs(me)).toEqual([{ enabled: expected }]);
    expect(await prefs(anon)).toEqual([]);
  });
});
