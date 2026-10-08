// Real Better Auth (real plugins, real migrations) on PGlite behind the real
// Fastify app — the only way to test cookies, OAuth discovery and the claim
// transaction without mocking away the thing under test. Emails are captured
// instead of sent. Pair with chatHarness.ts's startApp for the HTTP plumbing.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Config } from "../src/config.js";
import type { BuildAppOptions } from "../src/app.js";
import type { EmailMessage } from "../src/auth/email.js";
import type { OrgAuditWriter } from "../src/auth/orgAudit.js";
import { startApp, type RunningApp } from "./chatHarness.js";
import { makeConfig } from "./helpers.js";
import { createDsStore, type DsStore } from "../src/ds/dsStore.js";
import { createPgliteAuthPool } from "./pgliteAuthPool.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

export const APP_ORIGIN = "https://app.example.test";
export const PASSWORD = "correct-horse-battery";

export interface AuthHarness extends RunningApp {
  emails: EmailMessage[];
  pglite: PGlite;
  harness: PgliteHarness;
  /** Registers + verifies an account; resolves to a `Cookie` header value. */
  signUp(email: string): Promise<string>;
  /** Fetch against the running app with the Origin Better Auth trusts. */
  fetchAuth(path: string, init?: RequestInit): Promise<Response>;
}

export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

export async function startAuthApp(
  overrides: Partial<Config> = {},
  options: Omit<BuildAppOptions, "logger" | "auth" | "authPool" | "authOptions" | "dsStore"> & {
    /** Wire a real DsStore on the harness's PGlite (design-system libraries). */
    withDsStore?: boolean;
    /** Replaces the no-op organization audit writer. */
    orgAudit?: OrgAuditWriter;
    /** Runs before an email is captured; throw to simulate a failed send. */
    beforeSend?: (message: EmailMessage) => void;
    /** Decorate the DsStore (fault injection). Only used together with `withDsStore`. */
    wrapDsStore?: (store: DsStore) => DsStore;
  } = {},
): Promise<AuthHarness> {
  const { withDsStore, wrapDsStore, orgAudit, beforeSend, ...appOptions } = options;
  const harness = await createPgliteHarness([]);
  const emails: EmailMessage[] = [];
  const wrapDs = (store: DsStore | null) => (store && wrapDsStore ? wrapDsStore(store) : store);
  const config = makeConfig({
    BETTER_AUTH_SECRET: randomBytes(24).toString("hex"),
    // Only has to be truthy: the stores below are injected, and the auth pool
    // is PGlite.
    TRACE_DATABASE_URL: "postgres://unused.invalid/db",
    BETTER_AUTH_URL: "http://localhost:3001",
    APP_ORIGIN,
    ...overrides,
  });
  const running = await startApp(config, {
    traceStore: null,
    showcaseStore: null,
    memoryStore: null,
    learnedSkillStore: null,
    auditDb: null,
    sharedCanvasStore: null,
    userSkillStore: null,
    ...appOptions,
    // PGlite is one connection: the auth pool serializes connection leases, so
    // publish's BEGIN ... COMMIT cannot interleave. end() is a no-op because
    // the harness closes PGlite itself.
    dsStore: withDsStore ? wrapDs(createDsStore("postgres://unused.invalid/db", { ...createPgliteAuthPool(harness.pglite), end: async () => {} })) : null,
    authPool: createPgliteAuthPool(harness.pglite),
    authOptions: { sendEmail: async (message) => {
        beforeSend?.(message);
        emails.push(message);
      },
      orgAudit },
  } as BuildAppOptions);

  const fetchAuth: AuthHarness["fetchAuth"] = (path, init = {}) =>
    fetch(`${running.url}${path}`, {
      redirect: "manual",
      ...init,
      headers: { Origin: APP_ORIGIN, "Content-Type": "application/json", ...init.headers },
    });

  return {
    ...running,
    emails,
    pglite: harness.pglite,
    harness,
    fetchAuth,
    async signUp(email) {
      // Better Auth rate-limits sign-up per client IP (3 / 10 s); every
      // account in a test gets its own address so setup never trips it.
      const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
      const created = await fetchAuth("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "X-Forwarded-For": ip },
        body: JSON.stringify({ email, password: PASSWORD, name: "Test User" }),
      });
      if (!created.ok) throw new Error(`sign-up failed: ${created.status} ${await created.text()}`);
      const link = emails.findLast((m) => m.to === email)?.text.match(/https?:\/\/\S+/)?.[0];
      if (!link) throw new Error("no verification email captured");
      const verified = await fetchAuth(new URL(link).pathname + new URL(link).search, {
        headers: { "X-Forwarded-For": ip },
      });
      return cookieHeaderFrom(verified);
    },
    close: async () => {
      await running.close();
      await harness.close();
    },
  };
}

// One app per test file: PGlite boot + migrations are the expensive part.
export function useAuthApp(
  overrides: Partial<Config> = {},
  options: Parameters<typeof startAuthApp>[1] = {},
): () => AuthHarness {
  let current: AuthHarness | undefined;
  beforeAll(async () => {
    current = await startAuthApp(overrides, options);
  });
  afterAll(async () => {
    await current?.close();
  });
  return () => current as AuthHarness;
}

const ISSUER = "http://localhost:3001/api/auth";
const RESOURCE = "http://localhost:3001/mcp";

/** An OAuth access token (an "agent" principal) for `sub`, signed by the app's own JWKS. */
export async function mintMcpToken(running: AuthHarness, sub: string, claims: Record<string, unknown> = {}): Promise<string> {
  const auth = running.app.auth as unknown as {
    api: { signJWT(ctx: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }> };
  };
  const { token } = await auth.api.signJWT({
    body: {
      payload: { sub, iss: ISSUER, aud: RESOURCE, scope: "mcp:tools", exp: Math.floor(Date.now() / 1000) + 300, ...claims },
    },
  });
  return token;
}

/**
 * The OAuth guard fetches the JWKS from BETTER_AUTH_URL (http://localhost:3001),
 * which is not where the test app listens: send those requests to the app.
 */
export function useLocalAuthIssuer(current: () => AuthHarness): void {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return realFetch(url.replace("http://localhost:3001", current().url), init);
    });
  });
  afterAll(() => vi.restoreAllMocks());
}
