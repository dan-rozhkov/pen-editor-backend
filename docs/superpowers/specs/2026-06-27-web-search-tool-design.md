# Internet search tools for the design agent

**Date:** 2026-06-27
**Status:** Approved design
**Scope:** `pen-editor-backend` only — no frontend changes.

## Goal

Give the design agent the ability to search the public internet and read specific
web pages, so it can ground designs in real content, find references, copy, data,
and inspiration. Implemented as two **backend-executed** AI-SDK tools backed by the
[Tavily](https://tavily.com) search API.

## Why backend-executed (not `penTools`)

The repo runs a split-execution agent: most `penTools` have **no** `execute` and run
in the browser against the scene graph. Two contract tests pin this:

- `pen-editor-backend/test/tools-contract.test.ts` freezes the exact `penTools` name list.
- `pen-editor/src/lib/__tests__/toolContract.test.ts` asserts **every** name in `penTools`
  has a matching frontend handler.

Search tools have nothing to do with the scene graph and must run server-side (they hold
the API key and call an external HTTP API). Adding them to `penTools` would force frontend
handlers and edits to both contract tests. Instead they follow the **MCP/Refero pattern**:
a separate module whose tools are merged into the toolset in `chat.ts`, exactly like
`getMCPTools`. This keeps `penTools` frozen, both contract tests untouched, and zero
frontend changes.

## Architecture

### New module: `src/ai/web-search.ts`

Exports `getWebTools(config): Record<string, unknown>`.

- Returns `{}` when `config.TAVILY_API_KEY` is unset → the feature is fully optional,
  mirroring `getMCPTools` returning `{}` with no `REFERO_API_KEY`. The server boots and
  the agent works normally without it.
- When the key is present, returns two tools, **both with an `execute`** (backend-executed):

#### `web_search`

Calls Tavily `POST https://api.tavily.com/search`.

Input schema (zod):
- `query: string` (required) — the search query.
- `max_results?: number` — default `5`, clamp `1..10`.
- `topic?: "general" | "news"` — default `"general"`.
- `search_depth?: "basic" | "advanced"` — default `"basic"` (1 credit; `advanced` = 2).

Request body sent to Tavily: `{ api_key, query, max_results, topic, search_depth,
include_answer: true, include_raw_content: false, include_images: false }`.

Returns to the model:
```
{
  query,
  answer?: string,            // Tavily's synthesized answer, when present
  results: [{ title, url, content, score }]
}
```

#### `fetch_url`

Calls Tavily `POST https://api.tavily.com/extract` to read full page text.

Input schema (zod):
- `urls: string[]` (required, 1..5 urls) — pages to extract.
- `extract_depth?: "basic" | "advanced"` — default `"basic"`.

Returns to the model:
```
{
  results: [{ url, raw_content }],
  failed: [{ url, error }]      // urls Tavily could not extract
}
```

### Shared HTTP helper

A small internal `tavilyRequest(path, body, apiKey)` using global `fetch` (Node 18+,
already used in tests). On non-2xx or network error, the tool's `execute` returns
`{ error: "<message>" }` (a string-friendly object) rather than throwing — a failed
search must not abort the agent turn. Errors are `console.warn`-logged with a `[web]` prefix.

### Wiring: `src/routes/chat.ts`

```ts
const tools = isResearch
  ? (mcpTools as ToolSet)
  : { ...penTools, ...getWebTools(config), ...mcpTools };
```

Web tools join the **default** (edits/prototype) toolset. Research mode stays a
Refero-only swap (unchanged) — out of scope. If a key collision ever occurred,
`mcpTools` still wins by spread order; the names `web_search`/`fetch_url` don't collide
with any Refero tool.

### Config: `src/config.ts`

Add to `envSchema`, next to `REFERO_API_KEY`:
```ts
TAVILY_API_KEY: z.string().optional(),
```
No new required vars. Document in `.env.example` under the optional section, noting the
free tier is 1,000 credits/month (basic search = 1 credit).

### System prompt: `src/ai/system-prompt.ts`

Add a short note to `CORE_PROMPT` (and it naturally applies to edits/prototype) telling
the agent that `web_search` and `fetch_url` *may* be available for grounding designs in
real content/references, and to prefer `web_search` first, then `fetch_url` for a specific
page. Keep it brief; the AI SDK already passes tool descriptions to the model. The note
must read as conditional ("if available") since the tools are absent without a key.

## Error handling

- Missing/invalid key at call time → Tavily returns 401; `execute` returns
  `{ error }` so the model can report gracefully.
- Network/timeout → caught, returns `{ error }`.
- Partial extract failures → surfaced in the `failed` array, not thrown.
- The tools never throw out of `execute`, so a bad search never kills the turn.

## Testing

New `pen-editor-backend/test/web-search.test.ts` (Vitest), `fetch` stubbed via
`vi.stubGlobal("fetch", ...)` — **no network, no API key**:

1. `getWebTools({})` (no key) returns `{}`.
2. `getWebTools({ TAVILY_API_KEY: "x" })` returns exactly `web_search` and `fetch_url`,
   both with an `execute` function.
3. `web_search` input schema: defaults applied (`max_results: 5`, `search_depth: "basic"`),
   `max_results` clamped to `1..10`, missing `query` rejected.
4. `web_search.execute` maps a stubbed Tavily `/search` JSON into
   `{ query, answer, results: [{title,url,content,score}] }` and sends
   `include_answer: true` in the request body (assert on captured fetch args).
5. `fetch_url.execute` maps `/extract` JSON into `{ results, failed }`.
6. Non-2xx response and thrown fetch both yield `{ error }` without throwing.

Existing contract tests (`tools-contract.test.ts`, frontend `toolContract.test.ts`)
remain green and **unchanged** because `penTools` is not modified.

## Out of scope (YAGNI)

- Adding web tools to research mode.
- Image search / `include_images`.
- Caching search results.
- Any frontend UI for search.
- A provider abstraction over multiple search backends — Tavily only.
