# Changelog

All notable changes to **pen-editor-backend** (AI design-agent server) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dan-rozhkov/pen-editor-backend/releases/tag/v0.4.0
