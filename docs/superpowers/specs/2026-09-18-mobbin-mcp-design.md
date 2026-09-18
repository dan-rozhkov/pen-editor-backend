# Replacing Refero MCP with Mobbin MCP

Date: 2026-09-18
Status: design, approved for planning

## Goal

Drop Refero — a single server-held API key that gave every user the same
reference library — and connect Mobbin instead, which each user authorizes
themselves with their own paid Mobbin account.

## What Mobbin requires

- Endpoint: `https://api.mobbin.com/mcp`, streamable HTTP.
- Auth: OAuth 2.1 with Dynamic Client Registration (RFC 7591), PKCE `S256`,
  scope `openid`. Access token + refresh token. There is no API-key
  alternative — per-user authorization is the only way in.
- Plan: the account must be Mobbin Pro, Team or Enterprise. A free account
  completes OAuth and then fails at tool-call time.
- Tools: `search_screens`, `search_flows`, `search_sections`. That is the
  whole surface. There is no per-item fetch (`get_screen`), no flow detail
  (`get_flow`), no style search, and no guidance tool.
- Results carry low-resolution preview images inline, plus metadata, a
  `mobbin_url` for citation and an `image_url` for the full-resolution file.
  `image_url` expires after 30 days.
- `search_screens` and `search_flows` require a `platform` argument
  (`ios` | `web`). `search_sections` does not.
- All three take `task_intent`, which must be identical across every call
  belonging to one user task.

## Credential model

The token lives in the browser's `localStorage`. The backend stores nothing
— no table, no per-user credential rows, no callback route owning someone
else's subscription. Every Mobbin HTTP call, including the OAuth dance
itself, is made by the backend on behalf of the browser.

Routing OAuth through the backend rather than calling Mobbin from the page
directly removes any dependency on Mobbin's CORS policy for its
registration and token endpoints, which is unverified and outside our
control.

```
browser                         pen-editor-backend            api.mobbin.com
  │                                    │                            │
  │ POST /api/mobbin/register          │                            │
  │   {redirectUri}                    │─ discovery + DCR ─────────▶│
  │◀─ {clientId, authorizeUrl} ────────│                            │
  │                                    │                            │
  │ popup → authorizeUrl (PKCE S256, scope=openid, state) ─────────▶│
  │◀─ redirect /oauth/mobbin/callback?code&state ───────────────────│
  │ postMessage(code) → opener, close                               │
  │                                    │                            │
  │ POST /api/mobbin/token             │                            │
  │   {code, codeVerifier, clientId}   │─ code exchange ───────────▶│
  │◀─ {accessToken, refreshToken, expiresIn} ───────────────────────│
  │                                                                 │
  │ localStorage: pen.mobbin.{clientId,accessToken,refreshToken,expiresAt}
  │                                                                 │
  │ POST /api/chat   header: X-Mobbin-Token: <access token>         │
  │                                    │─ MCP tool calls ──────────▶│
```

Refresh follows the same shape: `POST /api/mobbin/refresh` with the refresh
token, backend exchanges, browser re-stores.

The token travels as an `X-Mobbin-Token` request header, not in the request
body. A sibling design landed the same day (`0aa8551`, OpenCode Zen as a
chat provider) establishes exactly this convention for a user-supplied
credential with `X-OpenCode-Key`; matching it keeps one mechanism for
user-held keys instead of two. A header also keeps the credential out of the
request body entirely, which is a stronger guarantee than keeping it out of
`messages` — `src/routes/chat.ts` records `messages` into `raw_traces`
(line 215), and a body field would have relied on that boundary holding.

`src/plugins/cors.ts` carries an explicit `allowedHeaders` allowlist
(`Content-Type`, `Authorization`, `Mcp-Session-Id`). `X-Mobbin-Token` must
be added there or every cross-origin preflight fails — the deployed frontend
and backend are separate origins, so this is not optional.

## Backend changes

### `src/ai/mcp.ts` — the bulk of the work

Two assumptions in this file break, both because the credential now arrives
per request instead of living in `config`:

1. `MCPServerEntry.apiKeyEnvField` reads the key from `Config`. Replace with
   a per-request token passed into `getMCPTools`.
2. The client cache is `Map<serverName, Promise<CachedEntry>>` — one client
   per process. It must be keyed by a hash of the access token, with a TTL,
   a maximum size, and `client.close()` on eviction. Without eviction every
   user who ever connects leaves a live MCP client in the process forever.
   This hazard does not exist today precisely because there is only ever one
   client.

Signature becomes `getMCPTools(config, { mobbinAccessToken })`. No token
means no Mobbin tools in the set at all — the same outcome as an unset
`REFERO_API_KEY` today, so the no-reference-tools path is already exercised.

Deleted outright: `wrapReferoTool`, `wrapReferoTools`, `wrapGetScreenImageTool`,
`extractScreenPreviewUrl`, `resultHadImageDropped`, `enrichStyleUuidResult`,
`enrichStyleUuidThrownError`, the style-UUID hint constants, and
`GET_SCREEN_IMAGE_URL_HINT`. Roughly 350 lines of Refero-specific wrapping
go away; none of it has a Mobbin counterpart.

Kept as the server-agnostic floor: `withTimeout`, `MCP_CONNECT_TIMEOUT_MS`,
`sanitizeAllToolResults`, `sanitizeMcpToolResult`, `removeBase64Fields`,
`oversizedBinaryField`.

Added: one thin wrap over the three Mobbin tools that clamps `limit`.
`search_screens` defaults to 20 and allows 30; that is a lot of images to
re-send on every step of a tool loop. The clamp value is to be measured
against live output, not guessed.

### Inline images

