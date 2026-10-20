# Desktop sign-in and the move to app.sideform.pro

Date: 2026-10-20. Step 3 of `2026-10-04-accounts-and-remote-mcp-design.md`.

## Why

Sideform Desktop loads `https://pen-editor.onrender.com/app`. The frontend turns
accounts on only when the page origin equals the backend's `APP_ORIGIN`
(`https://app.sideform.pro`). So the desktop is always anonymous:

- agent memory, user skills and shares live under a separate anonymous id that
  never meets the web account;
- the remote `/mcp` endpoint routes a call only to a tab of the token's owner, so
  Codex / Claude Code cannot drive a desktop canvas.

The user chose: sign in through the **system browser** with a `sideform://` deep
link, and move the desktop to **`https://app.sideform.pro/app`** with a migration
of the old origin's local data.

## Goals

1. The desktop loads `https://app.sideform.pro/app` (and the derived `/agent`,
   `/doc`, `/trace` URLs) by default.
2. On first launch after the update, the desktop copies the old origin's
   `localStorage` and the two IndexedDB databases into the new origin, without
   deleting the old data.
3. "Sign in" in the desktop opens the system browser. Every sign-in method works
   there (Google, magic link, password). The browser hands control back through
   `sideform://auth?...`, and the desktop ends up with its own session cookie.
4. After sign-in, every desktop view (agent panel, canvas tabs) sees the
   session without a reload. The existing anon-data claim then moves the
   migrated `pen.userId` data onto the account.

## Non-goals

- Signing and notarizing the app, Windows/Linux builds (the build is `--mac` only;
  the argv path is still handled because it costs a few lines).
- Moving `.pen` documents: they are never stored in the browser (in-memory, file
  download), so the origin change cannot lose them.
- Any change to the legacy `/api/mcp` loopback bridge.
- A desktop-native account UI. Account management stays on `/account`.

## Anti-goals

- Losing local user data on the origin change (markdown docs `pen.docs.*`,
  `pen.userId`, share edit tokens, plugins, custom fonts).
- A reload of an editor view after sign-in: canvases are in-memory, a reload
  loses work.
- A token in the deep link that a third party can replay or that works for long.
- Signing out in the desktop also signing out the user's browser (and the
  reverse).

## Flow

```
desktop main                     system browser (app.sideform.pro)          backend (api.sideform.pro)
------------                     ---------------------------------          --------------------------
signIn(): state, verifier = random;
challenge = b64url(sha256(verifier));
remember {state, verifier, until+10m}
openExternal(/auth/desktop?state=S&challenge=C)
                                 /auth/desktop: save {S,C} to localStorage;
                                 signed out → /sign-in?next=/auth/desktop
                                 signed in → user confirms with a click
                                 → POST /api/account/desktop-token {challenge:C} ──► row desktop-ott:T =
                                                                               {userId, C} (3 min), no session yet
                                 ◄── {token}
                                 location = sideform://auth?token=T&state=S
open-url / second-instance:
state must match + be unexpired (the attempt stays valid until expiry
or a new signIn: a replay is harmless, the token is single use)
send "auth:token" {token, verifier} to ONE listening view
(held in main until a view listens; a window is opened if none)
                                 (desktop view, origin app.sideform.pro)
                                 POST /api/account/desktop-exchange {token, verifier} ──► consume row, check
                                                                               sha256(verifier)==C, create the
                                                                               desktop session, Set-Cookie
                                 Better Auth "better-auth.message" broadcast → other views refetch session
```

Why PKCE: `sideform://` is not owned by us. Another local app can register the
same scheme and read `token` and `state` from the link. Without the verifier,
which never leaves the desktop main process until delivery to its own view,
that app cannot exchange the token.

### Contract (all three repos must agree)

- Browser URL: `<editorOrigin>/auth/desktop?state=<S>&challenge=<C>`.
  `S`: base64url, 32 random bytes (43 chars). `verifier`: base64url, 32 random
  bytes. `C` = base64url (no padding) of SHA-256 over the ASCII verifier. The
  page accepts `S` and `C` only when they match `^[A-Za-z0-9_-]{43}$`.
