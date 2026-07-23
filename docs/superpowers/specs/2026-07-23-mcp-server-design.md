# Pen Editor MCP Server — Design

**Date:** 2026-07-23
**Repos:** pen-editor-backend (server + bridge), pen-editor (WS bridge client + UI indicator)

## Goal

Expose Pen Editor to external MCP clients (Claude Code, claude.ai, Cursor, …) for two scenarios:

1. **Design-to-code** (Figma Dev Mode style): the client reads the live document — structure, styles, computed layout, variables, screenshots — to implement it in code.
2. **External editing**: the client creates/edits the design via the same `batch_design` DSL the built-in agent uses.

Both operate on the **live editor tab** — there is no server-side document store, and this spec does not add one.

## Non-goals

- Headless `.pen` file editing without a running editor.
- OAuth / multi-user accounts. Auth is a single shared secret.
- Exposing the full ~30-tool `penTools` surface. v1 is a curated set; extension is a follow-up.
- Changes to the built-in chat loop (`/api/chat` is untouched).

## Architecture

```
MCP client (Claude Code, …)
   │  MCP streamable HTTP   POST/GET/DELETE /api/mcp    Authorization: Bearer <MCP_AUTH_TOKEN>
   ▼
pen-editor-backend (Fastify)
   ├─ src/mcp/server.ts    McpServer (@modelcontextprotocol/sdk), curated tool defs
   ├─ src/mcp/bridge.ts    editor-session registry + request/response correlation
   └─ GET /api/mcp/ws      WebSocket (@fastify/websocket), token in query param or subprotocol
   ▼
pen-editor browser tab
   └─ src/lib/mcpBridge.ts  WS client → executeToolCall() → existing toolHandlers → result back
```

### Backend (`pen-editor-backend`)

New dependencies: `@modelcontextprotocol/sdk` (server), `@fastify/websocket`.

- **`src/mcp/server.ts`** — builds an `McpServer` with the curated tools (below). Bridged tools' zod input schemas are **imported/reused from `src/ai/tools.ts`** (single source of truth; refactor `tools.ts` to export the raw zod shapes where needed rather than duplicating them). Static tools (`get_guidelines`, `get_style_guide`, `get_style_guide_tags`) execute directly on the backend by calling the same implementations `penTools` uses.
- **`src/mcp/bridge.ts`** — module-level registry of connected editor sessions:
  - `registerSession(socket)` / `unregisterSession(socket)`; each session tracks `lastActiveAt` (updated on connect and on `activity` pings from the tab, sent on `focus`/`visibilitychange`).
  - `callTool(name, args): Promise<string>` — picks the most-recently-active session, sends `{id, type:"tool_call", tool, args}`, resolves on `{id, type:"tool_result", result}` or rejects on `{id, type:"tool_error", error}`. 30 s timeout. If the socket closes mid-flight, all its pending calls reject immediately.
  - No connected session → reject with a clear message: *"No Pen Editor tab is connected. Open the editor in a browser with MCP enabled (VITE_MCP_WS_TOKEN set)."*
- **`src/mcp/routes.ts`** — registers:
  - `POST/GET/DELETE /api/mcp` — `StreamableHTTPServerTransport` from the SDK. Stateless mode (`sessionIdGenerator: undefined`) — no session persistence needed for a single-user tool; every request creates a transport bound to the shared `McpServer` per SDK stateless pattern.
  - `GET /api/mcp/ws` — WebSocket upgrade for editor tabs.
  - **Auth:** every `/api/mcp*` request requires the token — `Authorization: Bearer <token>` for MCP HTTP; for WS, `?token=<token>` query param (browser `WebSocket` cannot set headers). Constant-time comparison. If `MCP_AUTH_TOKEN` is unset in env, all `/api/mcp*` routes return 503 and the feature is off (mirrors the S3/Refero gating pattern).
- **`src/config.ts`** — add optional `MCP_AUTH_TOKEN` (min length 16 when set).
- `reply.hijack()` is needed for the streamable HTTP transport (it writes to the raw response), same pattern as `/api/chat`; CORS headers set manually where hijacked. MCP HTTP routes should also handle `OPTIONS` preflight and expose the `Mcp-Session-Id`/`Authorization` headers per existing CORS plugin config (extend allowed headers).

### Frontend (`pen-editor`)

- **`src/lib/mcpBridge.ts`** — a WS client started from app bootstrap when configured:
  - Config: `VITE_MCP_WS_TOKEN` (the shared secret) — bridge is enabled iff set. WS URL derives from the same backend base URL resolution `useDesignChat` uses (`VITE_AI_API_URL`/`VITE_DESIGN_AGENT_BACKEND_URL`, http→ws scheme), path `/api/mcp/ws?token=…`.
  - On `tool_call` message: run the tool through the **existing** `executeToolCall(toolName, input)` path (same 30 s timeout semantics as chat), reply `tool_result` / `tool_error`. Reject tool names not present in `toolHandlers`.
  - Reconnect with exponential backoff (1 s → 30 s cap) + jitter; sends `activity` ping on `window` focus / `visibilitychange: visible`.
  - **Guard:** while a bridged tool call is executing, concurrent calls queue (serial execution) so two agents can't interleave scene mutations mid-call.
