# Cloud browser for the web build (Steel)

Date: 2026-09-29. Status: approved for implementation.
Spike: `bench/cloud-browser/` in the workspace root (outside every repo). Its results are summarized in §8.

## 1. Goal

Today the agent's `browse_*` tools work only inside the Electron shell (`pen-editor-desktop`, `BrowserController` driving a `WebContentsView`). This design makes the same tools available in the **web** build. It does that by running the **same `BrowserController`** on the backend, against a remote Chromium hosted by [Steel](https://steel.dev) and reached over CDP (`playwright.chromium.connectOverCDP`).

Non-goals:
- A per-user login. The project has no auth; quotas key on the anonymous `userId` plus the client IP, see §5.
- Residential proxies or captcha solving. Steel supports both, and they can be switched on later with one flag.
- Changing any tool's schema or name. No tool is added or removed, so the tool-name contract is untouched.

## 2. Topology

```
browser (web build)                    backend (Render)                         Steel
browse_* handler                       POST /api/browser/cmd/:name
  └ getBrowserBridge()  ──fetch──▶       verify handle → registry lookup
     = cloudBrowserBridge                 └ BrowserController (vendored)  ──CDP/wss──▶ Chromium session
     (desktop: window.penDesktop.browser)    └ PlaywrightBrowserTarget
```

The tools stay **client-executed**, so split execution is preserved. On the web the bridge just forwards the call to the backend instead of to Electron IPC.

## 3. Backend

### 3.1 Vendored controller

- `src/browser/vendor/{controller,pageScripts,keys,navigation}.ts` are copies of `pen-editor-desktop/src/main/{browser/controller,browser/pageScripts,browser/keys,navigation}.ts`.
  - `navigation.ts` is reduced to `decideBrowserNavigation`, the only symbol the controller uses. Its `electron` type import is removed.
  - `BrowserTabInfo`, which comes from desktop `tabManager.ts`, is inlined as a type.
  - Relative imports get `.js`, which NodeNext requires.
  - Those are the **only** permitted edits. The controller logic is never forked.
- `scripts/sync-browser-vendor.mjs` (`npm run browser:sync`) regenerates the copies from `../pen-editor-desktop`. It applies the mechanical rewrites and adds a header comment naming the source commit.
- `test/browserVendorSync.test.ts`:
  - When `../pen-editor-desktop` exists, it asserts that the vendored files equal the sync script's output for the current desktop sources. If they don't, the test tells you to run `npm run browser:sync`.
  - When the directory is absent, the test is skipped. This is the same pattern as the frontend's cross-repo contract test.
- The vendor directory is excluded from ESLint and jscpd, because it is foreign code checked in desktop's CI. It **is** type-checked by `tsc`.

### 3.2 Playwright handle

`src/browser/playwrightHandle.ts` is ported from the spike (`bench/cloud-browser/src/playwrightHandle.ts`). It implements `BrowserPageHandle` and `BrowserTarget` over an **existing** Playwright `BrowserContext` obtained from `connectOverCDP`. It carries the spike's two fixes:
- `onceDomReady` waits for the *next* DOMContentLoaded.
- `loadURL` tolerates an `ERR_ABORTED` that a challenge redirect supersedes.

It also fixes the spike's stale `getTitle`: the title is read live from the page on every call, and a cache is used only as a fallback while the page is navigating. The cursor overlay is on, so the live view shows it.

### 3.3 Steel client

`src/services/steel.ts` is a thin `fetch` wrapper over the Steel REST API, with no SDK dependency:
- `createSession({timeoutMs, dimensions})` returns `{id, liveViewUrl, websocketUrl}`.
- `getSession(id)` returns `{id, status}`.
- `releaseSession(id)`.
- `cdpUrl(id)` builds `wss://connect.steel.dev?apiKey=…&sessionId=…`.

The API key never leaves the backend. `liveViewUrl` is the embeddable viewer URL that Steel returns (`debugUrl`/`sessionViewerUrl`). The implementer confirms against the current Steel docs which one is meant for iframe embedding, and that it carries no API key.

### 3.4 Session registry and handles

