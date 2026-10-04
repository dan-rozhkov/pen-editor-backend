import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import { claimAnonData, type ClaimPool } from "../src/auth/claim.js";
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
    expect(await rows(`SELECT owner_id FROM shared_canvases WHERE id = 'c1'`)).toEqual([{ owner_id: me }]);
    for (const [table, column] of [["agent_memory", "user_id"], ["user_skills", "user_id"], ["agent_review_state", "user_id"], ["shared_canvases", "owner_id"]]) {
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
