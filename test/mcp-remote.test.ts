import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { resetBridgeForTests } from "../src/mcp/bridge.js";
import { BRIDGE_TICKET_TTL_MS, mintBridgeTicket } from "../src/mcp/bridgeTickets.js";
import { CANVAS_RESOURCE_URI } from "../src/mcp/canvasWidget.js";
import { makeConfig } from "./helpers.js";
import { APP_ORIGIN, useAuthApp } from "./authHarness.js";
import { connectFakeEditor, expectAnnotatedTools, waitForSessionCount } from "./mcpEditorHelpers.js";

const LEGACY_TOKEN = "a-very-secret-token!";
const ISSUER = "http://localhost:3001/api/auth";
const RESOURCE = "http://localhost:3001/mcp";
const app = useAuthApp({ MCP_AUTH_TOKEN: LEGACY_TOKEN });

interface Account {
  cookie: string;
  userId: string;
  apiKey: string;
}

let seq = 0;
async function createAccount(): Promise<Account> {
  const cookie = await app().signUp(`mcp${++seq}@example.test`);
  const session = await app().fetchAuth("/api/auth/get-session", { headers: { Cookie: cookie } });
  const created = await app().fetchAuth("/api/auth/api-key/create", {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: "codex" }),
  });
  return { cookie, userId: (await session.json()).user.id, apiKey: (await created.json()).key };
}

// A fake tab for the account that answers get_editor_state with its own label.
const openTab = (account: Account, file: string) =>
  connectFakeEditor(app().url, { cookie: account.cookie }, { get_editor_state: JSON.stringify({ file }) });