`src/browser/cloudSessions.ts`:
- **Handle.** A handle is `${steelSessionId}.${sig}`, where `sig = base64url(HMAC-SHA256(key = STEEL_API_KEY, msg = "${userId}:${chatId}:${steelSessionId}"))`. The client stores it opaquely. A handle presented with a different `userId`/`chatId` fails verification, so the request gets a 403.
- **Registry.** The registry is an in-memory `Map<steelSessionId, {controller, browser, userId, chatId, lastUsedAt, expiresAt, liveViewUrl}>`.
- **`resolve(userId, chatId, handle, command)`:**
  1. Handle valid and in the registry: use that entry.
  2. Handle valid but not in the registry (Render restarted or slept): call `getSession`. If the session is live, reconnect with `connectOverCDP` and build a new controller. `lastSnapshot` is lost by design; the next `perform` gets the controller's normal "stale snapshotId" error, and the agent re-snapshots.
  3. Session gone, or no handle at all:
     - If the command is `open` (or `tabs` with `action:"new"`), create a new session, subject to quota (§5), and return the **new** handle.
     - For any other command, return the error `No cloud browser session — call browse_open first.` If an expired handle was supplied, the error is `Cloud browser session expired — call browse_open again.` and carries `sessionExpired: true`.
- **Idle sweeper.** Every 60 s, entries idle longer than `CLOUD_BROWSER_IDLE_MS` (default 5 min) are released. So is any entry past `expiresAt`. Release means closing the Playwright connection and calling Steel `releaseSession`. On `SIGTERM`, everything is released on a best-effort basis.
- Commands for one session are already serialized by the controller's own FIFO mutex.
- **Per-chat reuse.** A handle-less `open` (or `tabs new`) in a chat that already has a live session returns that session, and concurrent creates for one (userId, chatId) share a single Steel create, so parallel or retried opens cannot orphan sessions.
- **Disconnect eviction.** When the CDP connection drops (Steel timeout, crash), the entry is removed from the registry and released at Steel best-effort; the next command takes the "expired" path.
- **In-flight guard.** Each entry counts its running commands (`inFlight`); the sweeper skips the idle criterion while it is above zero, so a long command is never disposed mid-run. The hard `expiresAt` still applies.

### 3.5 Routes

`src/routes/cloudBrowser.ts` (the routes 503 when `STEEL_API_KEY` is unset):

| Route | Body | Response |
|---|---|---|
| `GET /api/browser/config` | — | `{ enabled: boolean }` (never 503) |
| `POST /api/browser/cmd/:name` | `{ userId, chatId, handle?, args? }` | `{ result, handle, liveViewUrl, expiresAt }` |
| `POST /api/browser/release` | `{ userId, chatId, handle }` | `{ released: boolean }` |

- **`name`** is one of `open | act | findImages | read | snapshot | screenshot | tabs | perform`. Anything else gets a 400.
- **`result`** is exactly what the desktop bridge would resolve with, i.e. the controller's return value, including `{error}` objects. The frontend handlers stay unchanged.
- **Validation.** `userId` must pass `isPlausibleUserId`, and `chatId` is a 1..128 string. Both go through zod.
- **Timeouts.** The server gives each command the controller's own timeout, `open` included.
- **Rate limit.** The route rate limit is 120/min per IP, via the existing `@fastify/rate-limit` with `global: false`.

### 3.6 Config

Added to `config.ts` as zod only; it stays SDK-free, since the frontend imports it:
- `STEEL_API_KEY` (optional). If it is unset, the whole feature is off.
- `CLOUD_BROWSER_MAX_SESSIONS`, default `5`. Steel's free tier allows 10 concurrent sessions.
- `CLOUD_BROWSER_SESSION_TIMEOUT_MS`, default `900000`. That is 15 min, the free-tier maximum, and it is passed to Steel.
- `CLOUD_BROWSER_IDLE_MS`, default `300000`.
- `CLOUD_BROWSER_DAILY_SESSIONS`, default `20`. This is per userId and per IP (§5).

### 3.7 Chat gate

- **Capability field.** `chatBodySchema.clientCapabilities` gains `browser: z.enum(["desktop","cloud"]).optional()` and keeps the legacy `desktopBrowser` boolean. The effective value is `browser ?? (desktopBrowser ? "desktop" : undefined)`.
- **Gate.** In `prepareChatTurn`, the `browse_*` tools stay when the effective value is `"desktop"`, or when it is `"cloud"` **and** `config.STEEL_API_KEY` is set. Otherwise they are deleted, exactly as today. The value is per request and constant within a chat, so prompt caching is unaffected.
- **Wording.** Tool descriptions and prompt text that say the browser exists "only in the desktop app" are made neutral ("the built-in browser").

## 4. Frontend

