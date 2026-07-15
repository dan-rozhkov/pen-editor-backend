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
