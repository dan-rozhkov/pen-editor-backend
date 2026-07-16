# Changelog

All notable changes to **pen-editor-backend** (AI design-agent server) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [Unreleased]

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