- **Bridge selection.** `src/lib/tools/browser/bridge.ts` exports `getBrowserBridge(): BrowserBridge | undefined`, which returns `window.penDesktop?.browser ?? cloudBrowserBridge`. `BrowserBridge` is `NonNullable<PenDesktopApi["browser"]>`. Every `window.penDesktop?.browser` read in `src/lib/tools/browser/*` goes through it. The desktop shell keeps its own bridge unchanged.
- **Cloud bridge.** `src/lib/cloudBrowser.ts` implements `cloudBrowserBridge`, one method per bridge method, each calling `POST /api/browser/cmd/:name` through `resolveApiUrl`. The body carries `userId` (the existing `pen.userId` helper), the current chat `sessionId`, and the stored handle.
  - The handle is stored per chat in a module map mirrored to `sessionStorage` (`pen.cloudBrowser.<chatId>`), so a page reload reuses the session. All storage access is wrapped in try/catch.
  - Like the desktop bridge, it **never rejects**. HTTP and network failures resolve to `{ error: "<message>" }`, and HTTP 429/503 bodies pass their message through.
  - The active chat id is set by `useDesignChat` (`setCloudBrowserChat(sessionId)`) whenever the session changes.
- **Capability.** `useDesignChat` sends `clientCapabilities: { desktopBrowser, browser: desktopBrowser ? "desktop" : "cloud" }`. The backend alone decides whether cloud is enabled; that is the gate in §3.7.
- **Live view.** A small store (`useCloudBrowserStore`: `chatId → {liveViewUrl, expiresAt}`) is filled from each `cmd` response. `CloudBrowserPanel` shows in the chat panel while the current chat has a live cloud session. It is a collapsible card with an `<iframe>` of `liveViewUrl` (16:10, `sandbox="allow-scripts allow-same-origin"`), plus "Open in new tab" and "Close browser" actions. Close calls `/api/browser/release` and clears the handle. It follows existing panel styling and theme tokens and is hidden in the desktop shell.
- **Release.** Starting a new chat or deleting a chat releases that chat's session, fire-and-forget. A page unload does **not** release it: a reload reuses the session, and the idle sweeper covers abandonment.

## 5. Quotas and abuse

There is no auth, so these limits make abuse costly rather than impossible:
- A global cap of `CLOUD_BROWSER_MAX_SESSIONS` live sessions. A new session over the cap returns HTTP 503 `All cloud browsers are busy — try again in a few minutes.`
- `CLOUD_BROWSER_DAILY_SESSIONS` new sessions per UTC day, **per userId and per IP independently**. Over either limit returns HTTP 429. The counters live in memory, and resetting them on restart is acceptable.
- A session lives at most 15 min (the Steel `timeout`) and is released after 5 min idle.
- Handle-less `open`/`tabs new` reuses the chat's live session, so for session access the (userId, chatId) pair is equivalent to the handle: both are random client-held UUIDs. Accepted trade-off, to prevent orphaned sessions from parallel or retried opens.
- Navigation safety: `decideBrowserNavigation` allows only http(s). The browser runs in Steel's network, not ours, so there is no SSRF into Render.

## 6. Render free tier

- The backend only holds CDP clients (`playwright` is already a dependency); no Chromium runs on Render.
- Nothing on Render needs to survive a restart. The handle lives on the client, and the Steel session outlives the process, so a restart costs one ~2 s reconnect.
- While the agent works, the chat is already keeping the service awake.

## 7. Tests

Backend:
- Handle sign/verify.
- Registry: create, reuse, reconnect after the registry is lost, expired sessions, idle sweep. These use a fake Steel client and a fake connector.
- Route tests with a mocked Steel client and a stub controller target: 503 when disabled, 400 on a bad name, 403 on a bad handle, 429 and 503 quotas.
- Chat-gate tests for the desktop, cloud-enabled, cloud-disabled and legacy flag cases.
- The vendor sync test.

Frontend:
- `getBrowserBridge` selection.
- `cloudBrowserBridge`: fetch stub, handle persistence, error mapping, never rejects.
- The capabilities in the chat body.
- The panel renders from the store.

Live e2e against Steel is out of CI, because it needs a key.

## 8. Spike numbers (2026-09-29)

- Steel cold start: 2.4–3.2 s.
- Walls:
  - Skroutz shows a Cloudflare Turnstile, because of the datacenter IP.
  - Google `/search` shows a wall even from a residential IP.
  - Booking, Amazon, Wikipedia and GitHub pass.
- Latency with the controller on a Mac and remote CDP to Steel `iad`, as p50: snapshot 0.4–0.8 s, act 4.4 s, screenshot 2.4 s. That is acceptable for now. If it is not, the fix is to co-locate the backend region with Steel.
