# Accounts (Better Auth) + remote MCP for every agent

Date: 2026-10-04. Status: sections 1–2 approved by the user in chat; sections 3–4
decided under `/auto`. Scope = steps 1+2 of the plan. Desktop deep-link sign-in
(step 3) and the Codex plugin packaging / MCP Apps widget (step 4) get their own specs.

## Goal

1. Optional user accounts for Sideform (`sideform.pro`): Google, email magic link,
   email + password. Anonymous use keeps working exactly as today.
2. One remote MCP endpoint that any agent can use (Codex/ChatGPT plugin, Claude
   Code, Cursor, …) with per-user OAuth or a per-user API key. A call reaches the
   editor tab **of the user who owns the token**, never somebody else's.

## Hosts

- `https://app.sideform.pro` — frontend (`/` showcase, `/app` editor).
- `https://api.sideform.pro` — this backend.
- Both are config (env), never hardcoded. Local dev keeps working on localhost.

## 1. Architecture and data

### Backend env (all optional; `src/config.ts` stays zod-only, SDK-free)

| Var | Meaning |
|---|---|
| `BETTER_AUTH_SECRET` | enables auth. Auth is ON iff this **and** `TRACE_DATABASE_URL` are set |
| `BETTER_AUTH_URL` | public backend origin, e.g. `https://api.sideform.pro` (OAuth issuer base) |
| `APP_ORIGIN` | frontend origin, e.g. `https://app.sideform.pro`. Used for `trustedOrigins`, redirects, sign-in/consent page URLs |
| `AUTH_COOKIE_DOMAIN` | e.g. `sideform.pro` → cross-subdomain cookie. Unset → host-only cookie (localhost) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google provider; both unset → Google button hidden (`GET /api/auth-config`) |
| `RESEND_API_KEY`, `EMAIL_FROM` | email sending. Unset → emails are logged to stdout (dev) and `emailEnabled:false` |
| `MCP_RESOURCE_URL` | default `${BETTER_AUTH_URL}/mcp` |

Auth OFF → every new route answers 503 `{error:"auth_disabled"}`, `/api/auth-config`
answers `{enabled:false}`, and the app behaves exactly as before.

### Better Auth inside the existing Fastify app

- `basePath: "/api/auth"`. Mounted as one catch-all Fastify route
  (`/api/auth/*`, all methods) that converts the Fastify request into a Web
  `Request` and pipes `auth.handler(request)`'s `Response` back. Body: pass the raw
  body through (register the route in an encapsulated context with a
  content-type parser that keeps the raw string/buffer).
- Plugins: `emailAndPassword({ requireEmailVerification: true })`,
  `magicLink`, Google `socialProviders`, `jwt()`, `mcp()` from `@better-auth/mcp`
  (`loginPage: APP_ORIGIN + "/sign-in"`, `consentPage: APP_ORIGIN + "/consent"`,
  `resource: MCP_RESOURCE_URL`), `cimd()` from `@better-auth/cimd`
  (`metadataProfile: "mcp-2026-07-28"`), DCR allowed
  (`allowDynamicClientRegistration: true` — ChatGPT/Codex still use it), `apiKey()`
  with prefix `sf_`.
- `accountLinking: { enabled: true, trustedProviders: ["google"] }`.
- `advanced.crossSubDomainCookies` when `AUTH_COOKIE_DOMAIN` is set; cookies
  `Secure` in prod, `SameSite=Lax`, `HttpOnly`.
- `trustedOrigins: [APP_ORIGIN]`.
- `rateLimit: { enabled: true, storage: "database" }`.
- Pin `better-auth`, `@better-auth/mcp`, `@better-auth/cimd` (and
  `@better-auth/oauth-provider` if `mcp` needs it as a peer) to `1.7.x` stable.
- DB: Better Auth over the existing `pg` Pool (Neon). **Schema = our SQL migration**
  (`src/analysis/migrations/NNN_auth.sql`, runs at startup like the others),
  generated once from Better Auth's CLI for exactly this plugin set and committed.
  A test asserts the migration contains every table/column Better Auth expects
  for this config (use the library's schema export, e.g. `getAuthTables` or
  equivalent, to compare).
- New table: `anon_claims (anon_id text PRIMARY KEY, user_id text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now())`.

### Well-known

