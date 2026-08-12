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

## Persistent agent memory (`src/ai/memory/`, `src/ai/selfimprove/review.ts`)

Phase 1 of the self-improvement loop: per-user, cross-session facts injected
into every turn's system prompt. Gated by **`MEMORY_ENABLED`** (and, on top of
that, a per-request `userId` — absent for the showcase runner and any older
client, which is what keeps them memory-free with zero code changes). Needs
`TRACE_DATABASE_URL` (same Postgres as traces/showcase — no separate memory
DB var, deliberately, per the config convention elsewhere in this file).

`userId` is client-supplied and only shape-validated, never authenticated
(`src/lib/userId.ts`'s `isPlausibleUserId` — a canonical dashed UUID or the
32-char no-dash hex fallback `pen-editor/src/lib/userId.ts` produces on a
non-secure context). The chat route (`chatBodySchema`) still bounds it to
1..64 chars as a coarse sanity/DoS guard, but a shape-invalid value past that
is treated as ABSENT, not rejected — an older/malformed client silently falls
back to a memory-free turn rather than 400ing. `GET /api/memory/activity`
takes the opposite stance and 400s outright on a shape-invalid `userId`: that
route reads back a user's audit trail, so a low-entropy id colliding across
two different callers (e.g. both send `"test"`) is exactly the leak this
guards against, and a degraded-but-real 200 would be worse than an error.

Three tables (migration `009_agent_memory.sql`, index in `010_...idx.sql`):
- **`agent_memory`** — `(user_id, target)` → `entries jsonb` (a `string[]`).
  `target` is `'memory'` (the agent's own notes) or `'user'` (who the user
  is); each has its own char budget (`MEMORY_LIMITS` in `types.ts`) checked
  on the joined, separator-included string. The `memory` tool
  (`src/ai/memory/tool.ts`) applies `add`/`replace`/`remove` batches
  atomically (`apply.ts`); an exact-duplicate `add` (after trim) is a silent
  no-op, not a second copy.
- **`agent_review_state`** — per-user counters. `turns_since_memory` only
  increments on a request whose final step made **no** tool calls — i.e. a
  completed reply to the user, not one of the several `POST /api/chat`
  round-trips a single message can span via
  `lastAssistantMessageIsCompleteWithToolCalls` on the frontend.
  `steps_since_skill` (phase 2) is different on purpose: `maybeRunReview`
  calls `bumpCounters` on **every** request, mid-turn included, so it
  accumulates the full step count of each round-trip a message spans, not
  just the final one — only the DUE check (and the reset that comes with it)
  is deferred to the completed request. Bumping only on completion (as this
  used to) collapsed "every `SKILL_REVIEW_INTERVAL` tool-call steps" into
  "every ~`SKILL_REVIEW_INTERVAL` user turns," since the final request's own
  step count is normally 1. At `MEMORY_REVIEW_INTERVAL` (10) a background
  review turn runs, sees the `memory` tool plus stubs built from the turn's
  ACTUAL, FULL tool set (`prepareChatTurn`'s `tools` — every client-executed
  pen tool, `load_skill`, MCP tools, web tools; passed in as
  `MaybeRunReviewInput.turnTools`, not reconstructed from `penTools` alone)
  for whichever of those the shared system prompt might otherwise steer it
  toward (same trick as `src/showcase/runner.ts`'s tool emulation, so an
  off-script call resolves instead of throwing `NoSuchToolError` — this
  matters because the review reuses the FULL system prompt including its
  "call load_skill/MCP tools first" instructions, not a memory-only prompt),
  and re-reads the memory snapshot fresh into its own user message (never
  the cached system prompt) so it can't miss a fact a foreground call
  already saved this same turn. When a skill-only review runs with
  `MEMORY_ENABLED` off, `turnTools` never carries a real `memory` tool
  either (chat turns only add it when `memoryInjected`), so the review adds
  its own harmless stub for `memory` too — `SKILL_REVIEW_PROMPT`'s
  tool-restriction sentence is itself conditioned on whether memory is
  actually available this run (`buildSkillReviewPrompt`,
  `src/ai/skills/prompts.ts`), and the stub is the second line of defense
  if the model reaches for it anyway. The run also carries its own
  wall-clock cap (`AbortSignal.timeout`, 90s by default) since it is
  fire-and-forget from `onFinish` after the client has already disconnected
  — nobody can cancel a stuck provider call otherwise, and it would hold the
  full transcript (which can carry multi-MB base64 image parts) in memory
  indefinitely; a cancellation from that timeout is logged distinctly from
  an ordinary review failure.
