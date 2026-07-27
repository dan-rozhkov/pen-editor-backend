# Changelog

All notable changes to **pen-editor-backend** (AI design-agent server) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [0.30.0] - 2026-07-28

### Added
- **Autonomous showcase generation** (`npm run showcase:generate`) — runs the design agent with no browser and no HTTP request: picks a theme, runs one `/prototype` turn through the shared `prepareChatTurn`, harvests up to 5 embed screens out of `batch_design`, screenshots each with Playwright, uploads PNG + raw HTML to S3 and stores a row per screen. `GET /api/showcase` serves them back to the gallery at the frontend's `/`.
- **Real imagery in the big picture slots** — the run gets a `generate_image` implementation (capped at 8 per run, failures and budget exhaustion degrade to a picsum placeholder rather than an error), so hero shots and posters are generated art instead of stock placeholders.
- **`--theme` and `--model` flags** for one-off runs (`npm run showcase:generate -- --theme="билеты в кино" --model=moonshotai/kimi-k2.5`). Without them the behaviour is unchanged: a random theme not used in the last 10 runs, and the default showcase model.

### Fixed
- **Image URLs the model mistyped are repaired before the screenshot.** A run came back with two broken `<img>` tags whose objects were in S3 and public — the model had transcribed their UUIDs one character wrong (`…af50a7f4` → `…af70a7f4`, a 403). URLs under our own upload directory are now snapped to the nearest URL `generate_image` actually issued; foreign hosts are untouched, and a URL too far from anything issued is logged instead of being pointed at an unrelated image.
- **The showcase agent was running without any of its skills** — `loadSkills` only ran from `index.ts`, so the generator silently produced weaker work. Loading is now guaranteed by `prepareChatTurn`.
- **A slow image no longer takes down the run** — `setContent` waited on every remote asset and threw on timeout; asset readiness is now a bounded wait that degrades to "screenshot anyway".
- **Bottom bars no longer cover the last row of content** — the screen grows by exactly the overlap instead of the design being cropped.
- Screenshots crop to the design rather than the viewport, so the gallery has no empty margins.
- **Tab bars are no longer cut in half.** A screen-level bar hangs off the viewport, not the `<body>` box, so with a body shorter than the showcase viewport the body-element screenshot sliced the bar's last rows off. The body is now extended down to the lowest pinned element before the shot.

### Changed
- Coverage config excludes `src/showcase/run.ts` (script entrypoint, like `analysis/run.ts`) and `src/showcase/screenshot.ts` (tested only against a real Chromium, which CI does not install). Thresholds ratcheted **up** to 89/80/89/90.

## [0.29.0] - 2026-07-27

### Changed
- **An oversized `batch_design` call no longer fails — it partially executes.** The schema used to reject any batch over the 25-operation cap with `InvalidToolInputError` before it ever reached the browser, throwing away the whole generated payload. In agent traces this was the #1 tool error (15 occurrences, 3 of them unrecovered — the session died outright), and the most expensive one, since the model had to regenerate everything. Oversized batches now pass validation and reach the client, which runs the first 25 operations and returns a resumption point. The tool description and system prompt spell out the new contract: going over is no longer fatal, but the follow-up call must carry **only** the skipped operations and must swap binding references for the real node ids from the result's `bindings` field, since bindings don't survive across calls. Staying under 25 is still the recommendation — it saves a round-trip.
- `splitBatchDesignStatements` now runs only for the embed-only guard, its sole remaining consumer, instead of on every `batch_design` call.

### Added
- **`export_layers_svg` schema** — lets the agent export selected layers as an SVG data URI to drop into embed HTML, instead of reconstructing complex vector paths by hand (which produced distorted logos). Frontend half ships in pen-editor 0.68.0.

## [0.28.0] - 2026-07-24

### Changed
- **Design-agent skills upgraded from Impeccable v3.9.1 to v4.0.1.** The 20 command skills (`polish`, `critique`, `bolder`, `typeset`, …) were re-ported to v4's leaner bodies, each carrying a self-contained quality-floor tail. The new v4 **craft-floor** (Verify / Refuse / Calibration) is folded into the shared `frontend-design` hub.
- **Register model replaced by v4's four visitor modes** — `Persuade` / `Operate` / `Read` / `Experience`, chosen from the requested surface. The `brand` and `product` register skills are retired; the create-new brief now gathers the visitor mode instead of "brand constraints".
- **Prototyping now applies the v4 quality bar automatically.** The auto-loaded `prototype` skill inlines the full craft-floor plus a "commit the world first" (visual-world + direction contract) and prove-don't-claim step, so every create-new run is held to the v4 bar without an explicit `/`-command. `slides` references the same floor.