- **Status indicator** — small indicator near the file name (same area as the offline cloud icon): dot + tooltip "MCP connected / disconnected". Driven by a tiny zustand store (`mcpBridgeStore`) with `status: "off" | "connecting" | "connected"`. UI-only — no canvas rendering involved.

### Multi-tab semantics

All configured tabs connect; the backend routes each tool call to the single most-recently-active session. `get_editor_state` output already identifies the document, so the client can tell what it's talking to.

## Curated tool set (v1)

Bridged tool names are **identical to existing `toolRegistry` handler names** — zero new frontend handlers.

| MCP tool | Kind | Notes |
|---|---|---|
| `get_editor_state` | read, bridged | Document skeleton + current selection. Entry point; description tells the client to call this first (Figma's metadata-first pattern). |
| `batch_get` | read, bridged | Node details by id/pattern with depth control. |
| `snapshot_layout` | read, bridged | Computed layout rects — key for design-to-code fidelity. |
| `get_variables` | read, bridged | Design tokens/themes. |
| `get_screenshot` | read, bridged | Enabled **only** via MCP (stays disabled for the built-in chat). If `nodeId` omitted → screenshots the current selection (single selected node; error if none/multiple). Returns MCP `image` content (base64 PNG), not a URL. |
| `batch_design` | write, bridged | The I/C/U/R/M/D/G DSL. Tool description embeds the essential DSL guidance the built-in agent gets from its system prompt, and points to `get_guidelines`. |
| `set_variables` | write, bridged | Create/update variables & themes. |
| `get_guidelines` | static, backend | Same content as penTools' server-executed version — delivers DSL/design guidance to external clients. |
| `get_style_guide_tags` / `get_style_guide` | static, backend | Style-guide catalog. |

Selection-based defaults follow Figma's local-server pattern: read tools without explicit ids operate on/report the current selection.

`get_screenshot` schema note: the backend schema for it currently exists only as a commented-out block in `tools.ts`; the MCP server defines its own zod schema `{ nodeId?: string }`. The built-in chat's tool list is unchanged — the "no visual-verification tool" product decision stands for the chat agent; MCP is a different consumer, and the frontend handler must accept the omitted-`nodeId` → selection fallback (small handler extension, still one handler shared by both paths).

## Error handling

- No editor tab connected → MCP error result with the actionable message above.
- Bridged call timeout (30 s) → MCP error "editor did not respond".
- WS drops mid-call → immediate MCP error, no hung promises.
- Unknown tool / handler exception → propagated as MCP `isError: true` text result (never crashes the socket).
- Auth failures: HTTP 401 (bad token) / 503 (feature disabled). WS with bad token is closed during upgrade with 401.

## Testing

- **Backend (Vitest, `test/`):**
  - `mcp-bridge.test.ts` — unit: session registry, most-recently-active routing, timeout, mid-call disconnect rejection, no-session error.
  - `mcp-server.integration.test.ts` — `buildApp()` + `listen` on ephemeral port (chat-route pattern; `app.inject()` won't work with hijack): a fake editor tab connects over real WS (`ws` dev-dep), a real MCP client (`@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport) lists tools and round-trips a bridged call and a static call; auth matrix (no token env → 503, wrong bearer → 401, wrong WS token → close).
- **Frontend (Vitest):** `mcpBridge.test.ts` with a mock WebSocket — dispatch into `toolHandlers`, serialization, error reply, reconnect/backoff (fake timers), serial-queue guard, store status transitions.
- **Contract:** extend the existing cross-repo contract tests: every *bridged* MCP tool name must exist in `toolRegistry` (frontend side) and in the backend's bridged-name list (backend side, hardcoded list in `tools-contract.test.ts` style). Static tools are exempt.
- **Live smoke (manual, end of project):** run backend locally with `MCP_AUTH_TOKEN`, `claude mcp add --transport http pen-editor http://localhost:3001/api/mcp` with the bearer header, open the editor with `VITE_MCP_WS_TOKEN`, and from Claude Code: read state → screenshot → `batch_design` edit visible on canvas.

## Rollout

1. Backend first (schemas + server + bridge + routes + tests) — merges green independently.
2. Frontend bridge + indicator + handler tweak (`get_screenshot` selection fallback) + tests.
3. Contract-test extensions land with their respective sides.
4. Docs: README/CLAUDE.md snippets for connecting Claude Code; `.env.example` additions.
5. Releases: independent SemVer bumps per repo convention; live smoke before closing.
