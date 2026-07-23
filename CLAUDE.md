# Project Guidelines

## Imports
- Always use `.js` extensions in relative TypeScript imports (e.g., `import { foo } from "../config.js"`). This is required by `moduleResolution: "NodeNext"` + ESM (`"type": "module"`).

## Commands
```bash
npm run dev    # tsx watch with --env-file=.env
npm run build  # tsc → dist/
npm run lint   # ESLint (flat config, 0 errors expected — enforced in CI)
npm test       # Vitest (test/) — no API keys or network needed
```
CI (`.github/workflows/ci.yml`) runs lint + test + build on every push to `main` and every PR.

## Testing
- Tests live in `test/` (outside tsconfig's `include: ["src"]`, so `npm run build` ignores them). Config in `vitest.config.ts`.
- The app is constructed via `buildApp(config, { logger: false })` from `src/app.ts` — never `src/index.ts` (it reads env and listens). Build the `Config` object directly with `test/helpers.ts` → `makeConfig()`.
- The LLM is mocked: `vi.mock` `src/ai/provider.js` so `createModel` returns `MockLanguageModelV3` from `ai/test` with `simulateReadableStream`-scripted chunks; mock `src/ai/mcp.js` (`getMCPTools`) the same way. To assert on what the model received (skill injection, canvasContext), capture the `doStream` arguments.
- The chat route uses `reply.hijack()` and pipes to `reply.raw`, so `app.inject()` does not return the stream — use `app.listen({ port: 0 })` + `fetch` and read the SSE body as text (terminated by `data: [DONE]`). See `test/chat-route.test.ts`.
- Client-executed tools must have **no** `execute` in `penTools`; `test/tools-contract.test.ts` pins this and the tool-name list — update it when adding a tool (its frontend twin `toolContract.test.ts` in pen-editor checks cross-repo sync).
- **Adding or removing a tool: land the schema here on `main` first, then the frontend handler, back-to-back.** This test is self-contained (the name list is hardcoded here) and this repo's CI never checks out pen-editor, so a schema change always lands green here. But pen-editor's `contract` job checks out *this* repo's `main` at run time and asserts every `penTools` entry has a handler — so between the two merges that job is red for every pen-editor push. Backend-first keeps the gap on the other side short and lets the handler's CI pass first try; handler-first fails that push outright.

## Trace analysis (`src/analysis/`, `src/tracing/`)

When `TRACE_DATABASE_URL` is set, the chat route fire-and-forget-writes raw session
traces to Postgres (`raw_traces`, TTL `TRACE_RAW_TTL_DAYS` days). `npm run analyze`
runs the Clio-style worker: applies `src/analysis/migrations/`, assembles sessions
(the longest `messages` history per session id — client-tool results/errors arrive
in later requests' histories), strips PII (regex + prompt rules + output validation),
summarizes each session with `ANALYSIS_MODEL` via `generateObject`, LLM-clusters all
summaries, writes `reports/YYYY-MM-DD.md` (gitignored) and stores everything in
`session_summaries`/`analysis_runs`/`clusters`. Only `raw_traces` ever holds
unsanitized content. Spec: `docs/superpowers/specs/2026-07-15-trace-analysis-design.md`.
`npm run analyze` (tsx over `src/`) is the dev/source path; after `npm run build`,
production installs without `tsx` as a dependency should use `npm run analyze:dist`
(`node dist/analysis/run.js`) instead — migrations resolve correctly either way
since `DEFAULT_MIGRATIONS_DIR` is `import.meta.url`-relative and the build step
copies `src/analysis/migrations/` into `dist/analysis/migrations/`.

A second pass (`src/analysis/insights.ts`) extracts per-session `session_insights`
— tool errors with recovery status, user corrections, memory requests, and the
agent's own claims — as input for prompt improvement. Unlike the Clio summarizer
it MAY quote the user verbatim (in `user_quote`/`quote` only); everything stored
still passes through `scrubPii`. It runs in its own loop, so it backfills sessions
summarized before it existed — but only while their `raw_traces` rows survive
`TRACE_RAW_TTL_DAYS`. The report gains a "Corrections & memory requests" section.
Spec: `docs/superpowers/specs/2026-07-17-session-insights-design.md`.

## MCP server (`src/mcp/`)

`/api/mcp` (streamable HTTP, `@modelcontextprotocol/sdk`) and `/api/mcp/ws`
(WebSocket, `@fastify/websocket`) expose a curated 10-tool MCP surface —
7 tools bridged live to a connected `pen-editor` browser tab
(`src/mcp/bridge.ts`, most-recently-active session wins, 30s timeout) plus
3 static tools executed directly on the server. Gated by `MCP_AUTH_TOKEN`
(unset = 503 on the whole `/api/mcp*` surface). See
`docs/superpowers/specs/2026-07-23-mcp-server-design.md` for the full design.

To connect Claude Code locally:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 24)   # add to .env, then restart `npm run dev`
claude mcp add --transport http pen-editor http://localhost:3001/api/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Then open the editor with `VITE_MCP_WS_TOKEN=$MCP_AUTH_TOKEN` set (see
`pen-editor/CLAUDE.md`) so a tab is connected for bridged tools to reach.

**`VITE_MCP_WS_TOKEN` is baked into the public JS bundle at build time —
local/dev builds only. Never set it on a publicly deployed frontend build:**
every visitor's tab would get the secret and silently register itself as a
bridge session that anyone holding the token can drive.
