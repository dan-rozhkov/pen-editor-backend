# Sideform Light: local mode of the backend

Status: implemented. Contract: `sideform-light/CONTRACT.md`, "Backend" and "Own model provider (BYOK)".

## Goal
Sideform Light (Electron) bundles this backend and runs it on the user's machine with no built-in model provider: the agent runs only on the user's own OpenAI-compatible provider (`byok/<model>`).

## Design
- `SIDEFORM_LOCAL=1` is a Config flag (`Config.SIDEFORM_LOCAL`), set only by `loadLocalConfig()` (`src/local/config.ts`). That function builds the Config from a closed list of values. Only `PORT` comes from the environment (the server always binds `127.0.0.1`; `HOST` is ignored), so an `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `TRACE_DATABASE_URL`, `BETTER_AUTH_SECRET`, `POSTHOG_API_KEY`, `S3_*`, `TAVILY_API_KEY`, `GITHUB_TOKEN`, etc. on the user's machine is ignored. `OPENROUTER_API_KEY` is the empty string. `BYOK_ALLOW_PRIVATE_NETWORK` is on (a local Ollama or LM Studio is a valid provider).
- `buildLocalApp` (`src/local/app.ts`) is a separate Fastify app that reuses the route modules: `GET /api/models` (always empty), `POST /api/chat`, `POST /api/byok/models`, `POST /api/browse/{step,plan,locate,judge}`. Any other path is 404. Seams added to shared code: `chatRoutes(..., { auxiliaryRoutes: false })` skips `/api/skills` and `/api/doc-templates`; `setSkillsDir()` points the skill loader at the bundle's skills; `maskTokenInUrl` moved to `src/lib/` so the local app does not import the hosted `app.ts`.
- Auth fails closed: the entry and `buildLocalApp` refuse to start without `SIDEFORM_LOCAL_TOKEN` unless `SIDEFORM_LOCAL_INSECURE_DEV=1` (`insecureDev`; set by `npm run dev:local`). Every request needs `X-Sideform-Local-Token` (constant-time compare), else 401 `{ "error": "unauthorized" }`. Before that, a `Host` header other than `127.0.0.1:<port>` / `localhost:<port>` (the actual listening port) is 403 `{ "error": "forbidden_host" }` (DNS-rebinding defence). No CORS is registered or reflected: the callers are the shell's main-process proxy and the Vite dev proxy, which are not bound by CORS, and a foreign web page must not be able to read answers.
- `POST /api/chat`: a model that is not `byok/...` (or none) is 400 `{ "error": "provider_required" }`; an `agentMode` other than `browser` / `browse` is 400 `{ "error": "agent_mode_unsupported" }`. Both gates run before the rate limiter, so refused requests do not use up the main-turn budget. `agentMode: "browser"` and the nested `"browse"` turn (which follows the parent's `byok/` model) work as in the hosted server.
- Backstop: `createModel()` throws for any non-BYOK model when `SIDEFORM_LOCAL` is set (or the OpenRouter key is empty), so no helper can reach OpenRouter.

## Server-model calls reachable from a browser/browse turn
| Path | Why it is off in local mode |
|---|---|
| main/browse chat model | `byok/` only (`provider_required`, `createModel` backstop) |
| image description (`describeImage`, `analyze_image`) | `VISION_MODEL=""`: `isVisionConfigured` false, `analyze_image` is dropped, `describeImage` answers "not configured" with no request |
| screenshots on the user's model | In local mode a `byok/` model is assumed vision-capable (`modelSupportsVision`, same convention as an unlisted model) and its tool-result images reach it as `image_url` parts of a `role:"user"` message right after the tool message(s) (OpenAI allows only text in `role:"tool"`; the tool message keeps a text placeholder; `moveToolResultImagesToUserMessage` in the request body via `createByokModel({restoreToolImages})`, `toolResultImagesNative`). Done on the request body because the image-budget passes work on tool-result images. Screenshots go to the user's model; `browse_screenshot`/`get_screenshot` stay in the browse turn. The browser main turn has no screenshot tool by design (it delegates to `browse_agent`). Hosted BYOK is unchanged (not vision; images described by `VISION_MODEL`). |
| skill routing, image relevance, memory write filter (TypeSafe/Jev) | `createSystemOne` is null without `TYPESAFE_API_KEY`; modes forced off |
| `/api/browse/step`, `/plan`, `/locate` | 503 (no TypeSafe key) |
| `/api/browse/judge` | `QA_JUDGE_MODEL=off` answers `{ disabled: true }` |
| prompt suggestions, user-skill generation, prototype link, analysis, taste check | routes not registered |
| memory snapshot, memory/skill review, trace writes, audit | all stores are null; restricted turns skip them |
| web search (Tavily), MCP/Mobbin, GitHub repo | no keys; restricted turns load no MCP |
| analytics (PostHog) | client is null in the chat route |

## Bundle
`npm run build:local` (`scripts/build-local.mjs`, esbuild, node 22, one ESM file with a `createRequire` banner) writes `dist-local/server.mjs` and `dist-local/skills/`. Packages that sit in the import graph but are never reached (`@aws-sdk/client-s3`, `pg`, ...) are replaced by a stub that throws on use. `npm run smoke:local` copies `dist-local` to an empty temp dir and runs it with plain `node` against a mock OpenAI-compatible provider. The entry (`src/local/index.ts`) listens on `127.0.0.1:PORT` (default `0`), prints `SIDEFORM_LOCAL_READY port=<n>`, posts `{ type: "ready", port }` on `process.parentPort` when run in an Electron utilityProcess, and shuts down on SIGTERM/SIGINT or when the parent process is gone (parent pid polled every 2 s: Electron's `parentPort` emits no `close`; only under a parent: `parentPort` or `SIDEFORM_LOCAL_EXIT_WITH_PARENT=1`). Skills are found next to the bundle (esbuild `define` `__SIDEFORM_LOCAL_BUNDLE__`); if missing, the entry warns and continues (the browser and browse turns use fixed prompts and tool lists, with no skill catalog and no `load_skill`; only `/slash` skill commands need them). Stubs are a throwing Proxy (`scripts/lib/stubPlugin.mjs`, tested in `test/local-stubs.test.ts`).
