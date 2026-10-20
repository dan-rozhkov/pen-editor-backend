import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "../src/routes/auth.js";
import { APP_ORIGIN, cookieHeaderFrom, useAuthApp } from "./authHarness.js";

const app = useAuthApp();

const newVerifier = () => randomBytes(32).toString("base64url");
let counter = 0;

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app().fetchAuth(path, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
    body: JSON.stringify(body),
  });
}

async function mintToken(cookie: string, verifier = newVerifier()): Promise<string> {
  const res = await post("/api/account/desktop-token", { challenge: pkceChallenge(verifier) }, cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const sessionOf = (cookie: string) =>
  app().fetchAuth("/api/auth/get-session?disableCookieCache=true", { headers: { Cookie: cookie } });

describe("POST /api/account/desktop-token", () => {
  it("answers 401 sign_in_required without a session", async () => {
    const res = await post("/api/account/desktop-token", { challenge: pkceChallenge(newVerifier()) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sign_in_required" });
  });

  it.each(["short", "x".repeat(44), `${"a".repeat(42)}=`])("answers 400 invalid_challenge for %s", async (challenge) => {
    const cookie = await app().signUp(`bad-challenge-${counter++}@example.test`);
    const res = await post("/api/account/desktop-token", { challenge }, cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_challenge" });
  });

  it("creates no session row (the session is born at exchange)", async () => {
    const cookie = await app().signUp(`no-session-${counter++}@example.test`);
    const count = async () =>
      Number((await app().pglite.query<{ n: number }>(`SELECT count(*)::int AS n FROM "session"`)).rows[0].n);
    const before = await count();
    await mintToken(cookie);
    expect(await count()).toBe(before);
  });

  it("returns a token with Cache-Control: no-store", async () => {
    const cookie = await app().signUp(`token-${counter++}@example.test`);
    const res = await post("/api/account/desktop-token", { challenge: pkceChallenge(newVerifier()) }, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { token: string }).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("POST /api/account/desktop-exchange", () => {
  it("trades token + verifier for a session cookie, once", async () => {
    const email = `happy-${counter++}@example.test`;
    const verifier = newVerifier();
    const token = await mintToken(await app().signUp(email), verifier);

    const res = await post("/api/account/desktop-exchange", { token, verifier });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { user: { id: string; email: string } };
    expect(body.user).toEqual({ id: expect.any(String), email });
    const desktopCookie = cookieHeaderFrom(res);
    expect(desktopCookie).toContain("better-auth.session_token=");

    const session = await sessionOf(desktopCookie);
    expect(((await session.json()) as { user: { email: string } }).user.email).toBe(email);

    const again = await post("/api/account/desktop-exchange", { token, verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_token" });
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a wrong verifier and burns the token", async () => {
    const verifier = newVerifier();
    const email = `wrong-${counter++}@example.test`;
    const token = await mintToken(await app().signUp(email), verifier);

    const wrong = await post("/api/account/desktop-exchange", { token, verifier: newVerifier() });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "invalid_token" });
    expect(wrong.headers.getSetCookie()).toEqual([]);
    const sessions = await app().pglite.query(
      `SELECT 1 FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1 AND s."userAgent" = 'Sideform Desktop'`,
      [email],
    );
    expect(sessions.rows).toHaveLength(0);

    const right = await post("/api/account/desktop-exchange", { token, verifier });
    expect(right.status).toBe(400);
  });

  it("rejects a token whose hand-off row is missing", async () => {
    const verifier = newVerifier();
    const token = await mintToken(await app().signUp(`nochallenge-${counter++}@example.test`), verifier);
    await app().pglite.query(`DELETE FROM verification WHERE identifier = $1`, [`desktop-ott:${token}`]);

    const res = await post("/api/account/desktop-exchange", { token, verifier });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it.each([{}, { token: "short", verifier: "x" }, { token: randomBytes(32).toString("base64url"), verifier: newVerifier() }])(
    "answers 400 invalid_token for a malformed or unknown request %#",
    async (body) => {
      const res = await post("/api/account/desktop-exchange", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    },
  );

  it("deletes the new session when a later step fails", async () => {
    const verifier = newVerifier();
    const email = `cleanup-${counter++}@example.test`;
    await app().signUp(email);
    // Planted directly: desktop-token is rate limited (10 / min) and this file is at the edge.
    const token = randomBytes(32).toString("base64url");
    const user = await app().pglite.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
    await app().pglite.query(
      `INSERT INTO verification (id, identifier, value, "expiresAt") VALUES ($1, $2, $3, now() + interval '3 minutes')`,
      [
        randomBytes(8).toString("hex"),
        `desktop-ott:${token}`,
        JSON.stringify({ userId: user.rows[0].id, challenge: pkceChallenge(verifier) }),
      ],
    );
    const { internalAdapter } = await app().app.auth!.$context;
    const spy = vi.spyOn(internalAdapter, "createVerificationValue").mockRejectedValueOnce(new Error("boom"));
    try {
      const res = await post("/api/account/desktop-exchange", { token, verifier });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_token" });
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const sessions = await app().pglite.query(
      `SELECT 1 FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1 AND s."userAgent" = 'Sideform Desktop'`,
      [email],
    );
    expect(sessions.rows).toHaveLength(0);
  });

  it("gives the desktop its own session: signing out the browser leaves it valid", async () => {
    const verifier = newVerifier();
    const browserCookie = await app().signUp(`own-session-${counter++}@example.test`);
    const token = await mintToken(browserCookie, verifier);
    const desktopCookie = cookieHeaderFrom(await post("/api/account/desktop-exchange", { token, verifier }));
    expect(desktopCookie).not.toBe(browserCookie);

    const signOut = await post("/api/auth/sign-out", {}, browserCookie);
    expect(signOut.status).toBe(200);
    expect(await (await sessionOf(browserCookie)).json()).toBeNull();
    expect(((await (await sessionOf(desktopCookie)).json()) as { user: unknown }).user).toBeTruthy();
  });
});

describe("one-time-token plugin HTTP endpoints", () => {
  it("are unreachable through the catch-all", async () => {
    const verify = await post("/api/auth/one-time-token/verify", { token: randomBytes(32).toString("base64url") });
    expect(verify.status).toBe(404);
    const cookie = await app().signUp(`ott-${counter++}@example.test`);
    const generate = await app().fetchAuth("/api/auth/one-time-token/generate", { headers: { Cookie: cookie } });
    expect(generate.status).toBe(404);
  });
});

/** Raw request line: fetch() would normalize the dot segments away. */
function rawPost(path: string, body: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(app().url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", Origin: APP_ORIGIN } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("one-time-token verify bypass attempts", () => {
  // A plugin-format row planted directly: desktop-token is rate limited (10 / min).
  it("answers 404 for dot-segment and %2e%2e paths, leaving the hand-off intact", async () => {
    const token = randomBytes(32).toString("base64url");
    await app().pglite.query(
      `INSERT INTO verification (id, identifier, value, "expiresAt") VALUES ($1, $2, $3, now() + interval '3 minutes')`,
      [randomBytes(8).toString("hex"), `one-time-token:${token}`, "irrelevant"],
    );
    for (const path of [
      "/api/auth/x/../one-time-token/verify",
      "/api/auth/x/%2e%2e/one-time-token/verify",
      "/api/auth/x/%2E%2E/one-time-token/verify",
      "/api/auth/./one-time-token/verify",
    ]) {
      const res = await rawPost(path, JSON.stringify({ token }));
      expect(res.status, path).toBe(404);
    }
    const rows = await app().pglite.query(`SELECT 1 FROM verification WHERE identifier = $1`, [`one-time-token:${token}`]);
    expect(rows.rows).toHaveLength(1);
  });
});