- Deep link: `sideform://auth?token=<T>&state=<S>` (host `auth`, URL-encoded).
- `POST /api/account/desktop-token` body `{ challenge }` (session cookie
  required) → 200 `{ token }`; 401 `sign_in_required`; 400 `invalid_challenge`;
  503 `auth_disabled`.
- `POST /api/account/desktop-exchange` body `{ token, verifier }` (no session
  needed) → 200 `{ user: { id, email } }` plus `Set-Cookie`; 400
  `invalid_token` for every failure (unknown/used/expired token, wrong
  verifier) — one error so it leaks nothing; 503 `auth_disabled`.
- Preload (both `window.penDesktop.auth` and `window.penAgentPanel.auth`,
  optional): `signIn(): void`, `onToken(cb: (p: { token: string; verifier: string }) => void): () => void`.
- IPC channels: `auth:sign-in` (renderer → main, `send`), `auth:listen` /
  `auth:unlisten` (renderer → main, sent by the preload when `onToken` is
  subscribed / unsubscribed), `auth:token` (main → renderer, payload
  `{ token, verifier }`).

## Backend (`pen-editor-backend`)

- Enable Better Auth `oneTimeToken({ disableClientRequest: true })` in
  `src/auth/index.ts`. Its HTTP endpoints must be unreachable: the auth config
  lists `/one-time-token/generate` and `/one-time-token/verify` in
  `disabledPaths` (server-side `auth.api.*` calls bypass that router check),
  and the `/api/auth/*` catch-all also answers 404 when the **normalized**
  pathname of the Web Request contains `/one-time-token` (dot segments and
  `%2e%2e` cannot slip past a raw-URL compare). No DB migration
  (`verification` table).
- `POST /api/account/desktop-token` (next to `claim-anon`, NOT under the
  catch-all): session via `readSession(request, { fresh: true })`. It creates
  **no session**. It stores one row `desktop-ott:<T>` with value
  `{userId, challenge}` JSON, `expiresAt` now + 3 min, `T` = 32 random bytes
  base64url. Rate limit 10/min; `Cache-Control: no-store`.