Tool-result images reach the model natively — `providerHandlesToolResultImages`
(`src/ai/modelRef.ts:75`) is now unconditionally true since the DeepSeek-direct
provider was reverted and OpenRouter is the only provider, and the shipped
chat model reads images. `applyVisionPreprocessing` passes them through
untouched and spends no `VISION_MODEL` budget. Reading Mobbin's previews is
therefore the default path, not something to engineer around.

The one real hazard is `MAX_INLINE_BINARY_CHARS` (24,000). It applies per
content part, so a result carrying previews of varying weight has some
dropped and some kept, leaving the model selectively blind with no error
anywhere. Measure real Mobbin preview sizes and set the threshold so a
clamped result passes whole, or drops whole — never half.

### Other backend files

- `src/routes/chat.ts` — read the `X-Mobbin-Token` header (bounded to a sane
  maximum length); thread it into `prepareChatTurn`.
- `src/plugins/cors.ts` — add `X-Mobbin-Token` to `allowedHeaders`.
- `src/ai/chatTurn.ts` — same field on `PrepareChatTurnInput` (near line 143);
  pass it to `getMCPTools` (line 724).
- New `src/routes/mobbinAuth.ts` — `register`, `token`, `refresh`. Holds no
  state beyond an in-process cache of the DCR `client_id` per redirect URI
  (`client_id` is not a secret and is not per-user; dev and prod origins
  differ, so it is cached per URI rather than globally). Registered in
  `src/app.ts` alongside the other route modules.
- `src/config.ts` — remove `REFERO_API_KEY` (line 126).
- `src/mcp/skillSurface.ts` — `EXTERNAL_SKILL_TOOL_NAMES` (line 61) currently
  lists seven Refero spellings. Replace with the three Mobbin names; leaving
  the old ones makes the skill linter report false "tool unavailable"
  warnings against a skill that is correct.

### `src/skills/research.md`

The skill is written around tools that will not exist. Its "Tool Selection"
table, its mandatory "Deep Dive: `get_screen` (Required)" section, and its
`include_similar` / `image_size` guidance all reference Refero-only
capabilities. Rewrite around the three Mobbin tools, and state the rules the
Mobbin schemas impose: `platform` is required; `task_intent` is constant per
task; every screen mentioned in the final report is cited as a markdown link
to its `mobbin_url`; `image_url` is a 30-day URL, so it is downloaded rather
than linked when the user wants to keep something.

The research budget (3–4 references, 1–2 queries) survives unchanged — it
now matters more, since each result carries images.

## Frontend changes

- New `src/lib/mobbinAuth.ts` — PKCE generation, popup orchestration, calls
  to the three backend endpoints, `localStorage` persistence, refresh on
  expiry.
- New `src/routes/MobbinCallback.tsx` at `/oauth/mobbin/callback` — reads
  `code`/`state`, `postMessage`s to the opener, closes.
- `src/hooks/useDesignChat.ts` — send the `X-Mobbin-Token` header from
  `prepareSendMessagesRequest` (line 317); refresh an expired token before
  sending. Note the sibling OpenCode design edits the same function to add
  its own header — expect to reconcile these two edits.
- `src/components/Toolbar.tsx` — a "Connect Mobbin…" / "Disconnect Mobbin"
  item in the Settings submenu (line 233), showing connection state.
- `src/components/icons/ReferoIcon.tsx` → `MobbinIcon.tsx`.
- `src/lib/toolDisplayNames.ts` — three tools instead of seven, in the three
  spellings the existing helper generates (bare, `mobbin_`, `mcp_mobbin_`).
- `src/lib/toolIcons.ts` (line 100) — brand the Mobbin tools.

## Testing

Backend tests naming Refero: `test/mcp.test.ts`, `test/mcp-timeout.test.ts`,
`test/mcp-skill-tools.test.ts`, `test/memory-review.test.ts`,
`test/assemble.test.ts`, `test/vision-messages.test.ts`.

Frontend tests naming Refero: `src/components/__tests__/ReferoIcon.test.tsx`,
`src/lib/__tests__/toolIcons.test.ts`,
`src/components/chat/__tests__/ToolCallIndicator.test.tsx` (line 172),
`src/hooks/__tests__/useDesignChat.test.ts` (line 712).

New coverage worth having:

- The token-keyed client cache evicts and closes — the leak this design
  introduces is invisible otherwise.
- A chat request with no `X-Mobbin-Token` yields a tool set with no Mobbin
  tools.
- The token never appears in what is written to `raw_traces`.
- `src/routes/mobbinAuth.ts` against a mocked Mobbin, including the
  free-plan rejection.

## Known hazards

- **Free-plan users.** OAuth succeeds; the first tool call fails. The
  failure must read as "your Mobbin plan does not include MCP access", not
  as a generic tool error.
- **Headless callers.** The showcase runner has no user and therefore no
  Mobbin tools. If `prototype.md` still does `load_skill("research")`, the
  skill will recommend tools that are absent for that run.
- **Header logging.** The token rides in every chat request header. Audit
  that Fastify request logging does not record headers.
- **Concurrent design.** `0aa8551` (OpenCode Zen provider) edits
  `src/ai/chatTurn.ts`, `src/routes/chat.ts`, `src/config.ts`,
  `src/plugins/cors.ts` and `src/hooks/useDesignChat.ts` — the same files as
  this change. Rebase before pushing.
- **Render SPA rewrite** must cover `/oauth/mobbin/callback`, or the
  callback 404s in production — the same trap `/app` and `/c/:id` hit before.
- **Token in `localStorage`** is readable by any script running on the
  origin. This is the accepted trade for not storing other people's OAuth
  credentials in our database.

## Out of scope

Keeping Refero as a fallback for unconnected users. Refero is removed
entirely; a user who does not connect Mobbin has no design-reference tools.
