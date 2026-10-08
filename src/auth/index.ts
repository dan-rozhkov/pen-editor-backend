import { betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import type { JWTPayload } from "jose";
import type { DpopReplayReservations } from "better-auth/oauth2";
import type { BetterAuthOptions } from "better-auth/types";
import type { Config } from "../config.js";
import {
  createEmailSender,
  magicLinkMessage,
  resetPasswordMessage,
  verifyEmailMessage,
  type EmailSender,
} from "./email.js";
import { createOrganizationPlugin } from "./organization.js";
import { noopOrgAuditWriter, type OrgAuditWriter } from "./orgAudit.js";
import { resolveAuthSettings } from "./settings.js";

// Scope every MCP access token must carry (spec section 3).
export const MCP_SCOPE = "mcp:tools";
export const API_KEY_PREFIX = "sf_";
// OAuth access tokens are stateless JWTs: revoking a connected agent cannot
// recall one already issued, so the exposure after a revoke is this TTL
// (the library default is 1 hour).
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
// How long a signed cookie may stand in for a session lookup on HTTP routes.
// Sign-out / session revocation takes up to this long to show on those routes;
// the editor bridge bypasses the cache (src/mcp/routes.ts).
export const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;
// /mcp verifies the key on EVERY request, so the plugin's default (10 per
// day per key) would lock an agent out within seconds. 600 / minute leaves a
// busy agent ample room and still bounds a leaked key's throughput.
export const API_KEY_RATE_LIMIT = { enabled: true, timeWindow: 60_000, maxRequests: 600 } as const;

export interface AuthSession {
  session: { id: string; userId: string; expiresAt: Date };
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean };
}

export interface VerifyApiKeyResult {
  valid: boolean;
  error: { message?: string; code?: string } | null;
  key: { id: string; referenceId: string; name?: string | null } | null;
}

/** The slice of the Better Auth instance this codebase uses. */
export interface Auth {
  /** Web-standard handler behind the `/api/auth/*` catch-all. */
  handler(request: Request): Promise<Response>;
  api: {
    /** `query.disableCookieCache` forces a real DB lookup (see `session.cookieCache`). */
    getSession(context: {
      headers: Headers;
      query?: { disableCookieCache?: boolean };
    }): Promise<AuthSession | null>;
    /** Server-side API key check: `auth.api.verifyApiKey({ body: { key } })`. */
    verifyApiKey(context: { body: { key: string } }): Promise<VerifyApiKeyResult>;
    getOAuthServerConfig(...args: never[]): unknown;
    getOpenIdConfig(...args: never[]): unknown;
  };
  options: BetterAuthOptions;
  $context: Promise<{ baseURL: string; internalAdapter: DpopReplayReservations }>;
}

/** What createAuth() needs from Postgres: a pg.Pool (or a Pool-shaped fake). */
export type AuthDatabase = Parameters<typeof betterAuth>[0]["database"];

export interface CreateAuthOptions {
  /** Test seam: replaces Resend / the stdout logger. */
  sendEmail?: EmailSender;
  /** Receives organization member changes (buildApp passes the audit_log writer unless a test overrides it). */
  orgAudit?: OrgAuditWriter;
  /** Refuses organization deletion while it owns design-system libraries. */
  orgHasLibraries?: (organizationId: string) => Promise<boolean>;
  /** Test seam: replaces the pinned-DNS metadata fetch used by CIMD. */
  fetchClientMetadataResource?: typeof fetchClientMetadataResource;
}

// The schema this config needs is committed as SQL (src/analysis/migrations/
// 016_auth.sql + 018_auth_organization.sql) — Better Auth never migrates at runtime here. Adding or
// removing a plugin below changes the expected tables: regenerate the
// migration (see CLAUDE.md "Accounts / Better Auth") or test/auth-migration
// fails.
export function createAuth(config: Config, database: AuthDatabase, options: CreateAuthOptions = {}): Auth {
  const settings = resolveAuthSettings(config);
  const sendEmail = options.sendEmail ?? createEmailSender(config);
  const secure = settings.baseUrl.startsWith("https://");

  const instance = betterAuth({
    appName: "Sideform",
    baseURL: settings.baseUrl,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [settings.appOrigin],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(resetPasswordMessage(user.email, url));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(verifyEmailMessage(user.email, url));
      },
    },
    socialProviders: settings.google
      ? {
          google: {
            clientId: config.GOOGLE_CLIENT_ID as string,
            clientSecret: config.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {},
    account: {
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    advanced: {
      // The rate limiter keys on this header; webBridge.toWebRequest
      // overwrites it with Fastify's trusted request.ip, so a client-sent
      // value never reaches Better Auth.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      ...(config.AUTH_COOKIE_DOMAIN
        ? { crossSubDomainCookies: { enabled: true, domain: config.AUTH_COOKIE_DOMAIN } }
        : {}),
    },
    session: { cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS } },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await sendEmail(magicLinkMessage(email, url));
        },
      }),
      jwt(),
      mcp({
        loginPage: `${settings.appOrigin}/sign-in`,
        consentPage: `${settings.appOrigin}/consent`,
        resource: settings.mcpResource,
        scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
        // ChatGPT / Codex still register through DCR rather than CIMD, and
        // they do so without a session.
        accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({
        fetchClientMetadataResource: options.fetchClientMetadataResource ?? fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      apiKey({ defaultPrefix: API_KEY_PREFIX, rateLimit: API_KEY_RATE_LIMIT }),
      createOrganizationPlugin({
        sendEmail,
        appOrigin: settings.appOrigin,
        audit: options.orgAudit ?? noopOrgAuditWriter,
        hasLibraries: options.orgHasLibraries,
      }),
    ],
  });
  // betterAuth()'s inferred type embeds zod v4 internals that cannot be named
  // in a .d.ts (`declaration: true`), so callers get the slice they use. Every
  // member below is a real property of the instance — exercised by
  // test/auth-routes.test.ts and test/mcp-remote.test.ts (real instance).
  return instance as unknown as Auth;
}


/**
 * Wraps a Web `(request, claims) => Response` handler in the MCP resource-server
 * check: bearer OAuth access token verified against our JWKS (signature,
 * issuer, `aud` = MCP_RESOURCE_URL, expiry) with scope `mcp:tools`. A missing or
 * invalid token gets a 401 with `WWW-Authenticate: Bearer resource_metadata=...`;
 * a token without the scope gets a 403 `insufficient_scope`. `claims.sub` is
 * the account id. API keys (`sf_...`) are NOT handled here — see verifyApiKey.
 */
export function protectMcpRoute(
  auth: Auth,
  config: Config,
  handler: (request: Request, claims: JWTPayload) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return requireMcpAuth(auth, handler, {
    resource: resolveAuthSettings(config).mcpResource,
    requiredScopes: [MCP_SCOPE],
  });
}
