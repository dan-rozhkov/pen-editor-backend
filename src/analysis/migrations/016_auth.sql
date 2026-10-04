-- Accounts (Better Auth 1.7.7). GENERATED, not hand-written: this is the output
-- of Better Auth's own migration planner (`getMigrations(auth.options)
-- .compileMigrations()`, what `npx auth generate` prints for the Kysely
-- adapter) against an empty Postgres, for EXACTLY the plugin set in
-- src/auth/index.ts: emailAndPassword, magicLink, google, jwt, mcp
-- (oauth-provider), cimd, apiKey, database rate limit. Better Auth never
-- migrates at runtime here — this file is the schema. When the plugin set or
-- the library version changes, regenerate; test/auth-migration.test.ts fails
-- until the committed SQL matches what the library expects.
--
-- Column names are Better Auth's own camelCase (quoted); they are not ours to
-- rename. Our own tables stay snake_case.

CREATE TABLE IF NOT EXISTS "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

CREATE TABLE IF NOT EXISTS "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

CREATE TABLE IF NOT EXISTS "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

CREATE TABLE IF NOT EXISTS "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

CREATE TABLE IF NOT EXISTS "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

CREATE TABLE IF NOT EXISTS "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

CREATE TABLE IF NOT EXISTS "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

CREATE TABLE IF NOT EXISTS "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

CREATE TABLE IF NOT EXISTS "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

CREATE TABLE IF NOT EXISTS "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

CREATE TABLE IF NOT EXISTS "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" timestamptz, "enabled" boolean, "rateLimitEnabled" boolean, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" timestamptz, "expiresAt" timestamptz, "createdAt" timestamptz not null, "updatedAt" timestamptz not null, "permissions" text, "metadata" text);

CREATE TABLE IF NOT EXISTS "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

CREATE INDEX IF NOT EXISTS "session_userId_idx" on "session" ("userId");

CREATE INDEX IF NOT EXISTS "account_userId_idx" on "account" ("userId");

CREATE INDEX IF NOT EXISTS "verification_identifier_idx" on "verification" ("identifier");

CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" on "oauthClient" ("userId");

CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" on "oauthConsent" ("userId");

CREATE INDEX IF NOT EXISTS "apikey_configId_idx" on "apikey" ("configId");

CREATE INDEX IF NOT EXISTS "apikey_referenceId_idx" on "apikey" ("referenceId");

CREATE INDEX IF NOT EXISTS "apikey_key_idx" on "apikey" ("key");

CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- Anonymous -> account claims (POST /api/account/claim-anon). `anon_id` is the
-- browser's `pen.userId`; the PRIMARY KEY is what makes a claim one-shot: a
-- second claim of the same anon id, by anyone, conflicts and returns 409.
CREATE TABLE IF NOT EXISTS anon_claims (
  anon_id    text PRIMARY KEY,
  user_id    text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS anon_claims_user_idx ON anon_claims (user_id);