- **`agent_selfimprove_audit`** — one row per write, `origin` ∈
  `foreground | background_review | curator`. Every mutation goes through
  `insertAuditRow` (used both stand-alone and inside `applyOperations`'s
  transaction) — there is no code path that changes memory without a row
  here.

**`GET /api/memory/activity?userId=...&sinceId=...`**
(`src/routes/memoryActivity.ts`) is a read-only UI-visibility signal for a
"memory updated" toast — never a 5xx for a disabled/missing backend, always
`{events: [], latestId: null}` in that case.

**`npm run memory:curate`** is the repair path (no route/UI touches memory
otherwise): `--list-users` discovers ids, `--user <id>` shows both targets,
`--user <id> --target <memory|user> --entry "<substring>" [--dry-run]`
removes one entry, `--user <id> --clear [--dry-run]` wipes both targets. Only
`TRACE_DATABASE_URL` is required (no S3), same shape as
`showcase:pin`/`showcase:delete` (`src/ai/memory/curator.ts` +
`curatorRun.ts`). Every deletion writes an `origin: "curator"` audit row.

## Self-authored skills (`src/ai/skills/`, phase 2 of the self-improvement loop)

With **`SELF_SKILLS_ENABLED=true`** and `TRACE_DATABASE_URL` set, the agent
maintains its own skill library in **`agent_skills`** (migration
`011_agent_skills.sql`) — global, not per-user: the agent serves one design
domain, so a procedure learned in one session is procedure for every
session. `agent_review_state.steps_since_skill` (created by phase 1, acted
on only from phase 2 onward) tracks cumulative tool-call steps; every
`MemoryStore.bumpCounters` call now also accepts an optional
`skillInterval`, and the review fires every **`SKILL_REVIEW_INTERVAL` (15)**
accumulated steps, counted independently of `MEMORY_REVIEW_INTERVAL`'s user
turns — a skill is learned from how much tool-calling a task took, not how
many chat messages it spanned. `agent_review_state` holds both counters in
one row per user, so `buildApp` (`src/app.ts`) constructs the shared
`MemoryStore` whenever **either** `MEMORY_ENABLED` or `SELF_SKILLS_ENABLED`
is on — the memory *feature* itself (snapshot injection, the `memory` tool)
still stays fully gated by `MEMORY_ENABLED` alone inside
`prepareChatTurn`/`maybeRunReview`.

Two turn-time, backend-executed tools (`src/ai/skills/tool.ts`,
`getSelfSkillTools`) — injected the same way `load_skill` is
(`getSkillTools()`), so neither is a `penTools` entry and neither touches
the cross-repo tool contract:
- **`skill_manage`** (create/patch/delete) — offered on every normal turn
  when the flag is on and a store is wired (`prepareChatTurn`,
  `src/ai/chatTurn.ts`).
- **`skill_view`** (read-only) — offered **only** to the background review
  run (`maybeRunReview`); a normal design turn reads a skill via
  `load_skill`, which already satisfies `skill_manage`'s read-before-write
  guard.

