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

## Showcase generation (`src/showcase/`)

`npm run showcase:generate` runs the design agent autonomously, with no browser
and no HTTP request: it picks a random theme from `themes.ts` (skipping the last
10 used, via `store.recentThemes`), runs one `/prototype` turn, harvests up to 5
`embed` screens out of the agent's `batch_design` calls, screenshots each with
Playwright Chromium, uploads the PNG **and** the raw HTML to S3, and inserts a
row per screen into `showcase_screens`. The frontend reads them back through
`GET /api/showcase` (`src/routes/showcase.ts`) and renders a grid of app cards at
`/`. Needs `TRACE_DATABASE_URL` (same Postgres as traces — deliberately no
second env var, since a second URL pointing elsewhere would silently split the
schema) plus all four `S3_*` vars, and a one-time
`npx playwright install chromium`. Spec: FIR-61.

Two rotations keep the gallery from repeating itself. Themes: `store.recentThemes(10)`
+ `pickTheme`. **Palette:** `store.recentRunHtmlUrls(6)` → `src/showcase/palette.ts`
extracts each recent run's accent straight out of its published HTML (most-frequent
saturated hex, mapped to one of 8 coarse hue families) and `buildShowcasePrompt` asks
for a different family. Reading the HTML back beats storing the accent at publish time:
no migration, no column that can drift, and it works on every run already published.
It exists because six consecutive `deepseek-v4-pro` runs shipped a warm ground + a
terracotta/amber accent — the model's prior for "calm, caring, human". The prototype
skill's Calibration section now names that axis explicitly, but a skill rule can only
make one design self-aware; it cannot see the gallery. Both halves are needed. The hint
is best-effort: `recentAccentFamilies` swallows fetch failures, and an empty list drops
the clause rather than sending "avoid: nothing".

The feed paginates by **app**, not by screen: `limit` counts apps (default
12, max 24), the response is `{apps: [{runId, theme, model, createdAt,
screens}], nextCursor}`, and cursors are app-addressing (`a1|run_sort|run_id`
— every older, screen-addressing format is treated as legacy and restarts the
feed). `store.listApps` picks `limit` runs by recency in a subselect and then
takes *every* screen of those runs, which is what keeps a page from cutting an
app in half — the gallery renders one card per app, so a screen-counted page
made a carousel silently grow when the visitor clicked "Show more".

One screen **per app** can be **pinned** as that app's cover, so it opens the
app's carousel regardless of when it was created (`pinned_at` on
`showcase_screens`, migrations `004_showcase_pin.sql` +
`005_showcase_pin_per_run.sql`; exclusive *within a `run_id`* — a partial
unique index enforces at most one pin per app, and pinning in one app never
touches another's). The feed orders apps by recency (`MAX(created_at)` per
run) and screens within an app pinned-first — there is deliberately no way to
promote an app to the front of the feed. `GET /api/showcase` doesn't expose
`pinned`; the row order alone is enough, and the client's `groupScreensByApp`
preserves it. Set it at publish time — `cover: true` on a screen in the
`showcase:ingest` manifest, or `--cover=<n>` (1-based screen index, overrides
the manifest) on either `showcase:ingest` or `showcase:generate` — or after the
fact with `npm run showcase:pin -- --screen <uuid>` (`--clear` unpins every
app, `--clear --run <uuid>` just one, `--list` prints recent screens grouped by
app with their ids so you have something to pass to `--screen`). `src/showcase/pin.ts` holds the parsing/dispatch, `pinRun.ts` is
the thin entrypoint, same split as every other showcase script. It is the one
showcase script that needs **only** `TRACE_DATABASE_URL` — it opens the shared
context with `{ requireS3: false }`, since pinning touches no image and no
HTML, and demanding four S3 vars to flip a boolean is how a repair command
becomes unrunnable exactly when you need it.