async function connectClient(bearer: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app().url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

async function editorFile(client: Client): Promise<string> {
  const result = await client.callTool({ name: "get_editor_state", arguments: { include_schema: false } });
  return JSON.stringify(result.content);
}

function rawMcp(method: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app().url}/mcp`, {
    method,
    headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), accept: "application/json, text/event-stream", ...headers },
    body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined,
  });
}

function expectChallenge(res: Response): void {
  expect(res.headers.get("www-authenticate")).toContain(
    'resource_metadata="http://localhost:3001/.well-known/oauth-protected-resource',
  );
}

describe("/mcp credentials", () => {
  it.each(["POST", "GET", "DELETE"])("%s without credentials is 401 with the resource-metadata challenge", async (method) => {
    const res = await rawMcp(method);
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  it.each(["garbage", "sf_not-a-real-key"])("rejects the bearer %s with the same challenge", async (bearer) => {
    const res = await rawMcp("POST", { Authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  it("does not accept the legacy static token", async () => {
    expect((await rawMcp("POST", { Authorization: `Bearer ${LEGACY_TOKEN}` })).status).toBe(401);
  });

  it("answers 503 auth_disabled when accounts are off", async () => {
    const off = await buildApp(makeConfig(), { logger: false });
    try {
      const res = await off.inject({ method: "POST", url: "/mcp", payload: {} });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "auth_disabled" });
    } finally {
      await off.close();
    }
  });
});

describe("/mcp API key", () => {
  it("sends embed-first instructions in the initialize result", async () => {
    const client = await connectClient((await createAccount()).apiKey);
    expect(client.getInstructions()).toContain('load_skill("prototype")');
    expect(client.getInstructions()).toContain("ONE top-level `embed`");
    await client.close();
  });

  it("lists tools and routes a bridged call to the key owner's own tab only", async () => {
    resetBridgeForTests();
    const [alice, bob, carol] = [await createAccount(), await createAccount(), await createAccount()];
    const tabs = [await openTab(alice, "alice.pen"), await openTab(bob, "bob.pen")];
    await waitForSessionCount(2);

    const aliceClient = await connectClient(alice.apiKey);
    expect((await aliceClient.listTools()).tools.map((t) => t.name)).toContain("batch_design");
    expect(await editorFile(aliceClient)).toContain("alice.pen");
    const bobClient = await connectClient(bob.apiKey);
    expect(await editorFile(bobClient)).toContain("bob.pen");

    // No tab for this account: error names the app, and nobody else's tab answers.
    const carolClient = await connectClient(carol.apiKey);
    const none = await carolClient.callTool({ name: "get_editor_state", arguments: { include_schema: false } });
    expect(none.isError).toBe(true);
    expect(JSON.stringify(none.content)).toContain(
      `No Sideform editor is open for your account. Open ${APP_ORIGIN}/app while signed in, then retry.`,
    );

    await Promise.all([aliceClient.close(), bobClient.close(), carolClient.close()]);
    tabs.forEach((tab) => tab.close());
    await waitForSessionCount(0);
  });
});

describe("/mcp OAuth access token", () => {
  // The JWKS and issuer live at BETTER_AUTH_URL (a fixed port); the test app is
  // on an ephemeral one, so key fetches are redirected to it.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return realFetch(url.replace("http://localhost:3001", app().url), init);
    });
  });
  afterAll(() => vi.restoreAllMocks());

  async function mint(sub: string, claims: Record<string, unknown> = {}): Promise<string> {
    const auth = app().app.auth as unknown as {
      api: { signJWT(ctx: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }> };
    };
    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          sub,
          iss: ISSUER,
          aud: RESOURCE,
          scope: "mcp:tools",
          exp: Math.floor(Date.now() / 1000) + 300,
          ...claims,
        },
      },
    });
    return token;
  }

  it("authenticates by subject and routes to that user's tab", async () => {
    resetBridgeForTests();
    const account = await createAccount();
    const tab = await openTab(account, "oauth.pen");
    await waitForSessionCount(1);
    const client = await connectClient(await mint(account.userId));
    expect(await editorFile(client)).toContain("oauth.pen");
    await client.close();
    tab.close();
    await waitForSessionCount(0);
  });

  it("evicts a ticket session when the OAuth client has no consent or refresh token", async () => {
    resetBridgeForTests();
    const account = await createAccount();
    const client = await connectClient(await mint(account.userId, { azp: "revoked-client" }));
    const result = (await client.callTool({ name: "open_canvas", arguments: {} })) as { _meta: Record<string, { ticket: string }> };
    const tab = await connectFakeEditor(app().url, { ticket: result._meta["sideform/bridge"].ticket });
    await waitForSessionCount(1);
    const closed = new Promise<number>((resolve) => tab.on("close", resolve));
    expect((await client.callTool({ name: "get_editor_state", arguments: { include_schema: false } })).isError).toBe(true);
    expect(await closed).toBe(4401);
    await client.close();
    await waitForSessionCount(0);
  });

  it("rejects a token minted for another audience", async () => {
    const res = await rawMcp("POST", { Authorization: `Bearer ${await mint("u", { aud: "http://localhost:3001/other" })}` });
    expect(res.status).toBe(401);
    expectChallenge(res);
  });

  it("answers 403 insufficient_scope when mcp:tools is missing", async () => {
    const res = await rawMcp("POST", { Authorization: `Bearer ${await mint("u", { scope: "openid" })}` });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
  });
});

describe("/api/mcp/ws owner binding", () => {
  it("accepts a session cookie, rejects no credential, and keeps legacy tabs away from /mcp users", async () => {
    resetBridgeForTests();
    await expect(connectFakeEditor(app().url, null)).rejects.toThrow("HTTP 401");

    const account = await createAccount();
    const legacyTab = await connectFakeEditor(app().url, LEGACY_TOKEN, { get_editor_state: '{"file":"legacy.pen"}' });
    await waitForSessionCount(1);
    const client = await connectClient(account.apiKey);
    expect((await client.callTool({ name: "get_editor_state", arguments: { include_schema: false } })).isError).toBe(true);

    const cookieTab = await openTab(account, "cookie.pen");
    await waitForSessionCount(2);
    expect(await editorFile(client)).toContain("cookie.pen");

    // The legacy surface still reaches only the token tab.
    const legacyClient = new Client({ name: "legacy", version: "1.0.0" });
    await legacyClient.connect(
      new StreamableHTTPClientTransport(new URL(`${app().url}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${LEGACY_TOKEN}` } },
      }),
    );
    expect(await editorFile(legacyClient)).toContain("legacy.pen");

    await Promise.all([client.close(), legacyClient.close()]);
    legacyTab.close();
    cookieTab.close();
    await waitForSessionCount(0);
  });
});

describe("/mcp hardening", () => {
  it("answers 429 (not the OAuth 401) once a key is rate-limited", async () => {
    const account = await createAccount();
    await app().pglite.query(
      `UPDATE "apikey" SET "rateLimitEnabled" = true, "rateLimitMax" = 1, "rateLimitTimeWindow" = 60000 WHERE "referenceId" = $1`,
      [account.userId],
    );
    const bearer = { Authorization: `Bearer ${account.apiKey}` };
    expect((await rawMcp("POST", bearer)).status).toBe(200);
    const limited = await rawMcp("POST", bearer);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("keeps an API key usable across many requests with the default limit", async () => {
    const account = await createAccount();
    for (let n = 0; n < 12; n++) {
      expect([n, (await rawMcp("POST", { Authorization: `Bearer ${account.apiKey}` })).status]).toEqual([n, 200]);
    }
  });

  it("sends bearer-only CORS headers on hijacked responses and exposes WWW-Authenticate on 401", async () => {
    const account = await createAccount();
    const origin = "https://claude.example";
    const ok = await rawMcp("POST", { Authorization: `Bearer ${account.apiKey}`, Origin: origin });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ok.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
    const denied = await rawMcp("POST", { Origin: origin });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });
});

describe("/api/mcp/ws cookie upgrade", () => {
  it("refuses a missing or foreign Origin, but accepts the app origin", async () => {
    const account = await createAccount();
    for (const origin of ["https://evil.example"]) {
      await expect(connectFakeEditor(app().url, { cookie: account.cookie, origin })).rejects.toThrow("HTTP 403");
    }
    const noOrigin = new WebSocket(`${app().url.replace(/^http/, "ws")}/api/mcp/ws`, { headers: { Cookie: account.cookie } });
    await expect(
      new Promise((resolve, reject) => {
        noOrigin.on("open", resolve);
        noOrigin.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        noOrigin.on("error", reject);
      }),
    ).rejects.toThrow("HTTP 403");
    const ok = await openTab(account, "origin.pen");
    ok.close();
  });

  it("drops the tab after sign-out, using a real lookup despite the session cookie cache", async () => {
    resetBridgeForTests();
    const account = await createAccount();
    const tab = await openTab(account, "signed-out.pen");
    await waitForSessionCount(1);
    const closed = new Promise<number>((resolve) => tab.on("close", resolve));

    const out = await app().fetchAuth("/api/auth/sign-out", { method: "POST", headers: { Cookie: account.cookie } });
    expect(out.status).toBe(200);

    const client = await connectClient(account.apiKey);
    const result = await client.callTool({ name: "get_editor_state", arguments: { include_schema: false } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No Sideform editor is open for your account");
    expect(await closed).toBe(4401);
    await client.close();
    await waitForSessionCount(0);
  });
});

describe("/mcp canvas widget", () => {
  type Meta = Record<string, { ticket: string; wsUrl: string }>;
  const openCanvas = async (client: Client) =>
    (await client.callTool({ name: "open_canvas", arguments: {} })) as { content: unknown; _meta: Meta };

  it("lists and reads the ui:// resource with the loader URL and CSP", async () => {
    const client = await connectClient((await createAccount()).apiKey);
    const listed = (await client.listResources()).resources.find((r) => r.uri === CANVAS_RESOURCE_URI);
    expect(listed?.mimeType).toBe("text/html;profile=mcp-app");
    const [content] = (await client.readResource({ uri: CANVAS_RESOURCE_URI })).contents;
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(String(content.text)).toContain(`src="${APP_ORIGIN}/embed/loader.js"`);
    const ui = (content._meta as { ui: { csp: Record<string, string[]>; prefersBorder: boolean } }).ui;
    expect(ui.prefersBorder).toBe(false);
    expect(ui.csp.resourceDomains).toEqual(expect.arrayContaining([APP_ORIGIN, "https://fonts.gstatic.com"]));
    expect(ui.csp.connectDomains).toEqual(["http://localhost:3001", "ws://localhost:3001"]);
    await client.close();
  });

  it("open_canvas returns the resource meta and a ticket for the caller; the app-only tool is flagged", async () => {
    const client = await connectClient((await createAccount()).apiKey);
    const tools = (await client.listTools()).tools;
    const open = tools.find((t) => t.name === "open_canvas");
    expect(open?._meta).toMatchObject({ ui: { resourceUri: CANVAS_RESOURCE_URI } });
    expect(tools.find((t) => t.name === "sideform_bridge_ticket")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    const result = await openCanvas(client);
    expect(result._meta["sideform/bridge"].wsUrl).toBe("ws://localhost:3001/api/mcp/ws");
    expect(result._meta["sideform/bridge"].ticket).toMatch(/^[\w-]{43}$/);
    await client.close();
  });

  it("a ticket is single use, expires, and its WS tab only serves its owner", async () => {
    resetBridgeForTests();
    const [alice, bob] = [await createAccount(), await createAccount()];
    const [aliceClient, bobClient] = [await connectClient(alice.apiKey), await connectClient(bob.apiKey)];
    const { ticket } = (await openCanvas(aliceClient))._meta["sideform/bridge"];
    const tab = await connectFakeEditor(app().url, { ticket }, { get_editor_state: '{"file":"widget.pen"}' });
    await waitForSessionCount(1);
    expect(await editorFile(aliceClient)).toContain("widget.pen");
    expect((await bobClient.callTool({ name: "get_editor_state", arguments: { include_schema: false } })).isError).toBe(true);

    await expect(connectFakeEditor(app().url, { ticket })).rejects.toThrow("HTTP 401");
    await expect(connectFakeEditor(app().url, { ticket: "nope" })).rejects.toThrow("HTTP 401");
    const stale = mintBridgeTicket(alice.userId, { expiresAt: Infinity, isValid: async () => true }, Date.now() - BRIDGE_TICKET_TTL_MS - 1);
    await expect(connectFakeEditor(app().url, { ticket: stale })).rejects.toThrow("HTTP 401");

    // The app-only tool mints a fresh, usable ticket.
    const fresh = (await aliceClient.callTool({ name: "sideform_bridge_ticket", arguments: {} })) as { _meta: Meta; structuredContent?: unknown };
    expect(fresh.structuredContent).toBeUndefined();
    const again = await connectFakeEditor(app().url, { ticket: fresh._meta["sideform/bridge"].ticket });
    await Promise.all([aliceClient.close(), bobClient.close()]);
    tab.close();
    again.close();
    await waitForSessionCount(0);
  });

  const closeCode = (tab: WebSocket) => new Promise<number>((resolve) => tab.on("close", resolve));
  const probe = (client: Client) => client.callTool({ name: "get_editor_state", arguments: { include_schema: false } });

  it("evicts a ticket session once its API key is revoked", async () => {
    resetBridgeForTests();
    const account = await createAccount();
    const client = await connectClient(account.apiKey);
    const tab = await connectFakeEditor(app().url, { ticket: (await openCanvas(client))._meta["sideform/bridge"].ticket });
    await waitForSessionCount(1);
    // The revoked key can no longer call /mcp itself, so a second key of the
    // same account triggers the owner's re-check.
    const other = await app().fetchAuth("/api/auth/api-key/create", {
      method: "POST",
      headers: { Cookie: account.cookie },
      body: JSON.stringify({ name: "second" }),
    });
    const otherClient = await connectClient((await other.json()).key);
    expect((await probe(otherClient)).isError).toBeFalsy();
    const closed = closeCode(tab);
    await app().pglite.query(`DELETE FROM "apikey" WHERE "referenceId" = $1 AND "name" = 'codex'`, [account.userId]);
    expect((await probe(otherClient)).isError).toBe(true);
    expect(await closed).toBe(4401);
    await Promise.all([client.close(), otherClient.close()]);
    await waitForSessionCount(0);
  });

  it("evicts a ticket session once its minting credential expires", async () => {
    resetBridgeForTests();
    const account = await createAccount();
    const client = await connectClient(account.apiKey);
    const ticket = mintBridgeTicket(account.userId, { expiresAt: Date.now() + 100, isValid: async () => true });
    const tab = await connectFakeEditor(app().url, { ticket });
    await waitForSessionCount(1);
    const closed = closeCode(tab);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await probe(client)).isError).toBe(true);
    expect(await closed).toBe(4401);
    await client.close();
    await waitForSessionCount(0);
  });

  it("annotates every tool (remote /mcp) and identifies as sideform", async () => {
    const client = await connectClient((await createAccount()).apiKey);
    expect(client.getServerVersion()?.name).toBe("sideform");
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["open_canvas", "sideform_bridge_ticket"]));
    expectAnnotatedTools(tools);
    await client.close();
  });

  it("is absent from the legacy /api/mcp surface", async () => {
    const legacy = new Client({ name: "legacy", version: "1.0.0" });
    await legacy.connect(
      new StreamableHTTPClientTransport(new URL(`${app().url}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${LEGACY_TOKEN}` } },
      }),
    );
    const legacyTools = (await legacy.listTools()).tools;
    expect(legacy.getServerVersion()?.name).toBe("sideform");
    expectAnnotatedTools(legacyTools);
    const names = legacyTools.map((t) => t.name);
    expect(names).not.toContain("open_canvas");
    expect(names).not.toContain("sideform_bridge_ticket");
    await legacy.close();
  });
});