- `POST /api/account/desktop-exchange`: consume `desktop-ott:<T>` (single
  use, so a wrong verifier burns it); check `b64url(sha256(verifier))` with
  `timingSafeEqual`; check the user still exists; THEN
  `internalAdapter.createSession(userId, false, { userAgent: "Sideform Desktop", ipAddress })`
  (the desktop's own session: browser sign-out leaves it alone), mint a
  plugin `one-time-token:<rand>` row pointing at that session token, and call
  `auth.api.verifyOneTimeToken({ ..., returnHeaders: true })` to get the
  session `Set-Cookie`; copy every `Set-Cookie`, answer `{ user: { id, email } }`.
  Any failure -> 400 `invalid_token`; a session created before a later step
  failed is deleted again. Rate limit 20/min; `no-store`.
- Tests (real Better Auth on PGlite, `test/authHarness.ts`): desktop-token 401
  signed out, 400 bad challenge; full happy path: token + verifier → cookie →
  `get-session` returns the user; second exchange fails; wrong verifier fails;
  exchange of a token whose challenge row is missing fails; signing out the
  browser session leaves the desktop session valid; HTTP
  `POST /api/auth/one-time-token/verify` and `GET .../generate` return 404.
- CLAUDE.md "Accounts / Better Auth": a short paragraph; link this spec from
  the accounts spec's step-3 line.

## Frontend (`pen-editor`)

- `PenDesktopApi.auth?` (`src/lib/desktopBridge.ts`) and the same on
  `window.penAgentPanel` (`src/lib/agentPanel.ts`), both optional (old shells):
  the contract above. One
  helper `desktopAuth()` returns whichever exists.
- New route `/auth/desktop` (`src/routes/DesktopAuthPage.tsx`, lazy, no
  editor/Pixi imports; excluded from bridge bootstrap like `/agent`):
  - reads `state`/`challenge` from the query (validated per the contract) and
    stores them in `localStorage` `pen.desktopAuth.pending` with a timestamp;
    without a query it reads that key (valid 10 min). This survives a magic
    link opened in a new tab and an OAuth callback that drops the query.
    Neither source valid → error text;
  - accounts off → message that sign-in is unavailable;
  - signed out → `navigate(signInPath)` with `next=/auth/desktop?state=…`
    (check `safeNext` keeps the query);
  - signed in → asks "Sign in to Sideform Desktop as <email>?" with a warning
    to continue only if sign-in was started from the desktop just now. **No
    automatic hand-off**: without a click, any local app or website could open
    this page with its own challenge and receive a session. The click does
    `POST /api/account/desktop-token {challenge}` via `apiFetch`, then sets
    `window.location.href = "sideform://auth?token=…&state=…"`; the sent state
    offers "Try again" (fresh token). Cancel removes the pending key. A 401
    (cached browser session revoked server-side) signs the browser out and goes
    to sign-in.
- Token receiver: a small module mounted from `AuthBootstrap` (all routes) when
  `desktopAuth()` exists. On `onToken({token, verifier})`:
  `apiFetch("/api/account/desktop-exchange", POST {token, verifier})`,
  then refetch the session in this view (`$sessionSignal`) and post a session
  event on Better Auth's own cross-tab channel (`better-auth.message`), which
  makes every other same-origin view refetch. No reload. A failed exchange
  shows a toast.
  `AuthBootstrap` is mounted at router level, so `SessionSync` (and with it the
  anon claim) runs in every view, `/agent` included; a second view's claim gets
  the one-shot 409, which `claimAnon.ts` already treats as done. Check this
  holds; if `/agent` skips `AuthBootstrap`, mount it there.
- Sign-in entry points inside the desktop: wherever the UI navigates to
  `/sign-in` (`signInPath` users), call `desktopAuth().signIn()` instead when it
  exists. `/sign-in` itself, when opened inside the desktop, shows a single
  "Continue in browser" button that calls `signIn()` (Google blocks OAuth in an
  embedded browser, and a magic link opens in the system browser, so in-app
  forms would mislead).
- Tests (Vitest + `src/test/authMocks.ts`): page states, the hand-off URL, the
  receiver (verify call + broadcast), the desktop branch of `/sign-in`.

## Desktop (`pen-editor-desktop`)

- `DEFAULT_EDITOR_URL = "https://app.sideform.pro/app"` (`src/main/config.ts`);
  update tests, `e2e/launch.ts`, CLAUDE.md mentions.
- **Origin migration**, new module `src/main/originMigration.ts`:
  - Runs before the main window loads, only when the editor URL is the default
    (no `PEN_DESKTOP_URL` override) and `userData/origin-migration.json` does not
    say `done` for `pen-editor.onrender.com → app.sideform.pro`.
  - A hidden window on the default session loads
    `https://pen-editor.onrender.com/__sideform_migrate__`, answered LOCALLY by
    a temporary `protocol.handle("https")` on the default session (a tiny blank
    HTML page; every other request passes through to the network). So the
    migration needs no network, no redirect can send it to another origin, and
    the editor app never boots on the old origin. It exports with `executeJavaScript`: all
    `localStorage` entries and all records of IndexedDB `pen-editor-plugins`
    (store `plugins`) and `pen-editor-custom-fonts` (store `fonts`, `bytes` is an
    ArrayBuffer → base64 in transit).
    Before loading, service workers and Cache Storage of both origins are
    cleared (never localStorage/IndexedDB): a legacy PWA worker would otherwise
    serve its precached editor before the protocol handler sees the request.
  - The same hidden window loads `https://app.sideform.pro/__sideform_migrate__`
    (also local) and imports. Exceptions to fill-only, valid while no done flag
    exists: the old `pen.userId` overwrites a new-origin one (that one can only
    come from a launch whose migration failed), and `pen.docs.index` is merged
    (union by doc id, the new-origin entry wins a duplicate). Otherwise: a `localStorage` key is written only when absent on the new origin;
    an IndexedDB record only when its key is absent (create the DB/store with
    the same name, keyPath and version semantics as `src/utils/indexedDbStore.ts`
    in the frontend — read it).
  - Safety timeout 5 s; the protocol handler is removed before the main window
    is created; a migration guard keeps `window-all-closed`, `activate` and
    `second-instance` from quitting or showing anything meanwhile. On any
    failure or timeout: log, do **not** write `done`, start normally (retry
    next launch). After 3 failed attempts a terminal record (`failed: true`)
    stops the retries. A quit during the migration skips window creation. On success write `done` with
    counts. Never delete the old origin's data.
  - Pure parts (decision, merge rules, (de)serialization) unit-tested with an
    injected port; the Electron glue thin.
- **Deep link**:
  - `package.json` `build.protocols: [{ name: "Sideform", schemes: ["sideform"] }]`.
  - `app.setAsDefaultProtocolClient("sideform")` (dev: with `process.execPath`
    and the app path args).
  - `open-url` registered before `ready` (queue until the window exists);
    `second-instance` and initial `process.argv` parse a `sideform://` arg.
  - `src/main/desktopAuth.ts`: `beginSignIn()` makes state + verifier +
    challenge per the contract, keeps `{state, verifier}` in memory 10 minutes
    (only the latest attempt is valid), opens
    `<editorOrigin>/auth/desktop?state=…&challenge=…` with `shell.openExternal`.
    `handleDeepLink(url)`: only `sideform://auth`, requires a pending unexpired
    matching state (kept until expiry or a new `beginSignIn`), then sends
    `auth:token` `{token, verifier}` to one view that listens (`auth:listen`):
    the agent panel first, else an editor tab. With no listening view the token
    is held until one listens or becomes eligible (tab activation, a committed
    navigation), opening the main window if none is open; only a valid link for
    the pending attempt may open a window. Anything else is ignored and logged
    without the token. Listener registrations are dropped on a committed
    cross-document navigation or `destroyed`, never on `did-start-navigation`.
  - Unpackaged runs (`npm run dev`, e2e) register the scheme only with
    `PEN_DESKTOP_REGISTER_PROTOCOL=1`, so they never take `sideform://` from the
    installed app.
  - IPC: `auth:sign-in` (renderer → main, sender must be an editor view or the
    panel on the editor origin), `auth:token` (main → renderer). Preloads
    `tab.ts` and `agentPanel.ts` expose `auth.{signIn,onToken}`. Update
    `test/ipcContract.test.ts`, `test/preloadTab.test.ts`.
  - Native menu: "Sign In…" in the File menu → `beginSignIn()` (`MenuActions`,
    `test/menu.test.ts`).

## Decisions made by the author (not the user)

- PKCE on top of state (see Flow), plus an explicit click in the browser.
- The desktop gets its own session, not the browser's.
- Migration fills only absent keys. The desktop's Electron profile has never
  loaded app.sideform.pro (except a dev `PEN_DESKTOP_URL` override, which skips
  migration), so in practice nothing collides. The old host stays live: it is
  the same Render static site, app.sideform.pro is a custom domain on it.
- The cookie is set by an `api.sideform.pro` response and sent back to it, so
  it works with or without `AUTH_COOKIE_DOMAIN`.
- Dev: with `PEN_DESKTOP_URL`, sign-in opens `<that origin>/auth/desktop`; it
  works only if the local backend's `APP_ORIGIN` equals that origin.

## Merge order

Backend first (route + plugin), then frontend (page + receiver), then desktop
(new origin + deep link). The desktop must not ship before the frontend serves
`/auth/desktop` on app.sideform.pro. No tool contract is touched.

## Left to the builder

Exact copy of UI strings (sentence case, short), file layout inside each
module, how the session refetch is triggered in the Better Auth client, the
hidden-window type (`BrowserWindow({show:false})` is fine).