`npm run showcase:delete -- --app <run-id|screen-id>` removes a published run
from the gallery — `--app` takes either a `run_id` or *any* screen id in it
(the id you can copy from the gallery is a screen's), `--screen <uuid>` drops
one screen instead, and `--dry-run` prints what would go through the exact
same id resolution. `src/showcase/delete.ts` + `deleteRun.ts`, `{ requireS3:
false }` like pin. It deletes **rows only**: the S3 objects stay, because they
are served `immutable` for a year and cost nothing to keep, whereas deleting
them would make a mis-aimed `--app` unrecoverable — the row can be re-inserted
from the surviving objects, the objects cannot be re-derived from a deleted
row.

Migrations now also run at server startup (`src/startupMigrations.ts`, called
from `index.ts` when `TRACE_DATABASE_URL` is set; failures are logged, not
fatal, since the rest of the API works without Postgres). Before that, only
`npm run analyze` and the showcase CLIs applied them — so the moment a route
started selecting a migration-added column (`pinned_at`), a deploy would have
500'd the whole gallery until someone ran a CLI by hand.

Every screen's HTML goes through `normalizeShowcaseHtml`
(`src/showcase/normalizeHtml.ts`) before it is screenshotted **and** stored —
one string feeds both, because the gallery lightbox iframes the stored HTML.
It injects a UA reset for form controls inside a `@layer`, so it can only fill
in where the design said nothing (unlayered author rules beat layered ones at
any specificity). Without it a `<button>` the design didn't style renders with
Chromium's `border: 2px outset` and an Arial label — how a recipe app's sage
CTA shipped with a system bevel (screen `260e0d07`). `rescreenshot` applies the
same pass to already-published screens and repoints `html_url` when the markup
changes, which is what makes one sweep repair the gallery's back catalogue.
The prototype/slides skills ask for the same reset in generated CSS; both
halves are needed, since a skill rule can't bind a model.

`npm run showcase:rescreenshot` re-renders the PNG of every stored screen from
its stored HTML (`src/showcase/rescreenshot.ts`, driven by the
`rescreenshotRun.ts` entrypoint) — the repair path after a
screenshot-pipeline fix, since the HTML, not the image, is the source of truth.
Only screens whose dimensions change are re-uploaded (`--force` overrides), each
to a *fresh* S3 key so caches can't keep serving the old PNG; `--dry-run` and
`--limit=N` are available. Same env as generation, minus the LLM.

### Hand-authored runs (the agent in this session, not an OpenRouter model)

`npm run showcase:ingest -- --manifest run.json` publishes screens written by
hand — or by Claude Code following `src/skills/prototype.md` itself — through
the *same* screenshot → S3 → Postgres path as `showcase:generate`
(`src/showcase/publish.ts`, shared by both entrypoints; `ingest.ts` holds the
manifest parsing). The manifest is
`{theme, prompt?, model?, screens: [{name, file | htmlContent}]}`; `file` paths
resolve relative to the manifest, and screens should be authored as separate
`.html` files rather than JSON-escaped strings. `--dry-run` lists what would be
published. Two helpers complete the loop without a browser or a server:
`npm run showcase:theme` prints one theme (skipping the last 10 used), and
`npm run showcase:image -- "prompt"` runs the real `generateImage` and prints
`url<TAB>prompt`. Record the author in `model` (e.g. `claude-opus-5
(hand-authored)`) so these runs stay distinguishable in `showcase_screens`.

Env/Postgres/S3 wiring for all four entrypoints lives in
`src/showcase/context.ts`, and the "run me only as a script" tail in
`src/showcase/cli.ts`.

**Gotcha, twice burned: no named inner functions inside `page.evaluate`.** The
bundler emits a `__name` helper that does not exist in the page, so the whole
evaluate rejects — and `screenshotHtml`'s render-ready wait used to swallow
that silently, degrading every screen of a run to fallback fonts and blank
icons with no trace. It now logs a warning when that wait fails, and waits for
`@import`ed stylesheets to land before reading computed styles (until they do,
`.ph::before` has no content, so no icon font is ever requested).

**The turn is assembled by `prepareChatTurn` (`src/ai/chatTurn.ts`), shared with
the `/api/chat` route — never hand-roll the system prompt or tool set here.** A
second prompt builder is how the showcase would start advertising an agent that
no longer matches the one users get. The runner's only local additions are
`execute` implementations: `batch_design` collects embed HTML in memory, and
every other client-executed tool gets a stub that reports itself unavailable
(without one, the first `get_screenshot` call stalls the whole run, since
client-executed tools have no `execute` by design).