`/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`
(and the `/mcp`-suffixed RFC 9728 variant) are served at the **origin root** of
`api.sideform.pro`, delegating to the plugin. The authorization-server metadata
must advertise `code_challenge_methods_supported: ["S256"]`,
`client_id_metadata_document_supported: true`, and `registration_endpoint`.
If the library supports RFC 9207 (`iss` in the authorization response), enable
it; if not, note it in the PR — not a blocker.

### Who is the caller: `resolveActor(request)`

One helper (`src/auth/actor.ts`):
- valid session cookie → `{ kind: "user", userId }`;
- else body/query `userId` that passes `isPlausibleUserId` → `{ kind: "anon", anonId }`;
- else `{ kind: "none" }`.

**A session always wins; the body `userId` is then ignored.** Every route that
today trusts a body `userId` switches to it: `chat`, `userSkills`, `sharedCanvas`,
`cloudBrowser`, `showcasePublish`, `memoryActivity` (and any other found by
`grep -rn userId src/routes`). The id passed down stays a plain string
(`userId` for users, `anonId` for anons), so stores do not change shape.

### Claiming anonymous data

`POST /api/account/claim-anon { anonId }` (session required). In ONE transaction:
insert into `anon_claims` (conflict → 409 `already_claimed`), then
`UPDATE … SET user_id = $user WHERE user_id = $anon` on every table keyed by the
anonymous id (`agent_memory`, `agent_skills`, `user_skills`, `shared_canvases`,
`showcase_app_likes`, plus any other found by grep — verify the real column
names). Unique-constraint collisions (e.g. a like that already exists for the
user) are resolved by deleting the anon duplicate first. Returns
`{ claimed: true, moved: { <table>: n } }`.

### CORS

`src/plugins/cors.ts` switches to an options delegate:
- origin in `CORS_ALLOWED_ORIGINS` (or equal to `APP_ORIGIN`) → reflect it **with**
  `credentials: true`;
- any other origin → today's behaviour (reflect when the list is empty) but
  **never** with credentials.
So production stays as open as today for credential-less calls, and no foreign
origin can ever ride a session cookie.

## 2. Sign-in flows and UI (frontend)

- `better-auth/react` `createAuthClient({ baseURL: <backend base from apiBase.ts>, basePath: "/api/auth", fetchOptions: { credentials: "include" } })`
  plus `magicLinkClient`, `apiKeyClient` (and the oauth-provider/mcp client
  plugin if it exposes consent helpers).
- All backend fetches send `credentials: "include"` (chat transport, models,
  skills, upload, share…): one shared helper in `apiBase.ts`, not per call site.
- `GET /api/auth-config` → `{ enabled, google, emailEnabled }`; UI hides what is off.
  When `enabled:false` no sign-in UI renders at all.
- Routes (in `AppRouter.tsx`, lazy-loaded): `/sign-in`, `/consent`, `/account`.
  - `/sign-in?next=`: Google button; email field with "Email me a link" /
    "Use password"; sign-up and forgot-password; neutral wording
    ("If an account exists, we sent an email"). After success → `next` (default `/app`).
  - `/consent`: reads the OAuth query the plugin forwarded, shows the client name
    and requested scopes, Allow / Deny via the library's consent API.
    Requires a session; otherwise redirect to `/sign-in?next=<this url>`.
  - `/account`: email + linked providers, **API keys** (create → shown once,
    list, revoke), **connected agents** (OAuth consents, revoke), sign out.
- Toolbar (editor, right side) and showcase header: "Sign in" → avatar menu
  (Account, Sign out) when signed in.
- After the first sign-in in a browser that has `pen.userId`: call
  `claim-anon`, then remove `pen.userId` from localStorage (on 200 **or** 409),
  then refetch memory/skills. `getUserId()` is only used while signed out, and
  request bodies omit `userId` while signed in.
- UI copy in English (matches the editor). Tailwind tokens from `src/index.css`.

## 3. MCP for every agent and the per-user bridge

### Endpoint

- New `POST|GET|DELETE /mcp` on the backend, guarded by the plugin's
  `requireMcpAuth` (or an equivalent verify call) with `resource = MCP_RESOURCE_URL`.
  Same tool surface as today's `/api/mcp` (`src/mcp/server.ts`), built per request
  with the caller's `userId` in context.
- Credentials accepted on `/mcp`:
  1. `Authorization: Bearer <OAuth access token>` → verified (issuer, `aud` =
     resource, expiry, scope `mcp:tools`) → `userId` = token subject;
  2. `Authorization: Bearer sf_…` (API key) → verified with the `apiKey` plugin →
     its `userId`.
