# pen-editor-backend

The AI design-agent server for the Pencil editor — a Fastify service that streams
LLM turns (via the Vercel AI SDK + OpenRouter) and exposes the design tools the
browser executes against its local scene graph.

## Architecture in one paragraph

This is a **split-execution agent**. The backend declares tool *schemas* and streams
the model's tool calls, but most tools have **no `execute`** — they run in the browser
against the Zustand scene graph. A handful of read-only tools (`get_guidelines`,
`get_style_guide*`) and the internet-search tools (`web_search`, `fetch_url`) *do*
execute on the backend. See `CLAUDE.md` for the full picture.

## Setup

```bash
npm install
cp .env.example .env   # fill in DEEPSEEK_API_KEY and OPENROUTER_API_KEY (both required)
npm run dev            # tsx watch on http://localhost:3001
```

### Environment

| Var | Required | Purpose |
|-----|----------|---------|
| `DEEPSEEK_API_KEY` | yes | chat agent LLM access, direct DeepSeek API (not OpenRouter) |
| `OPENROUTER_API_KEY` | yes | vision, analysis, image generation and the showcase's default model — not the chat model |
| `CHAT_MODEL` | no | default chat model, provider-prefixed (`deepseek:deepseek-flash`); prefix picks DeepSeek-direct vs. OpenRouter, a bare id with no recognized prefix is treated as OpenRouter. No legacy alias: an old `OPENROUTER_MODEL` env value does NOT carry over — `loadConfig()` exits loudly if `OPENROUTER_MODEL` is set without `CHAT_MODEL` |
| `CHAT_REASONING_EFFORT` | no | `xhigh\|high\|medium\|low\|minimal\|none`, default `none`; applies to the main chat model only. DeepSeek only accepts `low\|high\|max`, so the scale is compressed: `none`→disabled, `minimal`/`low`→`low`, `medium`/`high`→`high`, `xhigh`→`max`. For an OpenRouter `CHAT_MODEL`, only `none` was measured to actually suppress reasoning on `deepseek/*` — `effort` gradations and `reasoning.max_tokens` are both ignored by it |
| `STRUCTURED_MODEL` | no | model for the two `generateObject()` calls needing a real `json_schema` response format (user-skills generate, prototype-link); default `openrouter:deepseek/deepseek-v4.1-flash`, always OpenRouter regardless of `CHAT_MODEL` — `@ai-sdk/deepseek` has no structured-output support |
| `CORS_ALLOWED_ORIGINS` | no | comma-separated origin allowlist |
| `MOBBIN_REDIRECT_ORIGINS` | no | comma-separated allowlist of origins `/api/mobbin/register`/`/token` will accept as an OAuth redirect URI. Falls back to `CORS_ALLOWED_ORIGINS`, then to loopback-only — production runs with an empty `CORS_ALLOWED_ORIGINS`, so **this must be set in production** or `/api/mobbin/register` 400s for every real origin (boot logs a warning either way) |
| `X-Mobbin-Token` (request header, not an env var) | no | per-request Mobbin OAuth access token — enables research mode's Mobbin MCP toolset for that request only. The backend stores no credential; see `src/routes/mobbinAuth.ts` and `docs/superpowers/specs/2026-09-18-mobbin-mcp-design.md` |
| `TAVILY_API_KEY` | no | enables internet search (`web_search` / `fetch_url`) |
| `S3_*` | no | image upload (all four required together) |

## Commands

```bash
npm run dev     # tsx watch with --env-file=.env
npm run build   # tsc → dist/
npm run start   # node dist/index.js
npm run lint    # ESLint (0 errors expected)
npm test        # Vitest — no API keys or network needed (LLM + MCP mocked)
```

## Agent modes

Set via the `agentMode` field on `POST /api/chat` (`src/ai/system-prompt.ts`):

- **edits** (default) — create/modify designs on the canvas.
- **prototype** — quickly insert a single top-level `embed` node of static HTML.
- **research** — Mobbin-only toolset for design research. There is no gate on this mode: `agentMode` is recorded into traces/analytics only, and a user who hasn't connected their own Mobbin account via `X-Mobbin-Token` simply gets no reference tools at all for that request, silently.

## Tools

Schemas live in `src/ai/tools.ts` (canvas tools) and `src/ai/web-search.ts`
(internet tools). Canvas tools are executed in the browser; the rest run here.

**Canvas (client-executed):** `get_editor_state`, `batch_get`, `snapshot_layout`,
`get_variables`, `set_variables`, `batch_design`, `replace_all_matching_properties`,
`find_empty_space_on_canvas`, `search_all_unique_properties`.

**Static / backend-executed:** `get_guidelines`, `get_style_guide_tags`, `get_style_guide`.

### Internet search (backend-executed, optional)

Enabled only when `TAVILY_API_KEY` is set — backed by the [Tavily](https://tavily.com)
API (free tier: 1,000 credits/month; basic search = 1 credit). Available in **edits**
and **prototype** modes, so the agent can ground designs in real content instead of
inventing it. Defined in `src/ai/web-search.ts` (`getWebTools(config)`), merged into the
default toolset in `src/routes/chat.ts`. Both run on the server and never reach the browser.

#### `web_search`

Search the public internet for information, references, copy, data, or inspiration.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `query` | string | — | required |
| `max_results` | number | `5` | clamped to `1..10` |
| `topic` | `"general" \| "news"` | `"general"` | |
| `search_depth` | `"basic" \| "advanced"` | `"basic"` | basic = 1 credit, advanced = 2 |

Returns `{ query, answer?, results: [{ title, url, content, score }] }`. `answer` is
Tavily's synthesized summary when available.

#### `fetch_url`

Read the full text of up to 5 specific web pages (use after `web_search`).

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `urls` | string[] | — | required, 1–5 URLs |
| `extract_depth` | `"basic" \| "advanced"` | `"basic"` | |

Returns `{ results: [{ url, raw_content }], failed: [{ url, error }] }`.

Both tools never throw out of `execute`: on an API/network failure they return
`{ error: string }` so a failed search doesn't abort the agent turn.

## Showcase generation (`src/showcase/`)

`npm run showcase:generate` is a standalone script (no HTTP request involved) that
prompts the same agent turn `/api/chat` uses (via `prepareChatTurn` in
`src/ai/chatTurn.ts`, so the showcase can never drift from prod's system prompt/tool
set) with a random mobile-app theme, harvests up to 5 `embed` screens from its
`batch_design` calls, renders each to a PNG with Playwright Chromium, uploads both the
PNG and the raw HTML to S3, and inserts a row per screen into `showcase_screens`
(read by `GET /api/showcase`, `src/routes/showcase.ts`).

Requires `TRACE_DATABASE_URL` and all four `S3_*` vars (see above) — the script exits
early with an explanation if either is missing. Also requires a Playwright browser
binary, installed once per machine:

```bash
npx playwright install chromium
```

```bash
npm run showcase:generate   # tsx --env-file=.env src/showcase/run.ts
```

## Testing

Tests live in `test/` (Vitest). The LLM (`src/ai/provider.js`) and MCP
(`src/ai/mcp.js`) are mocked, so the suite needs no API keys or network. The chat
route uses `reply.hijack()`, so integration tests `listen` on an ephemeral port and
read the SSE stream with `fetch` rather than `app.inject()`. The internet tools are
tested in `test/web-search.test.ts` with a stubbed global `fetch`.
