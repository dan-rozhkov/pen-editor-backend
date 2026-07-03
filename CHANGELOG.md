# Changelog

All notable changes to **pen-editor-backend** (AI design-agent server) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While on `0.x`, minor bumps may include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/dan-rozhkov/pen-editor-backend/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/dan-rozhkov/pen-editor-backend/releases/tag/v0.4.0