Guards (`src/ai/skills/validate.ts` + `tool.ts`): curated `src/skills/*.md`
files are read-only to the tool — the error names the git-owned path. A
learned skill's `name` may not collide with a curated skill or a `penTools`
name **at create time** (`checkNameCollision`); that check can't see a
curated file added *later* under a name an existing learned row already
uses, so the curated-name guard runs again at patch/delete time — but only
blocks `patch` there. `delete` is deliberately exempt: it only removes the
now-dead Postgres row (never the git-owned file), which is exactly the
cleanup a later-arriving collision calls for, and `getLearnedCatalog`
already stops rendering the shadowed row (curated always wins a name tie —
see the catalog paragraph below) so nothing but the DB row is stale. `patch`
requires the exact skill to have been read via `load_skill`/`skill_view`
**within the same run** — tracked by a per-run in-memory `SkillRunContext`
(`src/ai/skills/runContext.ts`), fresh per HTTP request in `chatTurn.ts` and
fresh per background-review run in `review.ts` (never shared between them);
`delete` requires the same read plus `absorbed_into: string` (empty string =
pruning), and reports an error rather than false success if `store.remove`
turns out to have deleted nothing (a concurrent delete between the read and
this call — mirrors `replaceBody`'s own "no longer exists" guard). A
provenance guard restricts `patch`/`delete` to rows with `created_by =
'agent'`, so a hand-seeded or human-edited row in `agent_skills` is immune
to the autonomous reviewer; `skill_view`'s `editable` field reports the same
thing (`created_by === 'agent'`), not just "is this a learned row," so the
model isn't told it can write something `skill_manage` will actually refuse.
Every store call in `skill_manage` (`get`/`create`/`replaceBody`/`remove`/
`listActive`) is wrapped so a thrown Postgres error becomes a model-facing
string instead of an uncaught tool error mid design-turn — matching
`load_skill`/`skill_view`, which already did this; `create`'s race against
its own pre-check (no `ON CONFLICT`, deliberately — see `learnedStore.ts`)
is translated from a raw unique-violation into the same "already exists, use
patch" guidance the pre-check itself gives. `applyPatch`
(`src/ai/skills/validate.ts`) requires `old_string` to occur exactly once,
including **overlapping** occurrences (`body.indexOf(oldString, first + 1)`,
not `first + oldString.length` — the latter walks past a second match that
starts inside the first, e.g. `"aaa"` / `"aa"`). Every write lands in
`agent_selfimprove_audit` (`subsystem: "skill"`), through the same
`insertAuditRow` memory uses — skill_manage/skill_view take a raw
`TraceQueryable` (`src/ai/selfimprove/auditDb.ts`, its own small shared pool,
mirroring `getSharedLearnedSkillStore`, `connectionTimeoutMillis: 5_000`
like the neighboring hot-path pools since `skill_manage`'s audit write sits
inside a turn's `execute`) rather than `MemoryStore.writeAudit`, since
`agent_skills` is keyed by `name` alone and has no `MemoryStore` equivalent
for a table shaped like that. Both `getSharedLearnedSkillStore` and
`getSharedAuditDb` close the pool they're replacing on a URL change (only
ever seen in tests/multi-config processes — production never changes
`TRACE_DATABASE_URL` mid-process) rather than dropping it unclosed, and
`LearnedSkillStore.close()`/the raw `TraceQueryable.end()` are both wired to
`buildApp`'s `onClose` hook (`src/app.ts`), the same contract
`traceStore`/`memoryStore`/`showcaseStore` already had.

`prepareChatTurn` merges `agent_skills`' active rows into the system
prompt's skills catalog (`src/ai/system-prompt.ts`) marked **`(learned)`**,
with a short legend sentence shown only when at least one is present — a
fresh install with an empty table renders byte-identical to pre-phase-2. A
learned row whose name collides with a curated skill (see the guards
paragraph above) is filtered out of the catalog entirely — curated always
wins the tie, `load_skill` would resolve there anyway, so showing the
learned duplicate too would just be a dead, confusing second line — and the
merged list is capped at `MAX_LEARNED_SKILLS_IN_PROMPT` (50, `chatTurn.ts`)
with a `console.warn` on either the shadow-filter or the cap actually
truncating something, so a silent drop never reads as "everything loaded."
`load_skill` resolves a learned skill exactly like a curated one and bumps
its `use_count`/`last_used_at`. The catalog read
(`getLearnedCatalog`/`LearnedSkillStore`, `src/ai/skills/learnedStore.ts`)
caches **per store instance** (keyed by object identity, not one shared
global slot — a multi-store process, e.g. tests or two differently
configured server instances, would otherwise let `getLearnedCatalog(storeA)`
return rows actually read through `storeB`) for 30s and, like the memory
snapshot read, is raced against a 2s timeout in `chatTurn.ts` so a
slow/unreachable Postgres degrades to "no learned skills this turn" instead
of hanging `/api/chat`. Learned skills are **NOT slash-invocable** — `/name`
stays curated-only.

The background review's skill/combined prompts live in
`src/ai/skills/prompts.ts` (`SKILL_REVIEW_PROMPT`, `buildSkillReviewPrompt`,
`buildCombinedReviewPrompt`, `selectReviewPrompt`) — ported verbatim from
Hermes, including the do-not-capture list (environment-dependent failures,
negative claims about tools, transient errors that resolved, one-off task
narratives, unresolved failures) and the preference ladder biased against
creating new skills (patch a skill loaded this session > patch any existing
skill that covers the class > create new, and only as a last resort). The
review's tool whitelist is keyed off which subsystems are **enabled**, not
which one is **due** — a skill-triggered review still gets the `memory` tool
if `MEMORY_ENABLED` is on, and vice versa. The prompt's trailing
tool-restriction sentence is generated by `buildSkillReviewPrompt(memoryAvailable)`
rather than hardcoded, and `memoryAvailable` is `config.MEMORY_ENABLED` — a
`SELF_SKILLS_ENABLED`-only deployment (a supported shape) gets "you can only
call skill management tools," not a false claim that memory is callable
too. `maybeRunReview` also registers a schema-accurate `memory` stub in that
same shape (mirroring the pen-tool stubs `buildReviewToolStubs` builds from
`turnTools`, which never carries a real `memory` entry when
`MEMORY_ENABLED` is off) so a model that reaches for it anyway — a stale
prompt fragment, an inattentive read — gets a harmless result instead of a
hard `NoSuchToolError` that aborts the whole review after the counter's
already been bumped.

### Deterministic skills curator (`src/ai/selfimprove/curate.ts`, phase 3)

**`npm run skills:curate`** ages `agent_skills` rows so the catalog above
doesn't grow forever: `active` unused ≥30 days (and created ≥30 days ago) →
`stale`; `stale` unused ≥90 days total → `archived`. There is no LLM anywhere
in this path — it is pure date arithmetic in TS against an injected clock
(`daysUnused`/`classifySkills` in `curate.ts`), not SQL `now()`, which is what
makes the thresholds unit-testable without freezing the database clock.
`use_count`/`view_count` never affect the outcome; recency is the only
signal. An `archived` row is never `DELETE`d — the curator's only write to
`agent_skills` is `UPDATE ... SET state, updated_at`.

**`stale` is a real grace period, not a second name for doomed.** It falls
out of the catalog exactly like `archived` does (`learnedStore.listActive()`
filters `state = 'active'`), but unlike `archived` it stays resolvable
through `load_skill` (`src/ai/skills.ts`): a successful load on a `stale`
skill revives it straight back to `active` and refreshes `last_used_at` in
the same `bumpUse` write (`learnedStore.ts`). So the only way a skill
survives being marked `stale` in error, or genuinely earns its way back, is
to actually be loaded again before the next curator run — there is no
separate undo command, being used again *is* the undo. `archived` has no
such path from `load_skill` or the curator itself (still out of scope, see
below) — the one place archival is reversible at all is `skill_manage`'s
`create` action: because `name` is a primary key and archived rows are never
deleted, `create`-ing at an already-archived, agent-owned name revives that
row (overwrites description/body, resets `state` to `active`) instead of
dead-ending in "already exists, use patch" forever — `patch` alone can never
change `state`, so without this a mistakenly (or correctly) archived name
would be permanently unrecoverable under its own name. See `reviveArchived`
in `learnedStore.ts` and the `create` branch of `skill_manage` in
`src/ai/skills/tool.ts`. `test/selfimprove-curate-pglite.test.ts` pins that
`archived` (not `stale`) is what actually disappears from the catalog and
`load_skill`.

The CLI is **read-only by default** — inverted from the usual convention on
purpose, since a curator that mutates by accident is worse than one that
does nothing. `--apply` is required to write anything, to either table;
`--dry-run` is accepted as an explicit spelling of the (already default)
no-op, and a dry run skips `BEGIN`/`SELECT ... FOR UPDATE` entirely rather
than opening a transaction it never intends to commit — a `--apply`-less run
against production must not stall every concurrent `bumpUse`/`bumpView`/
`replaceBody` for the duration of a read that was always going to write
nothing. Before the first `UPDATE` of an `--apply` run, the *entire*
`agent_skills` table is inserted into `agent_selfimprove_audit` as one row
(`origin: 'curator', subsystem: 'skill', action: 'snapshot'`, `user_id:
'system'` — skills are global, not per-user, so there is no real user to
attribute the row to) inside the same transaction as the updates that
follow it, all under one `SELECT ... FOR UPDATE`'d snapshot read — a skill
takes at most one state transition per run, so archiving is always preceded
by at least one run's worth of stale grace, and every printed report line
is exactly one state change. Each `UPDATE` is additionally guarded by the
row's state and `last_used_at` *as read in this run's own snapshot*
(`... WHERE state = $fromState AND last_used_at IS NOT DISTINCT FROM
$snapshotValue`) — redundant under real Postgres locking (a concurrent
writer blocks on the `FOR UPDATE` row lock until this transaction commits or
rolls back) but cheap insurance against ever silently applying a transition
computed from a view of the row that had already moved on; a transition the
guard skips is dropped from the returned/reported list rather than claimed.
A run that changes nothing still prints an explicit `0 transitions` line
(`formatCurateReport`): a curator that succeeds silently is indistinguishable
from one that's broken. Same env-only wiring as `memory:curate` — only
`TRACE_DATABASE_URL` is required, no S3, no LLM — and
`src/ai/selfimprove/curateRun.ts` is a thin `runAsScript`-guarded entrypoint
over the tested logic in `curate.ts`, same shape as
`src/ai/memory/curatorRun.ts`. There is no `--user` scoping (unlike
`memory:curate`) because learned skills aren't per-user to begin with.

Pinning a skill against ageing, LLM-driven consolidation, and a general
`unarchive`/restore command are still explicitly out of scope for this
phase — the one narrow exception is `skill_manage`'s `create`-revives-an-
archived-row path above, which exists to unblock a stuck name rather than as
a general restore tool. See
the phase-3 plan's Deferred section if any of those become necessary; none
of them should be improvised into `curate.ts`.

## MCP server (`src/mcp/`)

`/api/mcp` (streamable HTTP, `@modelcontextprotocol/sdk`) and `/api/mcp/ws`
(WebSocket, `@fastify/websocket`) expose a curated 10-tool MCP surface —
7 tools bridged live to a connected `pen-editor` browser tab
(`src/mcp/bridge.ts`, most-recently-active session wins, 30s timeout) plus
3 static tools executed directly on the server. Gated by `MCP_AUTH_TOKEN`.
See `docs/superpowers/specs/2026-07-23-mcp-server-design.md` for the full
design.

**`MCP_AUTH_TOKEN` unset behavior depends on the environment**
(`src/mcp/autoToken.ts`):
- **Non-production** (`NODE_ENV !== "production"` — the default for `npm run
  dev`/tests): **auto-token mode.** The server generates a per-process
  token (or reuses one already sitting in the handshake file below, if it
  matches this instance's configured port — a routine `tsx watch` restart
  doesn't rotate the token out from under an already-connected editor tab),
  restricts every `/api/mcp*` request/upgrade to loopback callers only
  (`isLoopbackAddress`; a non-loopback caller gets `403`, not the ordinary
  `401`), and publishes `{url, token, port}` to `~/.pen-editor/mcp.json`
  (dir mode `0700`, file mode `0600`) so `pen-editor` and
  `pen-editor-plugin` can connect with zero manual token wiring. Only the
  long-running `npm run dev`/`npm start` process (`src/index.ts`) does this
  publish/reuse/cleanup — `buildApp()` calls elsewhere (the test suite, ad
  hoc scripts) leave the handshake file alone by default
  (`BuildAppOptions.publishHandshake`, `src/app.ts`).
- **Production** (`NODE_ENV === "production"`): the whole `/api/mcp*`
  surface returns `503`, exactly as before auto-token mode existed. The
  loopback check above is not treated as a safe substitute in production —
  it doesn't hold behind a same-host reverse proxy (nginx/caddy)
  terminating on `127.0.0.1`, where every internet request would otherwise
  look like loopback.

To connect Claude Code locally, either read the auto-published token out of
`~/.pen-editor/mcp.json` (`npm run dev` writes it on startup) or set an
explicit token yourself:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 24)   # add to .env, then restart `npm run dev`
claude mcp add --transport http pen-editor http://localhost:3001/api/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

With an explicit `MCP_AUTH_TOKEN`, also open the editor with
`VITE_MCP_WS_TOKEN=$MCP_AUTH_TOKEN` set (see `pen-editor/CLAUDE.md`) so a tab
is connected for bridged tools to reach — in auto-token mode `pen-editor`'s
vite dev server reads the handshake file itself and this is unnecessary.

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

`--dry-run=<dir>` runs that same real generation — same theme pick, same
palette avoidance, same `/prototype` turn — but publishes nothing: it skips
the screen upload and the `showcase_screens` insert, writing each screen's
HTML and PNG plus a `_sheet.png` contact sheet into `<dir>` instead, so
nothing reaches the gallery. It is not a cheaper stand-in for a real run,
though — it's the same turn, and if that turn calls `generate_image`, those
images are uploaded to the production bucket exactly as they would be on a
normal run (up to `MAX_GENERATED_IMAGES`, see `runner.ts`). That upload is
also why the four `S3_*` vars are still required even though the screen
itself is never published: without them `generateImage` falls back to
inlining a data URL, and a dry run that skipped real image generation would
stop being the run that would have shipped. The cost is honest orphans —
those objects are referenced by nothing in Postgres, so no `showcase:delete`
or rescreenshot sweep will ever reach them; they just sit in the bucket. The
screens are judged through the same `renderAndDiagnose`/`describeReport` pass
from `previewScreens.ts` that `showcase:preview` uses, so a dry run and a
hand-authored preview can never disagree about what counts as a defect. Note
one gap between the directory and what would have shipped: the dry run writes
the model's *raw* HTML to `<stem>.html`, but the PNG is rendered from
`normalizeShowcaseHtml`'s output and `publish.ts` stores that normalized
string — so a dry-run directory is not byte-identical to what would have
published, only what would have rendered.

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
published. `npm run showcase:preview -- screens/*.html` renders hand-authored
screens through the real pipeline *before* publishing — one Chromium for the
whole list, each PNG written next to its `.html`, `normalizeShowcaseHtml`
applied exactly as `publish.ts` applies it, and a non-zero exit if any screen
is not the viewport's size ×2. It is the supported preview path: writing a
throwaway harness into `src/` instead launches a browser per screen and skips
that normalization, so the preview and the published screen can differ. Needs
neither Postgres nor S3. Two more helpers complete the loop without a browser
or a server:
`npm run showcase:theme` prints one theme (skipping the last 10 used), and
`npm run showcase:image -- "prompt"` runs the real `generateImage` and prints
`url<TAB>prompt`. Record the author in `model` (e.g. `claude-opus-5
(hand-authored)`) so these runs stay distinguishable in `showcase_screens`.

Env/Postgres/S3 wiring for all four entrypoints lives in
`src/showcase/context.ts`, and the "run me only as a script" tail in
`src/showcase/cli.ts`. `probes/showcase-mobile.md` holds the checkable
expectations the `/improve-design-agent` loop judges a run against; every new
defect is added there so the next loop re-checks it.

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
