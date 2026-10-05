# Sideform canvas as an MCP Apps widget

Date: 2026-10-05. Decided under `/auto` (user chose "variant 1": the editor runs
inside the agent's window, so no separate `app.sideform.pro/app` tab is needed).
Builds on `2026-10-04-accounts-and-remote-mcp-design.md`.

## Problem

Remote `/mcp` tools execute in an editor tab of the token's owner (split
execution). Without an open tab every design tool fails. MCP Apps hosts
(ChatGPT, Codex, other hosts implementing the open MCP Apps spec, SEP-1865)
can render a `ui://` HTML resource in a sandboxed iframe. If that iframe IS the
editor and joins the bridge as the owner's session, the agent has its executor
inside the chat.

## Shape

```
agent ──tools/call open_canvas──▶ api.sideform.pro/mcp
   ◀── result + _meta.ui.resourceUri + _meta["sideform/bridge"]{ticket}
host renders ui://sideform/canvas-v1.html (sandboxed iframe)
   iframe loads https://app.sideform.pro/embed/loader.js → editor (embed mode)
   iframe gets the tool result over the MCP Apps postMessage bridge
   iframe opens wss://api.sideform.pro/api/mcp/ws?ticket=… → bridge session, owner = ticket owner
agent ──tools/call batch_design──▶ /mcp ──▶ bridge ──▶ the widget (most recent session wins)
```

## Backend

1. Dependency `@modelcontextprotocol/ext-apps` (server helpers: `registerAppTool`,
   `registerAppResource`, `RESOURCE_MIME_TYPE`). Verify the API in node_modules.
2. Only on the remote `/mcp` server (not legacy `/api/mcp`, not the chat
   `penTools` set — this is an MCP-only tool like `list_skills`):
   - Resource `ui://sideform/canvas-v1.html`, mime `text/html;profile=mcp-app`.
     Body: a minimal HTML shell (no inline app code) that loads
     `${APP_ORIGIN}/embed/loader.js` as a module and sets a root element.
     `_meta.ui.csp`: `resourceDomains` = [APP_ORIGIN, Google Fonts hosts, plus
     `MCP_APP_RESOURCE_DOMAINS` env list for image hosts], `connectDomains` =
     [API origin (https), its `wss://` form, plus the same env list].
     `_meta.ui.prefersBorder` false. No `frameDomains` in v1.
   - Tool `open_canvas` (title "Open Sideform canvas"): input `{}`. Description:
     open the live Sideform canvas in this conversation; call it once before
     design tools when the client can display apps; afterwards design tools
     edit this canvas. `_meta.ui.resourceUri` = the resource (+ the
     `openai/outputTemplate` alias). Result: short text for the model and
     `_meta["sideform/bridge"] = { ticket, wsUrl }` (hidden from the model in
     hosts that support `_meta`).
   - App-only tool `sideform_bridge_ticket` (`_meta.ui.visibility: ["app"]`,
     hidden from the model) returning a fresh `{ ticket, wsUrl }` — the widget
     calls it through the host to reconnect after a dropped socket.
3. Tickets (`src/mcp/bridgeTickets.ts`): 32 random bytes base64url, in-memory
   map `ticket → { owner, expiresAt }`, TTL 120 s, single use, swept lazily.
   Minted for the `/mcp` caller's owner only. Single-instance assumption as
   the bridge.
4. `/api/mcp/ws`: accept `?ticket=` → consume → owner = ticket owner. Origin
   check does not apply to the ticket path (sandbox origins are host-specific
   and unknown); the ticket is the credential. Invalid/expired/used → 401.
   Existing `?token=` and cookie paths unchanged.
5. Tests: resource listed and read (mime, CSP meta, loader URL from
   APP_ORIGIN); `open_canvas` returns resourceUri meta and a ticket for the
   caller; app-only tool hidden from `tools/list` for the model if the SDK
   supports visibility filtering (otherwise present with visibility meta);
   ticket single use, TTL, owner binding; WS with ticket registers a session
   owned by that user and receives that user's calls; another user's calls
   never reach it; legacy `/api/mcp` tool list unchanged
   (`test/mcp-tools-contract`).

## Frontend

1. Dependency `@modelcontextprotocol/ext-apps` (App client).
2. New embed entry (`embed.html` + `src/embed/main.tsx`), built by the same
   Vite build. A small Vite plugin emits a NON-hashed
   `dist/embed/loader.js` that injects the hashed entry CSS and imports the
   hashed entry JS by absolute URL (base = the deploy origin). Hashed chunks
   stay cacheable; only the loader is fixed-name.
3. Embed mode renders the editor canvas + layers + properties only: no
   router, no chat panel, no showcase, no auth UI, no PWA/service-worker, no
   analytics, no WebMCP auto-install, no desktop bridge, no token/cookie
   bridge. Reuse the existing editor shell components with an `embed` flag
   rather than forking them.
4. `src/embed/hostBridge.ts`: create `App` from ext-apps, connect to the host,
   take the `open_canvas` tool result (`_meta["sideform/bridge"]`), start an
   `McpBridge` in ticket mode (`wsUrl?ticket=`). On close/failed connect, call
   `sideform_bridge_ticket` via the host (`callServerTool`) and reconnect with
   backoff. Request `fullscreen` display mode on the first user interaction
   (button "Expand" in a slim top bar), keep inline height ~600 px otherwise.
   Report size changes if the SDK requires it. Honour host theme only for the
   chrome (top bar), never the design canvas.
5. Top bar actions: "Open in Sideform" → create a shared canvas via the
   existing share API (anonymous path) and open it with the host's
   open-link API; disabled with a tooltip if sharing fails.
6. Persistence: autosave the scene to `localStorage` (try/catch, debounced)
   under `sideform.embed.doc`, restore on load; works where the sandbox
   allows storage, harmless where it does not.
7. `McpBridge` gains a ticket mode (no other behaviour change); hello/ack/go
   protocol unchanged.
8. Tests: embed entry boots without router/chat (happy-dom smoke); hostBridge
   extracts ticket and starts bridge; reconnect asks for a new ticket; loader
   plugin output references the built entry; autosave/restore guarded.

## Verification (manual, after deploy)

A localhost harness page using `@modelcontextprotocol/ext-apps/app-bridge`
as the host: lists/reads the resource from prod `/mcp` (API key), renders it
in a sandboxed iframe, forwards the `open_canvas` result, then a design tool
called over `/mcp` must land in the widget (screenshot). Codex/ChatGPT
rendering is host-gated and cannot be verified from here.

## Known limits

- Hosts without MCP Apps support see a text result; tools still need a tab.
- Documents live in the widget session (+ localStorage) — no cloud documents.
- Embed HTML nodes that rely on nested iframes may be blocked by host CSP.