### Added
- New v4 playbooks as skills: **`new-work`** (pick a committed visual world + write a direction contract; upstream's dice/CLI machinery stripped for our static-injection model), **`operate`** (deeper Operate/Read guidance), and **`visualize`** (optional pre-build compositional options, non-blocking).

### Removed
- `brand` and `product` register skills (superseded by the four visitor modes). `craft` is now a thin deprecated alias for the prototype/new-work flow.

## [0.27.4] - 2026-07-23

### Changed
- **Prototype linking now recognizes a header avatar / profile photo** (an `avatar`/`profile`/`account` element, often a text-less image) as navigation to a profile, account, or settings screen when one exists. Pairs with pen-editor extracting those elements as candidates.

## [0.27.3] - 2026-07-23

### Changed
- **Prototype linking now wires light/dark theme switching.** When the screens come in light/dark pairs (same screen twice, names differing only by a `Dark`/`Light`/`Night`/`Day` marker, e.g. `Settings` and `Settings Dark`) and a screen has a theme / dark-mode / appearance control (a toggle or an element labeled "Dark mode"/"Theme", often with a moon/sun icon), the link-graph prompt now instructs the model to link that control to the same screen's opposite-theme variant — but only when that variant actually exists. Previously the prompt told the model to unconditionally skip theme switches.

## [0.27.2] - 2026-07-23

### Fixed
- **Prototype linking still produced nothing on real app screens** (e.g. a plant card → detail flow). Root cause was upstream of the model: the frontend only extracted semantic clickables (`<a>`/`<button>`/`role`), but real design embeds mark navigational cards, tabs, and list rows as styled `<div>`s, so those screens yielded zero candidates and there was nothing to link. The link-graph prompt now also surfaces each candidate's `class` names (`<tag.class...>`) — a strong intent signal when text is icon-only or generic — and gained guidance for item cards/tiles → detail screens and tab-bar entries → their section. The route accepts an optional `classHint` per candidate.

## [0.27.1] - 2026-07-23

### Fixed
- **Prototype linking returned an empty graph** (nothing linked). The LLM was fed only terse one-line clickable summaries and keyed screens by opaque ids it echoed unreliably. Now each screen carries an optional visible-text `content` excerpt, the prompt is directive (wire every plausible navigation; prefer linking over leaving unlinked; screen ids are short slugs to echo exactly), and target resolution salvages a `targetScreenId` returned as a screen name or wrong case instead of silently dropping the link.

## [0.27.0] - 2026-07-23

### Added
- **`POST /api/prototype-link`** — LLM link-graph generator for clickable prototypes (PROTO-01). Takes compact clickable-element summaries per screen (`{ screens: [{ id, name, candidates }] }`) and returns a validated navigation graph (`{ links: [{ screenId, protoId, targetScreenId }] }`). Reasons over element labels + screen names only (cheap on tokens; never the full HTML), defensively filters links to known screens/real candidates and drops self-links. Plain-JSON route (no stream hijack); the frontend extracts candidates, applies the graph, and packages the zip.

## [0.26.0] - 2026-07-23

### Added
- **MCP server** (`/api/mcp`, streamable HTTP + `/api/mcp/ws` WebSocket): external MCP clients (Claude Code, claude.ai, Cursor) can read and edit the live editor document. Curated 10-tool surface — 7 tools bridged to a connected pen-editor tab (`get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables`) + 3 static (`get_guidelines`, `get_style_guide_tags`, `get_style_guide`). Gated by `MCP_AUTH_TOKEN` (unset → 503), constant-time token compare, per-request `McpServer` (stateless), most-recently-active tab routing, 30s bridged-call timeout, WS keepalive ping, token redaction in request logs.
- `get_screenshot` results are returned as MCP image content (base64 PNG).

### Changed
- `src/ai/tools.ts` now exports its raw zod shapes and static-tool implementations for reuse by the MCP server (no behavior change).
- CORS: `DELETE` method and `Authorization`/`Mcp-Session-Id` headers allowed.

## [Unreleased]

## [0.25.0] - 2026-07-23

### Added
- **`ask_user` — the agent asks clarifying questions as an in-chat form.** New client-executed tool `ask_user` whose schema describes a list of questions (single/multi chips, select, text), each with optional "Decide for me" (delegates the choice back to the agent, value `"__auto__"`) and "Other…" free-text. Questions require options for choice types and unique ids. The agent's turn pauses until the user submits; answers come back as the tool result. Pairs with frontend 0.63.0.
- **Mandatory "ask before creating" rule.** `CORE_PROMPT`, the `prototype` skill, and the `slides` skill now instruct the agent to call `ask_user` **first** — before `get_editor_state`/`batch_design` — whenever it is creating something new on the canvas (screen, page, mockup, deck), to gather the brief (audience, platform/size, tone, scope, brand constraints). Plain edits of existing nodes are unaffected.

## [0.24.0] - 2026-07-21

### Changed
- **`/plugin` skill: expanded UI-kit catalog (pairs with frontend 0.59.0).** The
  skill now documents the full set of `.pen-*` primitives a plugin can use —
  adding `badge`, `card`, `separator`, `slider`, `tabs`/`tab`, `alert`, `table`,
  `field`, `help`, `icon-button`, `button-group`, `input-group`, `heading`,
  `muted`, `kbd` and `link` on top of the original controls — so the design
  agent has an editor-matching, live-theming analog for every app UI element
  that renders faithfully in a sandboxed static plugin iframe. A new example
  demonstrates a card + labelled field. The catalog stays machine-checkable and
  is guarded by the frontend's cross-repo contract test.

## [0.23.2] - 2026-07-21

### Changed
- **`/plugin` skill: UI-kit class catalog (pairs with frontend 0.57.0).** The
  skill now documents the `.pen-*` primitive classes baked into every plugin
  iframe (button/input/textarea/select/label/checkbox/row/stack) with the rule
  to use them instead of hand-rolled CSS; the Counter example is rewritten on
  them. The catalog section is machine-checkable and guarded by the frontend's
  cross-repo contract test.

## [0.23.1] - 2026-07-21

### Changed
- **`/plugin` skill updated for live UI panels (pairs with frontend 0.56.0).**
  Removed the "headless-only" limitation notes: the skill now documents the
  floating panel (initial size from `ui`, `pen.ui.resize` clamping, close =
  teardown), the injected theme CSS variables (`--color-surface-panel`,
  `--color-text-primary`, …) with live light/dark updates, and the Dev Mode
  read-only rule (mutating calls reject while Dev/Inspect Mode is active).

## [0.23.0] - 2026-07-21

### Added
- **AI plugin generation tools (plg-03, pairs with frontend 0.55.0).** Three
  new client-executed tools in `penTools`: `create_plugin({name, description,
  icon?, code, ui?})`, `update_plugin({id, ...patch})` and `list_plugins()` —
  the agent can now write, install and iterate on generative plugins from chat.
  Schemas are minimal (shared `pluginUiSchema` for the panel size); the full
  `pen.*` API documentation lives in the new skill, not in the schemas, to
  preserve prompt caching.
- **`/plugin` skill (`src/skills/plugin.md`).** Reference for writing plugin
  code: the `pen.*` API v1 (tools.run, scene.batch/get, selection, viewport,
  notify, storage, ui.resize, selectionchange, close), rules (all-async,
  batch_design cap 25 ops, 100 KB code limit, headless-only until plugin
  panels ship) and worked examples. The allowed-tools section is
  machine-checkable and guarded by a cross-repo contract test on the frontend.

## [0.22.0] - 2026-07-21

### Added
- **Noise effect documented in `batch_design` effects (pairs with frontend
  0.54.0).** The effects bullet now describes the Figma-parity noise shape —
  `{type: "noise", noiseType: "mono"|"duo"|"multi", color, secondaryColor?,
  opacity?, noiseSize, noiseSizeY?, density, blendMode?}` — with the 2-per-node
  render cap and export behavior (raster yes, HTML drop), plus an example and
  the noise mention in the effect-style bullet. Execution is frontend-side as
  usual; no tool names changed, so the cross-repo contract is unaffected.

## [0.21.0] - 2026-07-20

### Added
- **Fit-to-canvas prompt rules for embeds and slides (FIR-54).** Agents kept
  generating embed/slide HTML that overflowed the fixed canvas size (bottom
  cutoff, horizontal scrollbars) and only fixed it after user pushback. The
  `prototype` and `slides` skills now carry a dedicated "Fit to canvas" section
  — hard no-overflow rule, CSS mechanics (`box-sizing: border-box`, root sized
  to the declared dimensions with `margin: 0; overflow: hidden`, no fixed child
  widths past the canvas, `overflow-wrap` for long strings), a content-density
  budget (a 1024×768 slide ≈ title + 4-6 bullets; split slides instead of
  shrinking fonts), a pre-emit vertical-sum self-check, and a new pre-flight
  checklist item in each skill. `CORE_PROMPT` gains a concise always-on fit
  rule so skill-less `edits`-mode sessions get it too.

### Fixed
- **`refero_get_style` INVALID_STYLE_UUIDS ergonomics (FIR-53).** The Refero
  MCP tool rejects calls that pass several style UUIDs at once; models burned a
  round-trip rediscovering this. The MCP wrapper (`ai/mcp.ts`) now augments the
  tool's description ("pass exactly one style UUID per call") and, when the
  upstream error matches `invalid style uuids` (any spelling/separator,
  singular or plural), appends a deterministic retry hint to the error the
  model sees. Results are sanitized like `refero_get_screen`; enrichment skips
  `isError: false` results and clones nothing when no hint applies.
  `wrapReferoTools` was generalized into a per-tool `wrapReferoTool` helper.

## [0.20.1] - 2026-07-20

### Changed
- **Internal: deduplicated the batch_design parser helpers in `ai/tools.ts`.**
  The four character-scanning functions (`splitBatchDesignStatements`,
  `findFirstTopLevelBrace`, `findMatchingBrace`, `splitTopLevelByComma`)
  repeated the same escape/string-literal handling and bracket-depth tracking;
  extracted shared `createQuoteScanner()` and `createDepthTracker()` helpers
  (mirroring the frontend's parser extraction). jscpd: 4 clones / 85 duplicated
  lines → 0. No behavior changes.
- **CI: added a jscpd duplication gate** — `npm run check:dup` (config in
  `.jscpd.json`: min 70 tokens, 0.1% threshold, `src/` minus `skills/`) runs
  after lint and fails the build if code duplication creeps back in.

## [0.20.0] - 2026-07-19

### Fixed
- **Prototype-routing regression: agent drifting into native nodes on
  create-new (FIR-45).** Even after `load_skill(prototype)`, some models kept
  building screens from native `frame`/`rect`/`text` nodes (via `batch_design`)
  instead of a single HTML `embed` — partly because they read the user's
  "separate frames / каждый отдельным фреймом" as a native `frame` node. Routing
  was prompt-only, so wording alone couldn't guarantee it. Added a **structural
  backstop** (backend only, no new client tool):
  - `resolveTaskPolicy(messages, slashSkill)` → `prototype | slides | native`,
    armed only by strong signals — a `/prototype`|`/slides` slash command, or a
    prior `load_skill(prototype|slides)` in the message history — so native-edit
    tasks are never wrongly restricted.
  - A **per-request embed-only `batch_design` schema** (`makeBatchDesignTool` /
    `makeBatchDesignInputSchema`): under prototype/slides policy, any `I()`/`R()`
    operation whose top-level node `type` isn't `"embed"` is rejected with an
    actionable `InvalidToolInputError` (already surfaced to the model). A
    type-less insert is treated as its effective native `"frame"` default (the
    frontend defaults a missing `type` to `frame`), closing that bypass.
  - Prompt/skill hardening: `prototype.md` gains a "NATIVE NODES ARE FORBIDDEN"
    blocker + a pre-flight embed-only check; the system prompt clarifies that
    "frame"/"фрейм" in a create-new request means a **screen** (an `embed`).
  - Observability: `resolvedTaskPolicy` is now recorded in the trace payload.

  Known limits (deferred to a per-turn policy design): a `/prototype` slash guard
  only persists on turn 1 (organic `load_skill` entry persists across turns);
  policy is sticky per session once a policy skill loads; `C()` copy of a native
  node isn't guarded.

## [0.19.0] - 2026-07-19

### Added
- **New `slides` skill for multi-slide decks (FIR-52).** Presentation / deck /
  slideshow / pitch-deck requests now load a dedicated `slides` skill instead of
  `prototype`. It builds each slide as its **own** top-level `embed` node (never
  several slides crammed into one embed — the recurring user correction that
  motivated this), fixes every slide at **1024×768 (4:3)**, lays them out as a
  **horizontal filmstrip** (`x = index * (1024 + gap)`, shared `y`), and enforces
  a **shared theme + master**: one `:root{}` CSS-variable block and one master
  layout (title/footer/page-number/margins) copied unchanged into every slide so
  the deck reads as one system. Inherits `prototype`'s taste rules (no device
  chrome, single font via `@import`, Phosphor icons, real `picsum.photos`
  images, one accent color, anti-slop content). Discoverable via `/slides` and
  the `load_skill` catalog; routed from the system prompt's first-decision block
  (`src/skills/slides.md`, `src/ai/system-prompt.ts`).

### Changed
- **`prototype` skill relaxed for multi-screen requests (FIR-52).** Single embed
  stays the default, but a request for multiple screens/views/pages now creates
  **one embed per screen** laid out left-to-right instead of cramming them into a
  single embed; actual presentation/deck requests hand off to the `slides` skill
  (`src/skills/prototype.md`).
- **`batch_design` binding docs clarified (FIR-51).** The tool description now
  states that bindings come **only** from the `binding=I(...)`/`binding=R(...)`
  prefix — an `id`/`name` field inside `nodeData` is cosmetic and never usable as
  a binding — matching the frontend handler fix that strips such stray `id`
  fields (`src/ai/tools.ts`).

## [0.18.0] - 2026-07-19

### Changed
- **Design-default prompt rules reworked from trace-analysis findings (FIR-47/48/49).**
  - **Icons:** the prototype skill now mandates Phosphor Icons as the default
    icon system for embed UI glyphs; emoji-as-icons and ad-hoc hand-drawn inline
    `<svg>` glyphs are banned (inline SVG stays allowed for logos/illustrations).
    `frontend-design` gains the matching DON'T.
  - **Fonts: `@import` instead of `<link>`.** Investigation of the frontend
    renderer showed embed `htmlContent` is sanitized with DOMPurify, which
    strips ALL `<link>` tags on the live canvas — the previously mandated Google
    Fonts `<link>` only ever worked in Play/export/convert paths. All external
    fonts/stylesheets (text font, Phosphor, optional mono) are now loaded via
    `@import` at the top of the first `<style>` block, which survives
    sanitization in every render path.
  - **One font family per design** by default (hierarchy via weight/size/color);
    a second family only on explicit user request or for literal code content
    (`'JetBrains Mono', ui-monospace, monospace`); the icon font is exempt.
    `document`'s visual-spec template no longer hardcodes a display/body font
    pairing; `frontend-design` no longer recommends pairing by default.
  - **Real photos, never gradient stand-ins:** picsum.photos is documented as
    reliable inside embeds; substituting CSS gradients or empty divs where a
    photo belongs is banned. `brand` now defaults to picsum seeds instead of
    guessed Unsplash URLs (which 404).
  - **No device/OS chrome** (iOS/Android status bar, notch/Dynamic Island, home
    indicator, browser chrome) unless explicitly requested — in both the
    prototype skill and the core system prompt.
- Content-pin test added (`test/skills.test.ts`) so the new rules can't silently
  regress.

## [0.17.2] - 2026-07-18

### Fixed
- **Design agent now reliably loads the `prototype` skill for create-new requests.**
  The prototype-routing rule was model-driven and lived in the skill catalog,
  where its wording lost to the emphatic "Mandatory flow (MUST follow every time)"
  native-node section in the core prompt. Weaker models (e.g. `z-ai/glm-5.2`,
  `deepseek-v4-pro`) skipped `load_skill(prototype)` and jumped straight into the
  native-node edit flow — even on an empty canvas. Reworked `system-prompt.ts`:
  the routing rule is now a hard **"FIRST DECISION"** gate ahead of any other
  tool call (explicitly covering the empty-canvas case), and the core "Mandatory
  flow" is scoped to "editing existing native nodes" and defers to skill routing.
  Verified live: previously-failing models now load `prototype` first on
  create-new and still skip it when editing an existing node.

## [0.17.1] - 2026-07-18

### Changed
- Test-only release: coverage for the session-insights seams
  (`test/insights*`), and the `analyze` CLI entrypoint excluded from coverage
  metrics. No runtime changes.

## [0.17.0] - 2026-07-18

### Added
- **Session insights — a second extraction pass over traces (`src/analysis/insights.ts`).**
  Alongside the Clio summary, `npm run analyze` now extracts per-session
  `session_insights`: tool errors with a `recovered` flag and what the agent did
  next, user corrections (with the user's verbatim quote and whether the agent
  complied), memory requests (verbatim, with an `honored` flag), and the agent's
  own claims about itself (limitation / assumption / plan / conclusion). This is
  the material the summarizer must discard — its no-quotes privacy rule strips
  exactly the wording a self-improvement agent needs. Unlike the summarizer this
  pass MAY quote the user, but only in the `user_quote`/`quote` fields, and every
  stored string still passes through `scrubPii`; `raw_traces` remains the only
  table holding unsanitized content. Stored in a new `session_insights` table
  (migration `002_insights.sql`, FK to `session_summaries` with `ON DELETE
  CASCADE`). Spec: `docs/superpowers/specs/2026-07-17-session-insights-design.md`.
- **"Corrections & memory requests" report section.** `reports/YYYY-MM-DD.md`
  now surfaces, between the tool-errors table and the clusters, the actionable
  insight entries for the window — corrections the agent did **not** comply with,
  memory requests **not** honored, and tool errors it did **not** recover from —
  with totals. Omitted entirely when there is nothing actionable.

### Changed
- **Insight extraction runs as its own backfill loop.** It processes every
  summarized session that lacks insights, independently of summarization, so it
  backfills sessions summarized before the feature existed — but only while their
  `raw_traces` rows survive `TRACE_RAW_TTL_DAYS`. Per-session try/catch keeps one
  poisoned session from blocking the rest, the clustering step, or the TTL
  cleanup.
- **Transcript rendering (`assemble.ts`) is now budget-tiered.** The old flat
  60k-char cap cut the middle out of long transcripts and clipped tool inputs at
  500 chars — silently eating the corrections the extractor exists to find.
  Rendering now tries generous limits first (default budget raised to 200k chars,
  well within the analysis model's context) and tightens only tool payloads under
  pressure; user/assistant text, tool errors, and stream errors are never
  truncated more aggressively. Middle-truncation remains only as a last resort.

### Fixed
- **`mapSteps` now reads AI SDK v6 `input`/`output`.** It read the v4-era
  `args`/`result`, which are always undefined on v6 step tool calls — so
  `payload.steps` tool I/O was empty on every trace ever written, and the final
  turn (taken from `payload.steps`, where a failing session usually fails)
  rendered blind. Now `tc.input ?? tc.args` / `tr.output ?? tr.result`, so new
  traces capture the last turn's tool calls and results. Traces written before
  this fix keep a blind final turn.

## [0.16.0] - 2026-07-16

### Added
- **`leave_comment` tool + `/design-review` skill (cmt-02).** A new
  client-executed `leave_comment` tool lets the agent drop comment pins of its
  own — the reverse of cmt-01's read/reply/resolve loop, turning the agent into
  a reviewer. It's a **batch** schema (`comments: [{ nodeId?, x?, y?, text }]`,
  each item requires a `nodeId` or an `x`/`y` point, enforced by a zod refine)
  so a whole review lands in one call rather than blowing the 12-step per-turn
  budget one pin at a time; it returns the created thread numbers for the model
  to cite. The `/design-review` skill drives it: read `get_guidelines` +
  `get_style_guide` first, then file every finding as one batched
  `leave_comment` anchored to the flagged node — never a finding without a rule
  behind it. Schema only (client-executed); the browser handler ships in
  pen-editor. Landed backend-first per the tool-contract merge order.

## [0.15.0] - 2026-07-16

### Added
- **Comment tool schemas (cmt-01).** Three new client-executed AI tools —
  `read_comments`, `reply_comment`, `resolve_comment` — let the design agent
  read canvas comment threads and act on them. A comment pin carries an exact
  node anchor that plain chat messages lack, so the agent can target a fix
  precisely. Schemas only (no `execute`): the tools run in the browser against
  the local scene graph. Landed backend-first per the tool-contract merge order;
  the frontend handlers ship in pen-editor.

## [0.14.0] - 2026-07-15

### Added
- **Clio-style trace analysis (ai-01).** With `TRACE_DATABASE_URL` set, the chat
  route fire-and-forget-writes raw session traces (messages, steps incl. tool
  errors, token usage, stream errors) to Postgres (`raw_traces`, TTL
  `TRACE_RAW_TTL_DAYS`, default 14 days); the feature is fully inert without the
  env var and DB failures never affect chat responses. `npm run analyze`
  (or `analyze:dist` from a production build) runs the worker: idempotent
  pgvector migrations, session assembly (longest history + final-turn steps),
  three-layer PII scrubbing (regex incl. AWS/Google/GitHub-PAT keys → prompt
  constraints → output validation with retry and hard-scrub fallback),
  structured summaries via `ANALYSIS_MODEL` (`generateObject`), optional Gemini
  embeddings (768-dim guard), LLM clustering with hostile-output
  post-processing, and a Markdown report (`reports/YYYY-MM-DD.md`, gitignored;
  copy in `analysis_runs.report_md`) with cluster deltas vs the previous run,
  outcome tallies, and top tool errors. Only `raw_traces` ever holds
  unsanitized content — cluster names/descriptions are scrubbed too, and
  LLM-derived text is escaped before landing in Markdown.

### Fixed (post-review, same release)
- Windowed queries use `make_interval(days => $1::int)` — the previous
  `$1::int … $1 || ' days'` pattern failed with SQLSTATE 42883 on every run.
- Migrations run on a single checked-out pool client (real transactions).
- Per-session fault isolation in the summarize loop: one failing session no
  longer blocks clustering or TTL cleanup.
- Aborted streams persist their real completed steps instead of `[]`.
- The shared pg pool factory installs an idle-client error listener in the
  worker as well as the chat server.

## [0.13.1] - 2026-07-11

### Fixed
- **Image generation could hang indefinitely (bug-11 / BE-01).** The OpenRouter
  image-generation request had no timeout, so a stalled upstream endpoint held
  the client connection and the Node request context open forever. The fetch
  (connect *and* response-body read) is now bounded by `AbortSignal.timeout`
  with `IMAGE_GENERATION_TIMEOUT_MS`, default 90s. A hit deadline raises
  `ImageGenerationTimeoutError`, which `/api/generate-image` maps to **HTTP
  504**. A client disconnect now also aborts the upstream request via
  `AbortSignal.any`, mirroring the chat route.

## [0.13.0] - 2026-07-09

Tool-schema support for the frontend P2 batch (pen-editor v0.18.0).

### Added
- **`set_export_settings` tool (p2-05)** — client-executed schema so the agent
  can configure per-node export presets (format / scale / suffix / quality),
  kept in sync across `penTools`, the frontend `toolRegistry`, and both
  name-list contract tests.

### Changed
- `batch_design` / `set_styles` docs now cover the background-blur effect
  (`{type: "background-blur", radius}`) with a glassmorphism example (p2-04).
  The `effects` field is free-form, so no schema change was needed.

## [0.12.0] - 2026-07-09

### Changed
- `batch_design` docs note that a `video` paint's `src` may be a YouTube URL
  (thumbnail on canvas, real `<iframe>` in export). Doc line only — no schema
  or tool-name change. Pairs with pen-editor v0.17.0.

## [0.11.0] - 2026-07-09

Tool-schema docs for three frontend capabilities (pen-editor v0.16.0);
execution stays browser-side. No tool-name changes.

### Changed
- `batch_design` docs now cover variable-font axes (`fontVariations`, p2-01),
  text links (markdown `[text](url "title")` → `TextNode.link`, p2-02), and
  video fill (`{type: "video", src, mode, crop, playback}`, p2-03).

## [0.10.1] - 2026-07-08

Tagged 2026-07-08, but the tag never reached GitHub; published retroactively on
2026-07-16.

### Fixed
- **The agent dead-ended on tool-input errors instead of self-correcting.** The
  chat route piped the UI message stream without an `onError` handler, so the
  AI SDK masked every stream error as a generic "An error occurred." — hiding
  actionable validation guidance (such as `batch_design`'s 25-operation limit)
  from the model. `InvalidToolInputError` and `NoSuchToolError` now surface
  their real message; anything else keeps the generic mask.

### Changed
- `set_variables` documents its accepted shapes in the schema (it was blank),
  and the `batch_design` docs clarify that `I(existingParent, {...})` is the
  only way to add children to an existing node — `U()` cannot change children.

### Removed
- The `/first-draft` skill from 0.10.0, reverted the same day.

## [0.10.0] - 2026-07-08

Figma-gap batch 7 (backend). Frontend counterpart: pen-editor v0.14.0.

### Added
- **`/first-draft` skill (p1-18)** — a directive recipe turning a one-sentence
  description into a complete screen of native nodes with auto-layout and
  variables: clarify the brief → check existing foundations → define variables →
  build section-by-section via `batch_design` → self-check via
  `snapshot_layout`. Explicitly forbids embed nodes, and ships through the
  existing skill-injection mechanism, so it adds no tools.
  **Reverted in 0.10.1.**

## [0.9.0] - 2026-07-07

Backend companion to pen-editor v0.12.0.

### Added
- **Shared-styles tools (p1-13)** — client-executed schemas `get_styles`,
  `set_styles`, `apply_fill_style`, and `apply_effect_style`. `set_styles`
  infers paint type from shape and returns created/updated style ids, so the
  model can chain straight into the apply tools.

### Changed
- `batch_design` documents `paragraphSpacing` (p1-11).

## [0.8.0] - 2026-07-07

Tool-schema and AI-doc support for the frontend shapes/patterns/masks/lists
batch.

### Changed
- `batch_design` docs now cover star polygons (`sides` +
  `innerRadiusRatio`), ellipse arcs/donuts (`startAngle`/`sweepAngle`/
  `innerRadiusRatio`), line arrowheads (`startCap`/`endCap`), pattern fills
  (image tile with scale/spacing/row-offset on rectangles, frames, and
  ellipses), layer masks (`isMask` masking siblings above in the same
  group/frame), and text lists (per-paragraph `paragraphs` attributes with
  list type and indent level).

## [0.7.0] - 2026-07-06

Tool-schema and AI-doc support for the frontend typography/layout batch
(text styles, auto-layout wrap & min/max, corner smoothing).

### Added
- **Text-style tools** — client-executed schemas `get_text_styles`,
  `set_text_styles` (create/update named styles), and `apply_text_style`
  (bind a style to text nodes), plus a system-prompt nudge to prefer named
  styles over hand-set typography values.

### Changed
- `batch_design` docs now cover auto-layout `wrap`, `rowGap`/`columnGap`,
  per-child `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, and
  `cornerSmoothing` (squircle) on rectangles/frames.

## [0.6.0] - 2026-07-05

Tool-schema and AI-doc support for the frontend effects/components/vector batch.

### Added
- **`remove_background` tool** — client-executed schema (`nodeId`) so the AI
  can cut the subject out of a node's image fill (in-browser RMBG-1.4
  inference on the frontend).

### Changed
- `batch_design` description documents the `effects` array (drop/inner
  shadows via `shadowType`, layer blur) and the component **properties /
  propertyValues** workflow (variant/boolean/text declarations on reusable
  frames, value switching on instances, two-call binding sequencing).
- **AI-facing component docs corrected** — system prompt, tool descriptions,
  and design skills now describe the real component model (reusable `frame`
  nodes instantiated as `ref` nodes with overrides), replacing the stale
  "embed + isComponent" description.

## [0.5.0] - 2026-07-05

Tool-schema support for the frontend P0 batch.

### Added
- **`boolean_operation` tool** — client-executed schema (`nodeIds` +
  `operation` enum) so the AI can union/subtract/intersect/exclude/flatten
  shapes.

### Changed
- `batch_design` description documents per-corner `cornerRadius` (number or
  `[tl, tr, br, bl]` array) and per-child `constraints`.

## [0.4.0] - 2026-07-03

First tracked release. Summarizes the features shipped up to this point.

### Added
- **AI image generation** — `POST /api/generate-image` route, an OpenRouter
  image-generation service, `OPENROUTER_IMAGE_MODEL` config, and
  `generate_image` / `generate_frame_image` client-executed tool schemas with
  system-prompt guidance.
- **Web tools** — `web_search` and `fetch_url` (Tavily), exposed in the default
  toolset and prototype mode; optional `TAVILY_API_KEY` config.
- **`rename_layers` tool** + `/rename-layers` skill.
- **Model list endpoint** — `GET /api/models` serving the chat model list;
  added DeepSeek V4 Flash/Pro and Qwen3.7 Plus.
- **Design skills → impeccable v3.9.1** — ported the design-agent skills and
  aligned the teach-impeccable setup flow.
- **Test & CI infrastructure** — Vitest suite (chat route, skills, sanitization,
  tool schemas, config, MCP, upload), ESLint in CI, and v8 coverage thresholds.

### Changed
- Default chat model set to gemini-2.5-flash; allow kimi-k2.6 / minimax-m3.
- Lowered design-agent reasoning effort to "minimal".

### Fixed
- Use a working OpenRouter image model id; require image MIME for generated
  data URLs and cover the content fallback.
- Stop the agent echoing image URL/base64 in its reply.
- `ENABLE_AGENT_LOGGING=false` now actually disables logging.

[Unreleased]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dan-rozhkov/pen-editor-backend/releases/tag/v0.4.0
