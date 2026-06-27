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
cp .env.example .env   # fill in OPENROUTER_API_KEY (required)
npm run dev            # tsx watch on http://localhost:3001
```

### Environment

| Var | Required | Purpose |
|-----|----------|---------|
| `OPENROUTER_API_KEY` | yes | LLM access via OpenRouter |
| `OPENROUTER_MODEL` | no | default chat model (`google/gemini-2.5-flash`) |
| `CORS_ALLOWED_ORIGINS` | no | comma-separated origin allowlist |
| `REFERO_API_KEY` | no | enables research mode (Refero MCP) |
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
- **research** — Refero-only toolset for design research; returns 503 if no MCP is connected.

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

## Testing

Tests live in `test/` (Vitest). The LLM (`src/ai/provider.js`) and MCP
(`src/ai/mcp.js`) are mocked, so the suite needs no API keys or network. The chat
route uses `reply.hijack()`, so integration tests `listen` on an ephemeral port and
read the SSE stream with `fetch` rather than `app.inject()`. The internet tools are
tested in `test/web-search.test.ts` with a stubbed global `fetch`.