- Missing/invalid credential → **401** with
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`
  (this is what makes MCP clients start the OAuth flow).
- The legacy `/api/mcp` (static `MCP_AUTH_TOKEN`) is **unchanged** — it is the
  local-dev/loopback path and the desktop path keeps its own loopback server.
- Auth OFF → `/mcp` answers 503.

### Bridge (`src/mcp/bridge.ts`)

- A session records `ownerUserId: string | null` (null = legacy token session).
- `/api/mcp/ws` accepts either the legacy `?token=` (owner null, as today) **or**
  a valid session cookie (owner = session user). No token and no session → 401.
- `callTool(owner, tool, args)`: picks the owner's **most recently active**
  session (`lastActiveAt`, updated on every message from the tab and on
  focus — the frontend sends a `{type:"focus"}` message when the tab becomes
  visible/focused). Legacy `/api/mcp` calls use owner `null` (today's behaviour).
  A user's call can never reach another owner's session — enforce this in one
  place and test it.
- No session for that owner → tool error text:
  `"No Sideform editor is open for your account. Open https://app.sideform.pro/app while signed in, then retry."`
  (the URL comes from `APP_ORIGIN`).
- Single instance assumption: sessions live in process memory. Document it in
  `pen-editor-backend/CLAUDE.md`; horizontal scaling would need a shared
  registry and is out of scope.

### Frontend bridge client (`src/lib/mcpBridge.ts`)

- Signed in → connect to `/api/mcp/ws` **without** a token (cookie auth), on
  `/app` only; reconnect with the existing backoff; disconnect on sign-out.
- `VITE_MCP_WS_TOKEN` path unchanged. Desktop bridge (`isDesktopMcpBridgeActive`)
  unchanged and takes precedence as today.
- Send `{type:"focus"}` on `visibilitychange`→visible and window `focus`.

## 4. Errors and tests

Errors:
- Auth OFF anywhere → 503 `auth_disabled`; the frontend hides sign-in UI.
- Email provider missing → emails logged, `emailEnabled:false` hides magic link
  and password reset (password sign-in without verification is impossible then,
  so the email form is hidden entirely; Google still works).
- Expired/used magic link → Better Auth's error redirect to
  `/sign-in?error=…`; the page shows a plain message.
- Claim conflicts → 409, frontend still removes `pen.userId`.

Backend tests (Vitest, `test/`; Postgres is faked like the existing store tests,
or a real pg via the existing harness if one exists — follow repo patterns):
- config: auth on/off matrix; `config-import-weight` stays green.
- CORS delegate: allowlisted origin gets credentials; foreign origin never does.
- `resolveActor`: session beats body; anon fallback; none.
- claim-anon: moves rows, idempotency 409, duplicate-like collision, needs session.
- migration contains the Better Auth schema for this plugin set.
- `/mcp`: 401 + `WWW-Authenticate` without credentials; OAuth token OK; API key OK;
  wrong audience rejected; 503 when auth off.
- bridge: owner isolation (user A's call never reaches B's tab), most-recent
  session wins, `focus` updates recency, legacy token sessions only serve legacy calls.
- well-known endpoints answer with S256 + CIMD flag + registration endpoint.

Frontend tests (Vitest + happy-dom, `src/**/__tests__/`):
- auth client wiring + `credentials: "include"` helper.
- sign-in page renders per `/api/auth-config`; hidden when disabled.
- claim-anon on first sign-in removes `pen.userId` on 200 and 409.
- bodies omit `userId` while signed in.
- mcpBridge: cookie mode connects without token only when signed in; sends focus.
- consent page: redirects to sign-in without session; Allow/Deny call the API.

Gates per repo: `npm run lint`, `npm test` (never `npm test -- run`),
`npm run build`, `npm run check:dup`, `npm run check:dup:tests`; frontend also
`npm run test:coverage`.

## Deploy (manual, after merge — not part of the code)

1. Hostinger DNS: `app` CNAME → `pen-editor.onrender.com`, `api` CNAME →
   `pen-editor-backend.onrender.com`; Render custom domains for both.
2. Render backend env: the vars above; `CORS_ALLOWED_ORIGINS=https://app.sideform.pro`.
3. Render frontend env: `VITE_DESIGN_AGENT_BACKEND_URL=https://api.sideform.pro`.
4. Google Cloud OAuth client: redirect `https://api.sideform.pro/api/auth/callback/google`.
5. Resend: verify `sideform.pro` (SPF/DKIM records in Hostinger).
