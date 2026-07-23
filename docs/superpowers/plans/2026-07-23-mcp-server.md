# Pen Editor MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Pen Editor to external MCP clients (Claude Code, claude.ai, Cursor, …) over `/api/mcp` (streamable HTTP) and `/api/mcp/ws` (browser bridge), reusing the existing client-executed tool handlers — no server-side document store.

**Architecture:** `pen-editor-backend` runs an `McpServer` (`@modelcontextprotocol/sdk`) exposing 7 bridged tools + 3 static tools. Bridged calls are forwarded over a WebSocket (`@fastify/websocket`) to whichever `pen-editor` browser tab is most recently active; the tab's `src/lib/mcpBridge.ts` executes them through the **same** `executeToolCall`/`toolHandlers` path the built-in chat already uses, and replies over the socket. Both HTTP and WS routes require a shared-secret bearer/query token (`MCP_AUTH_TOKEN` / `VITE_MCP_WS_TOKEN`).

**Tech Stack:** Fastify 5, `@modelcontextprotocol/sdk`, `@fastify/websocket`, zod, Vitest (`ai/test` + real `ws`/MCP SDK client for integration); frontend: native `WebSocket`, Zustand, Vitest + happy-dom.

## Global Constraints

- Two independent git repos (`pen-editor-backend`, `pen-editor`) — commit separately, backend first (its own tests never check out the frontend, so its CI goes green independently; see root `CLAUDE.md`'s tool-contract merge-order rule, which applies here too even though this isn't a `penTools` change).
- Backend: `moduleResolution: "NodeNext"` + ESM — every relative import needs an explicit `.js` extension, including new files under `src/mcp/`.
- TypeScript strict mode in both repos. `npm run lint` must stay at 0 errors in both repos.
- Do **not** touch `/api/chat` behavior or its request/response shape. The built-in chat's tool list (`penTools`) is unchanged in name/behavior — `get_screenshot` stays absent from it (MCP-only).
- `reply.hijack()` is required for both the streamable-HTTP MCP routes and the existing `/api/chat` route (writes to the raw Node response) — CORS headers must be set manually on hijacked replies, same pattern as `chat.ts`.
- No OAuth/multi-user accounts — a single shared secret (`MCP_AUTH_TOKEN` on the backend, `VITE_MCP_WS_TOKEN` on the frontend) gates everything under `/api/mcp*`. Compare tokens in constant time (`node:crypto` `timingSafeEqual`), never `===`.
- `MCP_AUTH_TOKEN` unset → every `/api/mcp*` route returns 503 (mirrors the existing S3/Refero optional-feature gating pattern in `config.ts`).
- The curated v1 tool set is exactly: `get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables` (bridged) + `get_guidelines`, `get_style_guide_tags`, `get_style_guide` (static, backend-executed). No other `penTools` entries are exposed in v1.
- Bridged tools' zod input validation is reused from `src/ai/tools.ts` (single source of truth) — not duplicated in `src/mcp/server.ts`.
- Frontend bridge is enabled iff `VITE_MCP_WS_TOKEN` is set at build time; it is otherwise fully inert (no WebSocket connection attempted).
- Backend tests never need network/real API keys (existing convention); the MCP integration test uses a real `ws` client and a real MCP SDK client against a `buildApp()` instance listening on an ephemeral port — no external services.

---

## Part 1 — Backend (`pen-editor-backend`)

### Task 1: `MCP_AUTH_TOKEN` config + constant-time auth helpers

**Files:**
- Modify: `pen-editor-backend/src/config.ts`
- Modify: `pen-editor-backend/test/helpers.ts`
- Create: `pen-editor-backend/src/mcp/auth.ts`
- Create: `pen-editor-backend/test/mcp-auth.test.ts`
- Modify: `pen-editor-backend/.env.example`

**Interfaces:**
- Produces: `Config.MCP_AUTH_TOKEN: string | undefined` (consumed by Task 6's routes). `constantTimeEqual(a: string, b: string): boolean` and `extractBearerToken(header: string | string[] | undefined): string | null`, both exported from `src/mcp/auth.ts` (consumed by Task 6).

- [ ] **Step 1: Write the failing auth-helper test**

Create `pen-editor-backend/test/mcp-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { constantTimeEqual, extractBearerToken } from "../src/mcp/auth.js";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing or malformed header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  it("uses the first value when the header is an array", () => {
    expect(extractBearerToken(["Bearer first", "Bearer second"])).toBe("first");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails to resolve the module**

Run: `cd pen-editor-backend && npx vitest run test/mcp-auth.test.ts`
Expected: FAIL — `Cannot find module '../src/mcp/auth.js'`

- [ ] **Step 3: Implement `src/mcp/auth.ts`**

```ts
import { timingSafeEqual } from "node:crypto";

// Constant-time string comparison for shared secrets — never replace with
// `===`, which short-circuits on the first mismatched byte and leaks timing
// information about how much of the token was guessed correctly.
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Extracts the token from an `Authorization: Bearer <token>` header. Returns
// null for a missing, empty, or non-Bearer header (Fastify may hand back an
// array if the header was repeated; only the first value is honored).
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd pen-editor-backend && npx vitest run test/mcp-auth.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Add `MCP_AUTH_TOKEN` to `Config`**

In `pen-editor-backend/src/config.ts`, add to `envSchema` (after `EMBEDDINGS_MODEL`):

```ts
  EMBEDDINGS_MODEL: z.string().default("text-embedding-004"),
  // --- MCP server (optional) ---
  // Shared bearer secret gating /api/mcp (streamable HTTP) and /api/mcp/ws
  // (browser bridge). Unset = the whole /api/mcp* surface returns 503,
  // mirroring the S3/Refero optional-feature gating pattern above.
  MCP_AUTH_TOKEN: z
    .string()
    .min(16, "MCP_AUTH_TOKEN must be at least 16 characters")
    .optional(),
});
```

(Move the closing `});` down accordingly — `MCP_AUTH_TOKEN` becomes the last field.)

- [ ] **Step 6: Add the field to the test config builder**

In `pen-editor-backend/test/helpers.ts`, add `MCP_AUTH_TOKEN: undefined,` to the object returned by `makeConfig` (after `EMBEDDINGS_MODEL: "text-embedding-004",`, before the `...overrides` spread).

- [ ] **Step 7: Document the env var**

In `pen-editor-backend/.env.example`, append after the trace-analysis block:

```
# --- MCP server (optional) ---
# Exposes /api/mcp (streamable HTTP, for Claude Code/claude.ai/Cursor) and
# /api/mcp/ws (browser tab bridge). Unset = /api/mcp* returns 503.
# Generate a strong random value, e.g. `openssl rand -hex 24`.
MCP_AUTH_TOKEN=
```

- [ ] **Step 8: Run the full backend test suite to confirm no regression**

Run: `cd pen-editor-backend && npm test`
Expected: PASS (existing tests unaffected; `makeConfig()` still returns a valid `Config`)

- [ ] **Step 9: Commit**

```bash
cd pen-editor-backend
git add src/config.ts test/helpers.ts src/mcp/auth.ts test/mcp-auth.test.ts .env.example
git commit -m "feat(mcp): add MCP_AUTH_TOKEN config and constant-time auth helpers"
```

---

### Task 2: Refactor `src/ai/tools.ts` to export raw zod shapes and static-tool implementations

Reused by Task 5 (`src/mcp/server.ts`) so the MCP tool schemas and static-tool
logic are never duplicated. This task changes **only** how the existing code
is organized — `penTools`' external shape, descriptions, and behavior are
unchanged, so `test/tools-contract.test.ts` must still pass unmodified.

**Files:**
- Modify: `pen-editor-backend/src/ai/tools.ts`

**Interfaces:**
- Produces (all exported from `src/ai/tools.ts`, consumed by `src/mcp/server.ts` in Task 5):
  - `export const getEditorStateInputShape: { include_schema: z.ZodBoolean }`
  - `export const batchGetInputShape: { patterns, nodeIds, parentId, readDepth, searchDepth, resolveVariables, includePathGeometry }` (each the same `z.ZodTypeAny` already inline in `batch_get`'s `inputSchema`)
  - `export const snapshotLayoutInputShape: { parentId, maxDepth, problemsOnly }`
  - `export const getVariablesInputShape: {}` (empty object shape)
  - `export const setVariablesInputShape: { variables: z.ZodRecord<z.ZodUnknown>, replace: z.ZodOptional<z.ZodBoolean> }`
  - `export const batchDesignInputShape: { operations, design, script, batch }` (all `z.string().optional()`)
  - `export const BATCH_DESIGN_DESCRIPTION: string` (already exists as a module-local `const`; add `export`)
  - `export async function getGuidelinesImpl(topic: string): Promise<{ topic: string; guidelines: string } | { error: string }>`
  - `export async function getStyleGuideTagsImpl(): Promise<{ tags: Record<string, string[]> }>`
  - `export async function getStyleGuideImpl(args: { tags?: string[]; name?: string }): Promise<{ name: string; basedOn: string[]; typography: unknown; colors: unknown; spacing: unknown; borderRadius: unknown }>`

- [ ] **Step 1: Extract `get_editor_state`'s shape**

In `pen-editor-backend/src/ai/tools.ts`, just above `export const penTools = {`, add:

```ts
export const getEditorStateInputShape = {
  include_schema: z
    .boolean()
    .describe(
      "Whether to include the .pen file schema in the response. Set true if you need to understand the node format.",
    ),
};
```

Then change `get_editor_state`'s `inputSchema` from the inline `z.object({ include_schema: ... })` to:

```ts
    inputSchema: z.object(getEditorStateInputShape),
```

- [ ] **Step 2: Extract `batch_get`'s shape**

Add above `export const penTools`:

```ts
export const batchGetInputShape = {
  patterns: z
    .array(
      z.object({
        type: z
          .enum([
            "frame",
            "group",
            "rectangle",
            "ellipse",
            "line",
            "polygon",
            "path",
            "text",
            "embed",
            "ref",
            "connector",
          ])
          .optional()
          .describe("Only return nodes with this type"),
        name: z
          .string()
          .optional()
          .describe("Only return nodes whose name matches this regex pattern"),
      }),
    )
    .optional()
    .describe("Search patterns to match nodes"),
  nodeIds: z.array(z.string()).optional().describe("Specific node IDs to read"),
  parentId: z.string().optional().describe("Parent node ID to limit search scope"),
  readDepth: z
    .number()
    .optional()
    .describe("How deep to read children (default 1). Nodes beyond this depth show as '...'."),
  searchDepth: z
    .number()
    .optional()
    .describe("How deep to search in the node tree. Unlimited if omitted."),
  resolveVariables: z
    .boolean()
    .optional()
    .describe("If true, variable references are resolved to their current values."),
  includePathGeometry: z
    .boolean()
    .optional()
    .describe("If true, include full SVG path geometry data."),
};
```

Change `batch_get`'s `inputSchema` to `z.object(batchGetInputShape)`, replacing its inline object literal.

- [ ] **Step 3: Extract `snapshot_layout`'s shape**

Add:

```ts
export const snapshotLayoutInputShape = {
  parentId: z.string().optional().describe("Subtree root to inspect. Omit for the whole document."),
  maxDepth: z
    .number()
    .optional()
    .describe("Depth limit for traversal. Default is direct children only. Be careful with large values."),
  problemsOnly: z
    .boolean()
    .optional()
    .describe("If true, only return nodes with layout problems (clipping, overflow)."),
};
```

Change `snapshot_layout`'s `inputSchema` to `z.object(snapshotLayoutInputShape)`.

- [ ] **Step 4: Extract `get_variables` and `set_variables` shapes**

Add:

```ts
export const getVariablesInputShape = {};

export const setVariablesInputShape = {
  variables: z
    .record(z.unknown())
    .describe(
      "Variable definitions, as an object keyed by variable name. Simplest form — a plain hex string per name: " +
        '`{"--brand-primary": "#3b82f6", "--brand-bg": "#ffffff"}`. ' +
        "Full form — an object per name with `type` (\"color\" | \"number\" | \"string\", default \"color\") and `value`: " +
        '`{"--radius-lg": {"type": "number", "value": "16"}}`. ' +
        "Per-theme values use `themeValues`: " +
        '`{"--brand-bg": {"type": "color", "value": "#ffffff", "themeValues": {"dark": "#0b0b0b"}}}`. ' +
        "Names may be given with or without a leading `--`/`$`. Nested token groups (e.g. `{colors: {primary: {$type, $value}}}`) are also accepted.",
    ),
  replace: z.boolean().optional().describe("If true, replaces all existing variables. Default is merge."),
};
```

Change `get_variables`'s `inputSchema` to `z.object(getVariablesInputShape)` and `set_variables`'s to `z.object(setVariablesInputShape)`, replacing their inline object literals (keep the descriptions verbatim, just moved).

- [ ] **Step 5: Extract `batch_design`'s raw shape and export its description**

In `makeBatchDesignInputSchema`, replace:

```ts
  return z
    .object({
      operations: z.string().optional(),
      design: z.string().optional(),
      script: z.string().optional(),
      batch: z.string().optional(),
    })
    .transform((input, ctx) => {
```

with a module-level shape constant used by both the transform and the MCP server:

```ts
export const batchDesignInputShape = {
  operations: z.string().optional(),
  design: z.string().optional(),
  script: z.string().optional(),
  batch: z.string().optional(),
};
```

placed just above `export function makeBatchDesignInputSchema`, and change the function body to:

```ts
  return z
    .object(batchDesignInputShape)
    .transform((input, ctx) => {
```

Then find the line `const BATCH_DESIGN_DESCRIPTION = \`Execute batch operations...` and add `export` in front of it: `export const BATCH_DESIGN_DESCRIPTION = \`...\`;`.

- [ ] **Step 6: Extract the `get_guidelines` implementation**

Find the `get_guidelines` tool definition (its `execute` currently inlines a `guidelines` record and the lookup). Replace the whole tool entry:

```ts
  get_guidelines: tool({
    description:
      "Get design guidelines and rules for a specific topic. Returns static instructional content to help you follow best practices.",
    inputSchema: z.object({
      topic: z
        .enum(["code", "table", "tailwind", "landing-page", "design-system"])
        .describe("Topic to retrieve guidelines for."),
    }),
    execute: async ({ topic }) => {
      const guidelines: Record<string, string> = {
        /* ... existing "design-system", "code", "table", "tailwind", "landing-page" entries, unchanged ... */
      };

      if (!guidelines[topic]) {
        return {
          error: `Invalid topic. Available topics: ${Object.keys(guidelines).join(", ")}`,
        };
      }
      return { topic, guidelines: guidelines[topic] };
    },
  }),
```

with a top-level constant plus a thin tool wrapper that calls a newly exported function — move the **existing, unmodified** `guidelines` record verbatim out of the closure into a module-level `const GUIDELINES`:

```ts
// The full instructional text for each topic — unchanged from the previous
// inline `guidelines` record, only hoisted so both the chat tool's execute
// and the MCP server's get_guidelines tool (src/mcp/server.ts) can call the
// same lookup without duplicating this content.
const GUIDELINES: Record<string, string> = {
  "design-system": /* the exact existing "design-system" string value, unchanged */,
  code: /* the exact existing "code" string value, unchanged */,
  table: /* the exact existing "table" string value, unchanged */,
  tailwind: /* the exact existing "tailwind" string value, unchanged */,
  "landing-page": /* the exact existing "landing-page" string value, unchanged */,
};

export async function getGuidelinesImpl(
  topic: string,
): Promise<{ topic: string; guidelines: string } | { error: string }> {
  if (!GUIDELINES[topic]) {
    return {
      error: `Invalid topic. Available topics: ${Object.keys(GUIDELINES).join(", ")}`,
    };
  }
  return { topic, guidelines: GUIDELINES[topic] };
}
```

and the tool entry becomes:

```ts
  get_guidelines: tool({
    description:
      "Get design guidelines and rules for a specific topic. Returns static instructional content to help you follow best practices.",
    inputSchema: z.object({
      topic: z
        .enum(["code", "table", "tailwind", "landing-page", "design-system"])
        .describe("Topic to retrieve guidelines for."),
    }),
    execute: async ({ topic }) => getGuidelinesImpl(topic),
  }),
```

(The `/* ... */` comments above mark a straight cut-and-paste of the five existing string literals with zero text changes — do not alter their contents.)

- [ ] **Step 7: Extract the `get_style_guide_tags` implementation**

Replace:

```ts
  get_style_guide_tags: tool({
    description: "...",
    inputSchema: z.object({}),
    execute: async () => {
      return {
        tags: { /* existing style/color/industry/platform/layout arrays, unchanged */ },
      };
    },
  }),
```

with:

```ts
export async function getStyleGuideTagsImpl(): Promise<{ tags: Record<string, string[]> }> {
  return {
    tags: {
      style: ["minimal", "bold", "elegant", "playful", "corporate", "modern", "retro", "brutalist"],
      color: ["monochrome", "vibrant", "pastel", "dark", "light", "warm", "cool", "earth-tones"],
      industry: ["saas", "ecommerce", "finance", "healthcare", "education", "creative", "technology"],
      platform: ["mobile", "website", "webapp", "dashboard"],
      layout: ["grid", "asymmetric", "centered", "full-width", "card-based", "sidebar"],
    },
  };
}
```

and the tool entry:

```ts
  get_style_guide_tags: tool({
    description:
      "Get all available style guide tags. Call this before get_style_guide to know which tags you can use for filtering.",
    inputSchema: z.object({}),
    execute: async () => getStyleGuideTagsImpl(),
  }),
```

- [ ] **Step 8: Extract the `get_style_guide` implementation**

Replace the `get_style_guide` tool's `execute` body (the `{ name, basedOn, typography, colors, spacing, borderRadius }` object) with:

```ts
export async function getStyleGuideImpl(args: { tags?: string[]; name?: string }): Promise<{
  name: string;
  basedOn: string[];
  typography: unknown;
  colors: unknown;
  spacing: unknown;
  borderRadius: unknown;
}> {
  const { tags, name } = args;
  return {
    name: name ?? "Generated Style Guide",
    basedOn: tags ?? [],
    typography: {
      headingFont: "Inter",
      bodyFont: "Inter",
      sizes: { h1: 48, h2: 36, h3: 24, h4: 18, body: 16, small: 14, caption: 12 },
      weights: { heading: "700", body: "400", emphasis: "600" },
    },
    colors: {
      primary: "#3B82F6",
      secondary: "#8B5CF6",
      accent: "#F59E0B",
      background: "#FFFFFF",
      surface: "#F8FAFC",
      text: "#0F172A",
      textMuted: "#64748B",
      border: "#E2E8F0",
      success: "#22C55E",
      error: "#EF4444",
      warning: "#F59E0B",
    },
    spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, section: 64 },
    borderRadius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  };
}
```

and the tool entry:

```ts
  get_style_guide: tool({
    description:
      "Get a style guide for design inspiration. Either pass 5-10 tags to find a matching style, or pass a specific name to retrieve a known style guide.",
    inputSchema: z.object({
      tags: z.array(z.string()).optional().describe("5-10 tags to search for a matching style guide."),
      name: z.string().optional().describe("Specific style guide name to retrieve."),
    }),
    execute: async ({ tags, name }) => getStyleGuideImpl({ tags, name }),
  }),
```

- [ ] **Step 9: Run the full backend test suite — must be a no-op change from the outside**

Run: `cd pen-editor-backend && npm test`
Expected: PASS, including `test/tools-contract.test.ts` unchanged (`penTools`' shape, descriptions, and `execute` presence/absence are byte-for-byte the same as before this refactor — only where the code lives changed).

- [ ] **Step 10: Lint and build**

Run: `cd pen-editor-backend && npm run lint && npm run build`
Expected: 0 lint errors, `tsc` succeeds (the new exports don't break `noUnusedLocals`/etc since every new export is consumed by Task 5).

- [ ] **Step 11: Commit**

```bash
cd pen-editor-backend
git add src/ai/tools.ts
git commit -m "refactor(ai): export raw zod shapes and static-tool impls from tools.ts for MCP reuse"
```

---

### Task 3: Install MCP server dependencies

**Files:**
- Modify: `pen-editor-backend/package.json`
- Modify: `pen-editor-backend/package-lock.json` (generated)

- [ ] **Step 1: Install runtime dependencies**

Run: `cd pen-editor-backend && npm install @modelcontextprotocol/sdk @fastify/websocket`

- [ ] **Step 2: Install test-only dependencies**

Run: `cd pen-editor-backend && npm install -D ws @types/ws`

(`ws` powers the fake-editor-tab side of the integration test in Task 7; `@fastify/websocket` already depends on `ws` internally, but the test needs its own client-side import.)

- [ ] **Step 3: Verify the install**

Run: `cd pen-editor-backend && npm run build`
Expected: PASS (no new code uses the packages yet, so this only confirms `npm install` didn't break the existing build)

- [ ] **Step 4: Commit**

```bash
cd pen-editor-backend
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk, @fastify/websocket, ws deps for MCP server"
```

---

### Task 4: `src/mcp/bridge.ts` — editor session registry

**Files:**
- Create: `pen-editor-backend/src/mcp/bridge.ts`
- Create: `pen-editor-backend/test/mcp-bridge.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (only `node:crypto`'s `randomUUID`).
- Produces (consumed by Task 5's `src/mcp/server.ts` and Task 6's `src/mcp/routes.ts`):
  - `export interface EditorSocket { readyState: number; send(data: string): void; on(event: "message", listener: (data: unknown) => void): void; on(event: "close", listener: () => void): void; }`
  - `export function registerSession(socket: EditorSocket): void`
  - `export function unregisterSession(socket: EditorSocket): void`
  - `export function callTool(tool: string, args: Record<string, unknown>): Promise<string>`
  - `export function sessionCount(): number`
  - `export function resetBridgeForTests(): void`
  - `export const NO_SESSION_MESSAGE: string`

- [ ] **Step 1: Write the failing bridge test**

Create `pen-editor-backend/test/mcp-bridge.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSession,
  unregisterSession,
  callTool,
  sessionCount,
  resetBridgeForTests,
  NO_SESSION_MESSAGE,
  type EditorSocket,
} from "../src/mcp/bridge.js";

class FakeSocket implements EditorSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  private messageListeners: Array<(data: unknown) => void> = [];
  private closeListeners: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  on(event: "message" | "close", listener: (data?: unknown) => void): void {
    if (event === "message") this.messageListeners.push(listener as (data: unknown) => void);
    else this.closeListeners.push(listener as () => void);
  }

  emitMessage(data: unknown): void {
    for (const l of this.messageListeners) l(data);
  }

  emitClose(): void {
    this.readyState = 3; // CLOSED
    for (const l of this.closeListeners) l();
  }

  lastCall(): { id: string; tool: string; args: unknown } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

beforeEach(() => {
  resetBridgeForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mcp bridge", () => {
  it("rejects immediately with no connected session", async () => {
    await expect(callTool("get_editor_state", {})).rejects.toThrow(NO_SESSION_MESSAGE);
  });

  it("routes a call to the only session and resolves on tool_result", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", { include_schema: false });
    const call = socket.lastCall();
    expect(call.tool).toBe("get_editor_state");
    expect(call.args).toEqual({ include_schema: false });

    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_result", result: "{}" }));

    await expect(promise).resolves.toBe("{}");
  });

  it("rejects on tool_error", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("batch_design", { operations: 'D("x")' });
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_error", error: "node not found" }));

    await expect(promise).rejects.toThrow("node not found");
  });

  it("ignores activity pings and stray messages without a matching id", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ type: "activity" }));
    socket.emitMessage(JSON.stringify({ id: "not-the-real-id", type: "tool_result", result: "wrong" }));
    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_result", result: "right" }));

    await expect(promise).resolves.toBe("right");
  });

  it("routes to the most-recently-active session", () => {
    vi.useFakeTimers();
    const older = new FakeSocket();
    const newer = new FakeSocket();

    vi.setSystemTime(1000);
    registerSession(older);
    vi.setSystemTime(2000);
    registerSession(newer);
    vi.setSystemTime(3000);
    older.emitMessage(JSON.stringify({ type: "activity" }));

    void callTool("get_editor_state", {});
    expect(older.sent).toHaveLength(1);
    expect(newer.sent).toHaveLength(0);
  });

  it("rejects a pending call immediately when the socket closes mid-call", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    socket.emitClose();

    await expect(promise).rejects.toThrow("disconnected mid-call");
  });

  it("times out after 30s with no reply", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow("did not respond");
  });

  it("unregisterSession rejects pending calls and drops the session", async () => {
    const socket = new FakeSocket();
    registerSession(socket);
    const promise = callTool("get_editor_state", {});
    unregisterSession(socket);

    await expect(promise).rejects.toThrow("disconnected mid-call");
    expect(sessionCount()).toBe(0);
  });

  it("skips a closed session when picking the most-recently-active one", () => {
    const closed = new FakeSocket();
    const open = new FakeSocket();
    registerSession(closed);
    registerSession(open);
    closed.emitClose(); // closed is now readyState 3, more recently "active" by wall clock but not OPEN

    void callTool("get_editor_state", {});
    expect(open.sent).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails to resolve the module**

Run: `cd pen-editor-backend && npx vitest run test/mcp-bridge.test.ts`
Expected: FAIL — `Cannot find module '../src/mcp/bridge.js'`

- [ ] **Step 3: Implement `src/mcp/bridge.ts`**

```ts
import { randomUUID } from "node:crypto";

// Minimal shape the bridge needs from a WebSocket-like connection. The real
// backend passes @fastify/websocket's underlying `ws` socket (structurally
// compatible: readyState, send, and an EventEmitter-style `on`); tests
// substitute a plain fake object with the same three members.
export interface EditorSocket {
  readyState: number;
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

const OPEN = 1; // ws.WebSocket.OPEN
const CALL_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  socket: EditorSocket;
  lastActiveAt: number;
  pending: Map<string, PendingCall>;
}

interface WireMessage {
  id?: string;
  type: string;
  result?: string;
  error?: string;
}

const sessions = new Map<EditorSocket, Session>();

export const NO_SESSION_MESSAGE =
  "No Pen Editor tab is connected. Open the editor in a browser with MCP enabled (VITE_MCP_WS_TOKEN set).";

function parseMessage(data: unknown): WireMessage | null {
  const text =
    typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as WireMessage).type === "string") {
      return parsed as WireMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function rejectAllPending(session: Session, error: Error): void {
  for (const call of session.pending.values()) {
    clearTimeout(call.timer);
    call.reject(error);
  }
  session.pending.clear();
}

// Registers a newly-connected editor tab. Wires message/close handlers that
// resolve/reject in-flight callTool() promises and track activity for
// most-recently-active routing.
export function registerSession(socket: EditorSocket): void {
  const session: Session = { socket, lastActiveAt: Date.now(), pending: new Map() };
  sessions.set(socket, session);

  socket.on("message", (data) => {
    session.lastActiveAt = Date.now();
    const message = parseMessage(data);
    if (!message || message.type === "activity") return;

    const id = message.id;
    if (!id) return;
    const pendingCall = session.pending.get(id);
    if (!pendingCall) return;

    session.pending.delete(id);
    clearTimeout(pendingCall.timer);

    if (message.type === "tool_result") {
      pendingCall.resolve(message.result ?? "");
    } else if (message.type === "tool_error") {
      pendingCall.reject(new Error(message.error ?? "Tool call failed"));
    }
  });

  socket.on("close", () => {
    rejectAllPending(session, new Error("Editor tab disconnected mid-call."));
    sessions.delete(socket);
  });
}

// Test/production seam for teardown paths that don't go through the
// socket's own "close" event (e.g. explicit server shutdown).
export function unregisterSession(socket: EditorSocket): void {
  const session = sessions.get(socket);
  if (!session) return;
  rejectAllPending(session, new Error("Editor tab disconnected mid-call."));
  sessions.delete(socket);
}

function pickSession(): Session | null {
  let best: Session | null = null;
  for (const session of sessions.values()) {
    if (session.socket.readyState !== OPEN) continue;
    if (!best || session.lastActiveAt > best.lastActiveAt) best = session;
  }
  return best;
}

// Routes a tool call to the most-recently-active connected editor tab and
// waits for its reply (30s timeout). Rejects immediately if no tab is
// connected, and rejects any in-flight call the instant its socket closes.
export function callTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const session = pickSession();
  if (!session) {
    return Promise.reject(new Error(NO_SESSION_MESSAGE));
  }

  const id = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Editor did not respond to "${tool}" within ${CALL_TIMEOUT_MS}ms.`));
    }, CALL_TIMEOUT_MS);

    session.pending.set(id, { resolve, reject, timer });
    session.socket.send(JSON.stringify({ id, type: "tool_call", tool, args }));
  });
}

export function sessionCount(): number {
  return sessions.size;
}

// Test-only: clears all registered sessions and pending calls so tests
// don't leak state into each other via the module-level registry.
export function resetBridgeForTests(): void {
  for (const session of sessions.values()) {
    for (const call of session.pending.values()) clearTimeout(call.timer);
  }
  sessions.clear();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd pen-editor-backend && npx vitest run test/mcp-bridge.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Lint**

Run: `cd pen-editor-backend && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
cd pen-editor-backend
git add src/mcp/bridge.ts test/mcp-bridge.test.ts
git commit -m "feat(mcp): add editor session bridge (registry, MRU routing, timeout, disconnect rejection)"
```

---

### Task 5: `src/mcp/server.ts` — curated `McpServer` with bridged + static tools

**Files:**
- Create: `pen-editor-backend/src/mcp/server.ts`

**Interfaces:**
- Consumes: `getEditorStateInputShape`, `batchGetInputShape`, `snapshotLayoutInputShape`, `getVariablesInputShape`, `setVariablesInputShape`, `batchDesignInputShape`, `BATCH_DESIGN_DESCRIPTION`, `makeBatchDesignInputSchema`, `getGuidelinesImpl`, `getStyleGuideTagsImpl`, `getStyleGuideImpl` from `../ai/tools.js` (Task 2); `callTool` from `./bridge.js` (Task 4).
- Produces (consumed by Task 6's `src/mcp/routes.ts` and Task 8's contract test):
  - `export const BRIDGED_TOOL_NAMES: readonly ["get_editor_state", "batch_get", "snapshot_layout", "get_variables", "get_screenshot", "batch_design", "set_variables"]`
  - `export const STATIC_TOOL_NAMES: readonly ["get_guidelines", "get_style_guide_tags", "get_style_guide"]`
  - `export function buildMcpServer(): McpServer`

- [ ] **Step 1: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BATCH_DESIGN_DESCRIPTION,
  batchDesignInputShape,
  makeBatchDesignInputSchema,
  getEditorStateInputShape,
  batchGetInputShape,
  snapshotLayoutInputShape,
  getVariablesInputShape,
  setVariablesInputShape,
  getGuidelinesImpl,
  getStyleGuideTagsImpl,
  getStyleGuideImpl,
} from "../ai/tools.js";
import { callTool as callBridgedTool } from "./bridge.js";

// Single source of truth for which tools are bridged to the browser tab vs.
// executed directly on the server — cross-checked by
// test/mcp-tools-contract.test.ts (backend) and pen-editor's
// toolContract.test.ts (frontend).
export const BRIDGED_TOOL_NAMES = [
  "get_editor_state",
  "batch_get",
  "snapshot_layout",
  "get_variables",
  "get_screenshot",
  "batch_design",
  "set_variables",
] as const;

export const STATIC_TOOL_NAMES = ["get_guidelines", "get_style_guide_tags", "get_style_guide"] as const;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

// Wraps a bridged tool call: forwards to the connected editor tab and turns
// any rejection (no session / timeout / mid-call disconnect / a handler
// exception the tab reported as tool_error) into an MCP isError text result
// instead of throwing — a bridge failure must never crash the MCP session.
async function callBridged(tool: string, args: Record<string, unknown>) {
  try {
    const result = await callBridgedTool(tool, args);
    return textResult(result);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

const GET_SCREENSHOT_DESCRIPTION =
  "Take a screenshot of a node for visual verification — enabled only for MCP clients (not the built-in chat agent). " +
  "Omit nodeId to screenshot the current selection (errors if none or more than one node is selected). Returns a PNG image.";

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "pen-editor", version: "1.0.0" });

  server.registerTool(
    "get_editor_state",
    {
      description:
        "Get the current editor state: active .pen file, user selection, top-level nodes, and available components. Call this first — Figma's metadata-first pattern.",
      inputSchema: getEditorStateInputShape,
    },
    (args) => callBridged("get_editor_state", args),
  );

  server.registerTool(
    "batch_get",
    {
      description:
        "Retrieve nodes by id or search pattern, with depth control. Use to inspect structure before modifying.",
      inputSchema: batchGetInputShape,
    },
    (args) => callBridged("batch_get", args),
  );

  server.registerTool(
    "snapshot_layout",
    {
      description:
        "Get computed layout rectangles (positions/sizes after the layout engine runs). Key for design-to-code fidelity — use to check placement, overlap, and clipping.",
      inputSchema: snapshotLayoutInputShape,
    },
    (args) => callBridged("snapshot_layout", args),
  );

  server.registerTool(
    "get_variables",
    {
      description: "Read all design variables (tokens) and themes defined in the .pen file.",
      inputSchema: getVariablesInputShape,
    },
    (args) => callBridged("get_variables", args),
  );

  server.registerTool(
    "get_screenshot",
    {
      description: GET_SCREENSHOT_DESCRIPTION,
      inputSchema: {
        nodeId: z.string().optional().describe("Node to screenshot. Omit to use the current selection."),
      },
    },
    async (args) => {
      let raw: string;
      try {
        raw = await callBridgedTool("get_screenshot", args);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      let parsed: { imageData?: string; error?: string };
      try {
        parsed = JSON.parse(raw) as { imageData?: string; error?: string };
      } catch {
        return errorResult(`Malformed screenshot response: ${raw}`);
      }
      if (parsed.error || !parsed.imageData) {
        return errorResult(parsed.error ?? "No image returned.");
      }

      const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(parsed.imageData);
      if (!match) {
        return errorResult("Screenshot response was not a data URL.");
      }
      const [, mimeType, base64Data] = match;
      return { content: [{ type: "image" as const, data: base64Data, mimeType }] };
    },
  );

  server.registerTool(
    "batch_design",
    {
      description: `${BATCH_DESIGN_DESCRIPTION}\n\nCall get_guidelines(topic: "design-system") first for auto-layout and component-usage rules.`,
      inputSchema: batchDesignInputShape,
    },
    async (rawArgs) => {
      // Reuse the exact same alias-normalization + op-count validation the
      // chat tool uses, instead of duplicating it — registerTool's own
      // raw-shape validation can't run this schema's .transform() refinement.
      const parsed = makeBatchDesignInputSchema().safeParse(rawArgs);
      if (!parsed.success) {
        return errorResult(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return callBridged("batch_design", parsed.data);
    },
  );

  server.registerTool(
    "set_variables",
    {
      description: "Add or update design variables and themes. Merges by default; replace=true overwrites all.",
      inputSchema: setVariablesInputShape,
    },
    (args) => callBridged("set_variables", args),
  );

  server.registerTool(
    "get_guidelines",
    {
      description: "Get design guidelines and rules for a topic (design-system, code, table, tailwind, landing-page).",
      inputSchema: { topic: z.enum(["code", "table", "tailwind", "landing-page", "design-system"]) },
    },
    async ({ topic }) => textResult(JSON.stringify(await getGuidelinesImpl(topic))),
  );

  server.registerTool(
    "get_style_guide_tags",
    {
      description: "Get all available style guide tags. Call before get_style_guide to know which tags to use.",
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(await getStyleGuideTagsImpl())),
  );

  server.registerTool(
    "get_style_guide",
    {
      description: "Get a style guide for design inspiration, by tags or by name.",
      inputSchema: { tags: z.array(z.string()).optional(), name: z.string().optional() },
    },
    async (args) => textResult(JSON.stringify(await getStyleGuideImpl(args))),
  );

  return server;
}
```

- [ ] **Step 2: Type-check**

Run: `cd pen-editor-backend && npx tsc --noEmit`
Expected: PASS. If `McpServer.registerTool`'s callback signature differs from `(args) => Promise<CallToolResult>` in the installed SDK version, fix the mismatch here (e.g. an added `extra` second parameter is fine to ignore) — full correctness is verified end-to-end by Task 7's integration test using a real MCP client.

- [ ] **Step 3: Lint**

Run: `cd pen-editor-backend && npm run lint`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
cd pen-editor-backend
git add src/mcp/server.ts
git commit -m "feat(mcp): build curated McpServer (7 bridged + 3 static tools)"
```

(No standalone unit test for this file — it's exercised end-to-end by Task 7's integration test, which is the only way to verify real MCP SDK wiring.)

---

### Task 6: `src/mcp/routes.ts` — HTTP + WS routes with auth, wired into `app.ts`

**Files:**
- Create: `pen-editor-backend/src/mcp/routes.ts`
- Modify: `pen-editor-backend/src/app.ts`

**Interfaces:**
- Consumes: `Config` (incl. `MCP_AUTH_TOKEN`) from `../config.js`; `buildMcpServer` from `./server.js`; `registerSession` from `./bridge.js`; `constantTimeEqual`, `extractBearerToken` from `./auth.js`.
- Produces: `export async function mcpRoutes(app: FastifyInstance, config: Config): Promise<void>` — registers `POST/GET/DELETE/OPTIONS /api/mcp` and `GET /api/mcp/ws` on `app`. Called from `buildApp()` in `app.ts`.

- [ ] **Step 1: Implement `src/mcp/routes.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isOriginAllowed, parseEnvList, type Config } from "../config.js";
import { buildMcpServer } from "./server.js";
import { registerSession } from "./bridge.js";
import { constantTimeEqual, extractBearerToken } from "./auth.js";

export async function mcpRoutes(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(websocketPlugin);

  const allowedOrigins = parseEnvList(config.CORS_ALLOWED_ORIGINS);
  const mcpServer = buildMcpServer();

  function setCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
    const origin = request.headers.origin;
    reply.raw.setHeader("Vary", "Origin");
    if (origin && isOriginAllowed(allowedOrigins, origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
    }
    reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    reply.raw.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  }

  // Returns true and lets the caller proceed, or sends the error response
  // and returns false. MCP_AUTH_TOKEN unset -> 503 (feature off); missing or
  // wrong bearer token -> 401.
  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!config.MCP_AUTH_TOKEN) {
      reply.status(503).send({ error: "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)." });
      return false;
    }
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !constantTimeEqual(token, config.MCP_AUTH_TOKEN)) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  app.options("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    reply.status(204).send();
  });

  app.post("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;

    reply.hijack();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  app.get("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;

    reply.hijack();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw);
  });

  app.delete("/api/mcp", async (request, reply) => {
    setCorsHeaders(request, reply);
    if (!requireAuth(request, reply)) return;
    // Stateless mode (sessionIdGenerator: undefined) has no server-side
    // session to delete.
    reply.status(204).send();
  });

  app.get(
    "/api/mcp/ws",
    {
      websocket: true,
      preValidation: (request, reply, done) => {
        if (!config.MCP_AUTH_TOKEN) {
          reply.status(503).send({ error: "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)." });
          done(new Error("mcp disabled"));
          return;
        }
        const query = request.query as { token?: string };
        if (!query.token || !constantTimeEqual(query.token, config.MCP_AUTH_TOKEN)) {
          reply.status(401).send({ error: "Unauthorized" });
          done(new Error("unauthorized"));
          return;
        }
        done();
      },
    },
    (socket) => {
      registerSession(socket);
    },
  );
}
```

- [ ] **Step 2: Wire `mcpRoutes` into `buildApp`**

In `pen-editor-backend/src/app.ts`, add the import:

```ts
import { mcpRoutes } from "./mcp/routes.js";
```

and, in `buildApp`, after `await generateImageRoutes(app, config);`, add:

```ts
  await mcpRoutes(app, config);
```

- [ ] **Step 3: Build**

Run: `cd pen-editor-backend && npx tsc --noEmit`
Expected: PASS. If `StreamableHTTPServerTransport`'s constructor option name or `handleRequest`'s signature differs from the above in the installed SDK version, fix here to match — verified end-to-end in Task 7.

- [ ] **Step 4: Run the full existing test suite to confirm `/api/chat` and other routes are unaffected**

Run: `cd pen-editor-backend && npm test`
Expected: PASS (no test yet exercises `/api/mcp*`, but every existing route/test must still work with `mcpRoutes` registered).

- [ ] **Step 5: Lint**

Run: `cd pen-editor-backend && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
cd pen-editor-backend
git add src/mcp/routes.ts src/app.ts
git commit -m "feat(mcp): register /api/mcp (streamable HTTP) and /api/mcp/ws routes with bearer/token auth"
```

---

### Task 7: `test/mcp-server.integration.test.ts` — end-to-end MCP round trip + auth matrix

**Files:**
- Create: `pen-editor-backend/test/mcp-server.integration.test.ts`

**Interfaces:**
- Consumes: `buildApp` from `../src/app.js`; `makeConfig` from `./helpers.js`; `sessionCount` from `../src/mcp/bridge.js`; `Client`/`StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`; `WebSocket` from `ws`.

- [ ] **Step 1: Implement the integration test**

Create `pen-editor-backend/test/mcp-server.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { sessionCount } from "../src/mcp/bridge.js";
import { makeConfig } from "./helpers.js";

const TEST_TOKEN = "a".repeat(32);

async function startServer(overrides: Parameters<typeof makeConfig>[0] = {}) {
  const config = makeConfig({ MCP_AUTH_TOKEN: TEST_TOKEN, ...overrides });
  const app = await buildApp(config, { logger: false });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

function wsUrlFor(httpUrl: string, token: string | null): string {
  const base = httpUrl.replace(/^http/, "ws");
  return token ? `${base}/api/mcp/ws?token=${encodeURIComponent(token)}` : `${base}/api/mcp/ws`;
}

// Connects a fake editor tab and answers every tool_call with a canned
// result recognizable by tool name, so tests can assert the round trip
// without a real browser.
function connectFakeEditor(httpUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrlFor(httpUrl, token));
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: string; type: string; tool: string };
      if (message.type !== "tool_call") return;
      const result =
        message.tool === "get_editor_state"
          ? JSON.stringify({ file: "demo.pen" })
          : "{}";
      socket.send(JSON.stringify({ id: message.id, type: "tool_result", result }));
    });
  });
}

async function waitForSessionCount(target: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (sessionCount() !== target) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for session count ${target}, got ${sessionCount()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectMcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP server integration", () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.app.close();
  });

  it("lists the curated tool set and round-trips a bridged + a static call", async () => {
    const editor = await connectFakeEditor(server.url, TEST_TOKEN);
    await waitForSessionCount(1);

    const client = await connectMcpClient(server.url, TEST_TOKEN);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "get_editor_state",
        "batch_get",
        "snapshot_layout",
        "get_variables",
        "get_screenshot",
        "batch_design",
        "set_variables",
        "get_guidelines",
        "get_style_guide_tags",
        "get_style_guide",
      ].sort(),
    );

    const bridged = await client.callTool({
      name: "get_editor_state",
      arguments: { include_schema: false },
    });
    expect(bridged.isError).toBeFalsy();
    expect(JSON.stringify(bridged.content)).toContain("demo.pen");

    const staticResult = await client.callTool({
      name: "get_guidelines",
      arguments: { topic: "design-system" },
    });
    expect(staticResult.isError).toBeFalsy();
    expect(JSON.stringify(staticResult.content)).toContain("Auto-Layout");

    await client.close();
    editor.close();
    await waitForSessionCount(0);
  });

  it("returns an MCP error result, not a crash, when no editor tab is connected", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);

    const result = await client.callTool({ name: "batch_get", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No Pen Editor tab is connected");

    await client.close();
  });

  it("rejects a batch_design call with too many operations before it ever reaches the bridge", async () => {
    const client = await connectMcpClient(server.url, TEST_TOKEN);
    const tooMany = Array.from({ length: 26 }, (_, i) => `D("n${i}")`).join("\n");

    const result = await client.callTool({ name: "batch_design", arguments: { operations: tooMany } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Too many operations");

    await client.close();
  });
});

describe("MCP auth matrix", () => {
  it("returns 503 when MCP_AUTH_TOKEN is unset", async () => {
    const app = await buildApp(makeConfig({ MCP_AUTH_TOKEN: undefined }), { logger: false });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);

    await app.close();
  });

  it("returns 401 for a wrong bearer token", async () => {
    const server = await startServer();

    const res = await fetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);

    await server.app.close();
  });

  it("rejects the WS upgrade when the token is wrong", async () => {
    const server = await startServer();

    await expect(connectFakeEditor(server.url, "wrong-token")).rejects.toBeDefined();

    await server.app.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd pen-editor-backend && npx vitest run test/mcp-server.integration.test.ts`
Expected: PASS. If it fails on an SDK API mismatch (constructor options, `handleRequest` signature, `Client`/`StreamableHTTPClientTransport` import paths), adjust `src/mcp/server.ts`/`src/mcp/routes.ts` from Tasks 5–6 to match the installed `@modelcontextprotocol/sdk` version's actual API, then re-run.

- [ ] **Step 3: Run the full backend suite**

Run: `cd pen-editor-backend && npm test`
Expected: PASS (all suites, including the new MCP ones)

- [ ] **Step 4: Commit**

```bash
cd pen-editor-backend
git add test/mcp-server.integration.test.ts
git commit -m "test(mcp): end-to-end MCP round trip (real client+ws) and auth matrix"
```

---

### Task 8: `test/mcp-tools-contract.test.ts` — hardcoded bridged/static tool-name contract

**Files:**
- Create: `pen-editor-backend/test/mcp-tools-contract.test.ts`

**Interfaces:**
- Consumes: `BRIDGED_TOOL_NAMES`, `STATIC_TOOL_NAMES` from `../src/mcp/server.js`; `penTools` from `../src/ai/tools.js`.

- [ ] **Step 1: Implement the contract test**

Create `pen-editor-backend/test/mcp-tools-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BRIDGED_TOOL_NAMES, STATIC_TOOL_NAMES } from "../src/mcp/server.js";
import { penTools } from "../src/ai/tools.js";

// Contract: the curated MCP tool set is locked here (mirrors
// test/tools-contract.test.ts's convention of a hardcoded name list). The
// frontend's toolContract.test.ts pins the same bridged names on its side —
// update both together when the MCP surface changes.
const EXPECTED_BRIDGED = [
  "get_editor_state",
  "batch_get",
  "snapshot_layout",
  "get_variables",
  "get_screenshot",
  "batch_design",
  "set_variables",
];

const EXPECTED_STATIC = ["get_guidelines", "get_style_guide_tags", "get_style_guide"];

describe("MCP bridged/static tool contract", () => {
  it("bridges exactly the curated v1 tool set", () => {
    expect([...BRIDGED_TOOL_NAMES].sort()).toEqual([...EXPECTED_BRIDGED].sort());
  });

  it("static tools match the curated v1 set", () => {
    expect([...STATIC_TOOL_NAMES].sort()).toEqual([...EXPECTED_STATIC].sort());
  });

  it("every static MCP tool is server-executed in penTools", () => {
    for (const name of STATIC_TOOL_NAMES) {
      const tool = (penTools as Record<string, { execute?: unknown }>)[name];
      expect(typeof tool?.execute, name).toBe("function");
    }
  });

  it("every bridged MCP tool except get_screenshot has a matching penTools schema", () => {
    for (const name of BRIDGED_TOOL_NAMES) {
      if (name === "get_screenshot") continue; // intentionally chat-disabled, MCP-only
      expect(name in penTools, name).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd pen-editor-backend && npx vitest run test/mcp-tools-contract.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 3: Run the full backend suite, lint, and build one more time**

Run: `cd pen-editor-backend && npm test && npm run lint && npm run build`
Expected: all PASS — this closes out the backend half of the feature.

- [ ] **Step 4: Commit**

```bash
cd pen-editor-backend
git add test/mcp-tools-contract.test.ts
git commit -m "test(mcp): pin the bridged/static MCP tool-name contract"
```

---

### Task 9: Backend docs — `CLAUDE.md` connection snippet

**Files:**
- Modify: `pen-editor-backend/CLAUDE.md`

- [ ] **Step 1: Add an "MCP server" section**

Append to `pen-editor-backend/CLAUDE.md` (after the "Trace analysis" section):

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
cd pen-editor-backend
git add CLAUDE.md
git commit -m "docs: document the MCP server and how to connect Claude Code"
```

---

## Part 2 — Frontend (`pen-editor`)

Everything below assumes Part 1 is merged to `pen-editor-backend` `main` first (see Global Constraints).

### Task 10: `src/store/mcpBridgeStore.ts` — bridge status store

**Files:**
- Create: `pen-editor/src/store/mcpBridgeStore.ts`
- Create: `pen-editor/src/store/__tests__/mcpBridgeStore.test.ts`
- Modify: `pen-editor/src/test/fixtures.ts`

**Interfaces:**
- Produces: `export type McpBridgeStatus = "off" | "connecting" | "connected"`; `export const useMcpBridgeStore: UseBoundStore<StoreApi<{ status: McpBridgeStatus; setStatus: (status: McpBridgeStatus) => void }>>` (consumed by Task 12's `mcpBridge.ts` and Task 13's status indicator).

- [ ] **Step 1: Write the failing store test**

Create `pen-editor/src/store/__tests__/mcpBridgeStore.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";

beforeEach(() => {
  useMcpBridgeStore.setState({ status: "off" });
});

describe("mcpBridgeStore", () => {
  it("defaults to off", () => {
    expect(useMcpBridgeStore.getState().status).toBe("off");
  });

  it("setStatus transitions the status", () => {
    useMcpBridgeStore.getState().setStatus("connecting");
    expect(useMcpBridgeStore.getState().status).toBe("connecting");

    useMcpBridgeStore.getState().setStatus("connected");
    expect(useMcpBridgeStore.getState().status).toBe("connected");

    useMcpBridgeStore.getState().setStatus("off");
    expect(useMcpBridgeStore.getState().status).toBe("off");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd pen-editor && npx vitest run src/store/__tests__/mcpBridgeStore.test.ts`
Expected: FAIL — `Cannot find module '@/store/mcpBridgeStore'`

- [ ] **Step 3: Implement `src/store/mcpBridgeStore.ts`**

```ts
import { create } from "zustand";

export type McpBridgeStatus = "off" | "connecting" | "connected";

interface McpBridgeState {
  status: McpBridgeStatus;
  setStatus: (status: McpBridgeStatus) => void;
}

export const useMcpBridgeStore = create<McpBridgeState>((set) => ({
  status: "off",
  setStatus: (status) => set({ status }),
}));
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd pen-editor && npx vitest run src/store/__tests__/mcpBridgeStore.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Reset it in the shared test fixtures**

In `pen-editor/src/test/fixtures.ts`, add the import:

```ts
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";
```

and, inside `resetStores()`, add (near the other single-field stores):

```ts
  useMcpBridgeStore.setState({ status: "off" });
```

- [ ] **Step 6: Run the full frontend suite to confirm no regression**

Run: `cd pen-editor && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd pen-editor
git add src/store/mcpBridgeStore.ts src/store/__tests__/mcpBridgeStore.test.ts src/test/fixtures.ts
git commit -m "feat(mcp): add mcpBridgeStore (off/connecting/connected status)"
```

---

### Task 11: `get_screenshot` handler — optional `nodeId` falls back to selection

**Files:**
- Modify: `pen-editor/src/lib/tools/getScreenshot.ts`
- Create: `pen-editor/src/lib/tools/__tests__/getScreenshot.test.ts`

**Interfaces:**
- Consumes: `useSelectionStore` (`selectedIds: string[]`) from `@/store/selectionStore` (already used elsewhere in the codebase, see Task 2's context).
- Produces: `getScreenshot: ToolHandler` (unchanged signature) now resolves `nodeId` from the current selection when omitted, before doing anything else.

- [ ] **Step 1: Write the failing tests**

Create `pen-editor/src/lib/tools/__tests__/getScreenshot.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getScreenshot } from "@/lib/tools/getScreenshot";
import { useSelectionStore } from "@/store/selectionStore";
import { resetStores, seedScene } from "@/test/fixtures";

beforeEach(() => {
  resetStores();
  seedScene();
});

describe("get_screenshot", () => {
  it("errors when no nodeId is given and nothing is selected", async () => {
    const result = JSON.parse(await getScreenshot({}));
    expect(result.error).toMatch(/nodeId is required/);
  });

  it("errors when no nodeId is given and multiple nodes are selected", async () => {
    useSelectionStore.getState().setSelectedIds(["frame1", "rect1"]);
    const result = JSON.parse(await getScreenshot({}));
    expect(result.error).toMatch(/multiple nodes are selected/);
  });

  it("falls back to the single selected node when nodeId is omitted", async () => {
    useSelectionStore.getState().setSelectedIds(["frame1"]);
    const result = JSON.parse(await getScreenshot({}));
    // No PixiJS renderer is initialized in this unit test environment (per
    // repo convention, get_screenshot's WebGL path is e2e-only) — falling
    // through to the existing "no canvas renderer" branch proves the
    // selected node id (not a validation error) was resolved and used.
    expect(result.error).toBe("No canvas renderer available");
  });

  it("still errors when an explicit nodeId does not exist", async () => {
    const result = JSON.parse(await getScreenshot({ nodeId: "ghost" }));
    expect(result.error).toBe("Node not found: ghost");
  });
});
```

- [ ] **Step 2: Run it and confirm the selection-fallback tests fail**

Run: `cd pen-editor && npx vitest run src/lib/tools/__tests__/getScreenshot.test.ts`
Expected: FAIL on "falls back to the single selected node" (currently returns `{"error":"nodeId is required"}`) and "errors when no nodeId is given and multiple nodes are selected" (same). The other two already pass against current behavior.

- [ ] **Step 3: Implement the selection fallback**

Replace `pen-editor/src/lib/tools/getScreenshot.ts`:

```ts
import { useCanvasRefStore } from "@/store/canvasRefStore";
import { useSceneStore } from "@/store/sceneStore";
import { useSelectionStore } from "@/store/selectionStore";
import { findPixiChild } from "@/utils/pixiUtils";
import type { ToolHandler } from "../toolRegistry";

export const getScreenshot: ToolHandler = async (args) => {
  let nodeId = args.nodeId as string | undefined;

  if (!nodeId) {
    const { selectedIds } = useSelectionStore.getState();
    if (selectedIds.length === 0) {
      return JSON.stringify({ error: "nodeId is required (no node is selected)." });
    }
    if (selectedIds.length > 1) {
      return JSON.stringify({ error: "nodeId is required when multiple nodes are selected." });
    }
    nodeId = selectedIds[0];
  }

  const { nodesById } = useSceneStore.getState();
  if (!nodesById[nodeId]) {
    return JSON.stringify({ error: `Node not found: ${nodeId}` });
  }

  const { pixiRefs } = useCanvasRefStore.getState();
  if (pixiRefs) {
    const { app, sceneRoot } = pixiRefs;
    const target = findPixiChild(sceneRoot, nodeId);
    if (target) {
      try {
        const dataUrl = await app.renderer.extract.base64(target);
        return JSON.stringify({ imageData: `data:image/png;base64,${dataUrl}` });
      } catch (e) {
        return JSON.stringify({
          error: `PixiJS screenshot failed: ${e instanceof Error ? e.message : "unknown error"}`,
        });
      }
    }
    return JSON.stringify({ error: `Node "${nodeId}" not found in PixiJS scene` });
  }

  return JSON.stringify({ error: "No canvas renderer available" });
};
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd pen-editor && npx vitest run src/lib/tools/__tests__/getScreenshot.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full frontend suite (including the tool-contract test)**

Run: `cd pen-editor && npm test`
Expected: PASS — `getScreenshot`'s handler signature is unchanged, so `toolContract.test.ts` is unaffected.

- [ ] **Step 6: Lint**

Run: `cd pen-editor && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
cd pen-editor
git add src/lib/tools/getScreenshot.ts src/lib/tools/__tests__/getScreenshot.test.ts
git commit -m "feat(mcp): get_screenshot falls back to the current selection when nodeId is omitted"
```

---

### Task 12: `src/lib/mcpBridge.ts` — WebSocket client (reconnect, serial queue, activity pings)

**Files:**
- Create: `pen-editor/src/lib/mcpBridge.ts`
- Create: `pen-editor/src/lib/__tests__/mcpBridge.test.ts`

**Interfaces:**
- Consumes: `executeToolCall` from `@/hooks/useDesignChat` (already exported for tests, Task's context confirms `export async function executeToolCall(toolName: string, input: unknown): Promise<string>`); `toolHandlers` from `@/lib/toolRegistry`; `resolveApiUrl` from `@/lib/apiBase`; `useMcpBridgeStore` from `@/store/mcpBridgeStore` (Task 10).
- Produces: `export class McpBridge` with `start(): void` / `stop(): void`, constructor `(token: string, wsFactory?: (url: string) => WebSocket)`; `export function startMcpBridgeIfConfigured(): void` (consumed by Task 13's `main.tsx`).

- [ ] **Step 1: Write the failing bridge tests**

Create `pen-editor/src/lib/__tests__/mcpBridge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpBridge } from "@/lib/mcpBridge";
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";
import { toolHandlers } from "@/lib/toolRegistry";

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  emit(type: string, event: unknown): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

function makeFactory() {
  FakeWebSocket.instances = [];
  return (url: string) => new FakeWebSocket(url) as unknown as WebSocket;
}

beforeEach(() => {
  useMcpBridgeStore.setState({ status: "off" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("McpBridge", () => {
  it("connects and marks the store connected on open", () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();

    expect(useMcpBridgeStore.getState().status).toBe("connecting");
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain("/api/mcp/ws?token=secret-token");

    socket.open();
    expect(useMcpBridgeStore.getState().status).toBe("connected");

    bridge.stop();
  });

  it("dispatches a tool_call into toolHandlers and replies tool_result", async () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const originalHandler = toolHandlers.get_variables;
    toolHandlers.get_variables = vi.fn(async () => '{"variables":[]}');

    socket.message({ id: "call-1", type: "tool_call", tool: "get_variables", args: {} });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    expect(JSON.parse(socket.sent[0])).toEqual({
      id: "call-1",
      type: "tool_result",
      result: '{"variables":[]}',
    });

    toolHandlers.get_variables = originalHandler;
    bridge.stop();
  });

  it("replies tool_error for an unknown tool name without calling any handler", async () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({ id: "call-2", type: "tool_call", tool: "not_a_real_tool", args: {} });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    const reply = JSON.parse(socket.sent[0]);
    expect(reply.type).toBe("tool_error");
    expect(reply.error).toContain("Unknown tool");

    bridge.stop();
  });

  it("serializes concurrent tool calls so a second call waits for the first", async () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    let resolveFirst: (() => void) | undefined;
    const order: string[] = [];
    const originalVariables = toolHandlers.get_variables;
    const originalStyles = toolHandlers.get_styles;
    toolHandlers.get_variables = vi.fn(async () => {
      order.push("start-1");
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      order.push("end-1");
      return "1";
    });
    toolHandlers.get_styles = vi.fn(async () => {
      order.push("start-2");
      return "2";
    });

    socket.message({ id: "call-1", type: "tool_call", tool: "get_variables", args: {} });
    socket.message({ id: "call-2", type: "tool_call", tool: "get_styles", args: {} });

    await vi.waitFor(() => expect(order).toEqual(["start-1"]));
    resolveFirst?.();
    await vi.waitFor(() => expect(order).toEqual(["start-1", "end-1", "start-2"]));

    toolHandlers.get_variables = originalVariables;
    toolHandlers.get_styles = originalStyles;
    bridge.stop();
  });

  it("reconnects with exponential backoff after a close, capped at 30s", () => {
    vi.useFakeTimers();
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close();

    expect(useMcpBridgeStore.getState().status).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(1);

    // First reconnect delay is in [1000, 2000)ms (1s base * [0.5, 1) jitter... 
    // actually [0.5,1) applied to the base gives [500,1000); advancing 1000ms
    // always covers it).
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].close();
    vi.advanceTimersByTime(2_000); // second delay is in [1000, 2000)
    expect(FakeWebSocket.instances).toHaveLength(3);

    bridge.stop();
  });

  it("caps the reconnect delay at 30s even after many failures", () => {
    vi.useFakeTimers();
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();

    for (let i = 0; i < 8; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1].close();
      vi.advanceTimersByTime(30_000); // every delay is <= 30s by construction
    }
    expect(FakeWebSocket.instances.length).toBe(9);

    bridge.stop();
  });

  it("sends an activity ping on window focus while connected", () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    FakeWebSocket.instances[0].open();

    window.dispatchEvent(new Event("focus"));

    const pings = FakeWebSocket.instances[0].sent.map((s) => JSON.parse(s));
    expect(pings).toContainEqual({ type: "activity" });

    bridge.stop();
  });

  it("stop() tears down listeners, closes the socket, and sets status to off", () => {
    const factory = makeFactory();
    const bridge = new McpBridge("secret-token", factory);
    bridge.start();
    FakeWebSocket.instances[0].open();

    bridge.stop();

    expect(useMcpBridgeStore.getState().status).toBe("off");
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);

    // A focus event after stop() must not reconnect or send anything.
    const sentBefore = FakeWebSocket.instances[0].sent.length;
    window.dispatchEvent(new Event("focus"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].sent).toHaveLength(sentBefore);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails to resolve the module**

Run: `cd pen-editor && npx vitest run src/lib/__tests__/mcpBridge.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mcpBridge'`

- [ ] **Step 3: Implement `src/lib/mcpBridge.ts`**

```ts
import { executeToolCall } from "@/hooks/useDesignChat";
import { resolveApiUrl } from "@/lib/apiBase";
import { toolHandlers } from "@/lib/toolRegistry";
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface ToolCallMessage {
  id: string;
  type: "tool_call";
  tool: string;
  args: unknown;
}

function isToolCallMessage(value: unknown): value is ToolCallMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool_call" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { tool?: unknown }).tool === "string"
  );
}

function resolveWsUrl(token: string): string {
  // Same backend base resolution useDesignChat uses (VITE_AI_API_URL /
  // VITE_DESIGN_AGENT_BACKEND_URL), http(s) swapped for ws(s).
  const httpUrl = resolveApiUrl("/api/mcp/ws");
  const wsUrl = httpUrl.replace(/^http/, "ws");
  return `${wsUrl}?token=${encodeURIComponent(token)}`;
}

// WebSocket client for the browser tab side of the MCP bridge. Started once
// from app bootstrap when VITE_MCP_WS_TOKEN is set (see
// startMcpBridgeIfConfigured below). Dispatches incoming tool_call messages
// through the SAME executeToolCall()/toolHandlers path the built-in chat
// uses, so a bridged call has identical semantics (including its own 30s
// timeout) to a chat-originated one.
export class McpBridge {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private queue: Promise<void> = Promise.resolve();
  private readonly token: string;
  private readonly wsFactory: (url: string) => WebSocket;

  constructor(token: string, wsFactory: (url: string) => WebSocket = (url) => new WebSocket(url)) {
    this.token = token;
    this.wsFactory = wsFactory;
  }

  start(): void {
    this.stopped = false;
    window.addEventListener("focus", this.sendActivityPing);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("focus", this.sendActivityPing);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    useMcpBridgeStore.getState().setStatus("off");
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") this.sendActivityPing();
  };

  private sendActivityPing = (): void => {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "activity" }));
    }
  };

  private connect(): void {
    if (this.stopped) return;
    useMcpBridgeStore.getState().setStatus("connecting");
    const socket = this.wsFactory(resolveWsUrl(this.token));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      useMcpBridgeStore.getState().setStatus("connected");
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      this.onMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      useMcpBridgeStore.getState().setStatus("connecting");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.reconnectAttempt);
    const jitter = delay * (0.5 + Math.random() * 0.5);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), jitter);
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (!isToolCallMessage(parsed)) return;

    // Serial queue: concurrent bridged calls must never interleave scene
    // mutations mid-call.
    this.queue = this.queue.then(() => this.handleToolCall(parsed));
  }

  private async handleToolCall(message: ToolCallMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    if (!(message.tool in toolHandlers)) {
      socket.send(JSON.stringify({ id: message.id, type: "tool_error", error: `Unknown tool: ${message.tool}` }));
      return;
    }

    const result = await executeToolCall(message.tool, message.args);
    socket.send(JSON.stringify({ id: message.id, type: "tool_result", result }));
  }
}

let activeBridge: McpBridge | null = null;

// Starts the MCP bridge iff VITE_MCP_WS_TOKEN is set at build time. No-op
// (including on repeat calls) otherwise — the bridge never attempts a
// WebSocket connection when unconfigured.
export function startMcpBridgeIfConfigured(): void {
  const token = import.meta.env.VITE_MCP_WS_TOKEN as string | undefined;
  if (!token || activeBridge) return;
  activeBridge = new McpBridge(token);
  activeBridge.start();
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd pen-editor && npx vitest run src/lib/__tests__/mcpBridge.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Run the full frontend suite**

Run: `cd pen-editor && npm test`
Expected: PASS

- [ ] **Step 6: Lint**

Run: `cd pen-editor && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
cd pen-editor
git add src/lib/mcpBridge.ts src/lib/__tests__/mcpBridge.test.ts
git commit -m "feat(mcp): add mcpBridge WS client (reconnect backoff, serial queue, activity pings)"
```

---

### Task 13: Bootstrap wiring + status indicator UI

**Files:**
- Modify: `pen-editor/src/main.tsx`
- Modify: `pen-editor/src/components/LeftSidebar.tsx`
- Modify: `pen-editor/src/components/__tests__/LeftSidebar.test.tsx`

**Interfaces:**
- Consumes: `startMcpBridgeIfConfigured` from `@/lib/mcpBridge` (Task 12); `useMcpBridgeStore` from `@/store/mcpBridgeStore` (Task 10).

- [ ] **Step 1: Start the bridge from app bootstrap**

In `pen-editor/src/main.tsx`, add the import near the other bootstrap imports:

```ts
import { startMcpBridgeIfConfigured } from '@/lib/mcpBridge'
```

and, right after `initDesktopBridge()`, add:

```ts
startMcpBridgeIfConfigured()
```

- [ ] **Step 2: Write the failing indicator tests**

In `pen-editor/src/components/__tests__/LeftSidebar.test.tsx`, add the import:

```ts
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";
```

and, after the existing `"shows the offline indicator in the Slides section too"` test, add:

```tsx
  it("shows the MCP connected indicator when the bridge is connected", () => {
    useMcpBridgeStore.setState({ status: "connected" });
    useDocumentStore.setState({ fileName: "design.pen" });
    render(<LeftSidebar />);
    expect(screen.getByLabelText("MCP connected")).toBeTruthy();
  });

  it("shows the MCP connecting indicator while reconnecting", () => {
    useMcpBridgeStore.setState({ status: "connecting" });
    useDocumentStore.setState({ fileName: "design.pen" });
    render(<LeftSidebar />);
    expect(screen.getByLabelText("MCP connecting")).toBeTruthy();
  });

  it("hides the MCP indicator when the bridge is off", () => {
    useMcpBridgeStore.setState({ status: "off" });
    useDocumentStore.setState({ fileName: "design.pen" });
    render(<LeftSidebar />);
    expect(screen.queryByLabelText("MCP connected")).toBeNull();
    expect(screen.queryByLabelText("MCP connecting")).toBeNull();
  });
```

- [ ] **Step 3: Run the tests and confirm the two positive-case tests fail**

Run: `cd pen-editor && npx vitest run src/components/__tests__/LeftSidebar.test.tsx`
Expected: FAIL on "shows the MCP connected indicator..." and "...connecting indicator..." (no such element exists yet); the "hides..." test and all prior tests already pass.

- [ ] **Step 4: Add the indicator to `LeftSidebar.tsx`**

In `pen-editor/src/components/LeftSidebar.tsx`, add the import:

```ts
import { useMcpBridgeStore } from "@/store/mcpBridgeStore";
```

inside the `LeftSidebar` component, alongside the existing `const isOnline = useOnlineStatus();` line, add:

```ts
  const mcpStatus = useMcpBridgeStore((s) => s.status);
```

and, in the JSX, immediately after the existing offline-indicator block (the `{!isOnline && ( <Tooltip> ... </Tooltip> )}` block that renders `CloudSlash`), add a sibling block:

```tsx
          {mcpStatus !== "off" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={mcpStatus === "connected" ? "MCP connected" : "MCP connecting"}
                    className="shrink-0 flex items-center"
                  >
                    <span
                      className={
                        "h-1.5 w-1.5 rounded-full " +
                        (mcpStatus === "connected" ? "bg-green-500" : "bg-yellow-500")
                      }
                    />
                  </span>
                }
              />
              <TooltipContent side="bottom">
                {mcpStatus === "connected" ? "MCP connected" : "MCP connecting…"}
              </TooltipContent>
            </Tooltip>
          )}
```

(Both blocks live inside the same `{(activeSection === "pages" || activeSection === "slides") && ( <div className="px-2 pb-2 flex items-center gap-1"> ... </div> )}` row as the file name, so the two indicators — offline cloud and MCP dot — sit side by side next to the file name in both the Pages and Slides sections.)

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd pen-editor && npx vitest run src/components/__tests__/LeftSidebar.test.tsx`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 6: Run the full frontend suite, lint, and build**

Run: `cd pen-editor && npm test && npm run lint && npm run build`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
cd pen-editor
git add src/main.tsx src/components/LeftSidebar.tsx src/components/__tests__/LeftSidebar.test.tsx
git commit -m "feat(mcp): start the bridge from app bootstrap and show a connection-status indicator"
```

---

### Task 14: Extend the tool-name contract test for bridged MCP tools

**Files:**
- Modify: `pen-editor/src/lib/__tests__/toolContract.test.ts`

**Interfaces:**
- Consumes: `toolHandlers` from `@/lib/toolRegistry` (already imported in this file).

- [ ] **Step 1: Add the bridged-tool contract block**

In `pen-editor/src/lib/__tests__/toolContract.test.ts`, after the closing of `describe("tool registry contract", ...)` and before the `backendToolsPath` block, add:

```ts
// MCP bridged tool names (pen-editor-backend/src/mcp/server.ts
// BRIDGED_TOOL_NAMES) — duplicated here rather than imported, matching this
// file's existing convention of hardcoding the backend's tool-name list on
// this side of the contract; pen-editor-backend/test/mcp-tools-contract.test.ts
// pins the same list on the backend side.
const EXPECTED_BRIDGED_MCP_TOOLS = [
  "get_editor_state",
  "batch_get",
  "snapshot_layout",
  "get_variables",
  "get_screenshot",
  "batch_design",
  "set_variables",
];

describe("MCP bridged tool contract", () => {
  it("every bridged MCP tool name has a toolHandlers entry", () => {
    for (const name of EXPECTED_BRIDGED_MCP_TOOLS) {
      expect(name in toolHandlers, name).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd pen-editor && npx vitest run src/lib/__tests__/toolContract.test.ts`
Expected: PASS (all existing tests plus the new one — `get_screenshot` is already a `toolHandlers` entry from before this feature, so no frontend handler additions were needed for this particular check)

- [ ] **Step 3: Run the full frontend suite**

Run: `cd pen-editor && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd pen-editor
git add src/lib/__tests__/toolContract.test.ts
git commit -m "test(mcp): pin the bridged MCP tool-name contract on the frontend side"
```

---

### Task 15: Frontend docs — `.env.example` and `CLAUDE.md`

**Files:**
- Modify: `pen-editor/.env.example`
- Modify: `pen-editor/CLAUDE.md`

- [ ] **Step 1: Document `VITE_MCP_WS_TOKEN`**

Append to `pen-editor/.env.example`:

```
# MCP bridge (optional) — connects this tab to the backend's /api/mcp/ws so
# external MCP clients (Claude Code, claude.ai, Cursor, ...) can read/edit
# the live document. Must match the backend's MCP_AUTH_TOKEN. Unset = the
# bridge never attempts a connection.
# VITE_MCP_WS_TOKEN=
```

- [ ] **Step 2: Add a short section to `pen-editor/CLAUDE.md`**

Append a new section (e.g. after "Desktop shell bridge" under Architecture):

```markdown
### MCP bridge

`src/lib/mcpBridge.ts` connects this tab to the backend's `/api/mcp/ws`
(started once from `main.tsx` iff `VITE_MCP_WS_TOKEN` is set) so external
MCP clients can drive the editor through the same `toolHandlers` the
built-in chat uses. `src/store/mcpBridgeStore.ts` tracks
`off | connecting | connected`, shown as a small dot next to the file name
in `LeftSidebar.tsx` (beside the offline cloud indicator). See
`pen-editor-backend/CLAUDE.md`'s "MCP server" section and
`pen-editor-backend/docs/superpowers/specs/2026-07-23-mcp-server-design.md`
for the full design.
```

- [ ] **Step 3: Commit**

```bash
cd pen-editor
git add .env.example CLAUDE.md
git commit -m "docs: document VITE_MCP_WS_TOKEN and the MCP bridge"
```

---

## Rollout order (matches the spec)

1. Backend Tasks 1–9 → merge to `pen-editor-backend` `main` (goes green independently — its CI never checks out `pen-editor`).
2. Frontend Tasks 10–15 → merge to `pen-editor` `main` (its `contract` CI job checks out the backend's `main` at run time; keep the gap between the two merges short per the root `CLAUDE.md` tool-contract rule).
3. Live smoke test (manual, end of project — not automatable in CI):
   - `cd pen-editor-backend && MCP_AUTH_TOKEN=$(openssl rand -hex 24) npm run dev`
   - `claude mcp add --transport http pen-editor http://localhost:3001/api/mcp --header "Authorization: Bearer <token>"`
   - `cd pen-editor && VITE_MCP_WS_TOKEN=<same token> npm run dev`, open the editor in a browser, confirm the MCP status dot turns green.
   - From Claude Code: `get_editor_state` → `get_screenshot` → a `batch_design` edit, and confirm the edit appears live on canvas.
4. Independent SemVer bump per repo (per the repo's versioning convention) once the live smoke passes.

## Self-review notes

- **Spec coverage:** every bullet in the design doc's Architecture/Backend/Frontend/Curated-tool-set/Error-handling/Testing/Rollout sections maps to a task above (config, bridge routing+timeout+disconnect, HTTP+WS routes+auth+CORS, all 10 tools with the exact descriptions/behaviors called out, `get_screenshot`'s image-content conversion and selection fallback, the bridged-tool schema reuse via the Task 2 refactor, both contract tests, both docs updates, the manual live-smoke step).
- **Judgment calls made where the spec left room** (flagged for the plan's consumer):
  - The spec says schemas are "imported/reused from `src/ai/tools.ts`"; since MCP's `registerTool` needs a raw `ZodRawShape` but `batch_design`'s real validation (alias normalization, 25-op cap) lives in a `.transform()`, Task 5's `batch_design` MCP tool calls `makeBatchDesignInputSchema().safeParse()` itself inside the handler (reusing the *function*, not just the *shape*) rather than relying on `registerTool`'s lighter raw-shape check alone.
  - The frontend bridge's wire contract ("Reject tool names not present in `toolHandlers`" as `tool_error`) is implemented as an explicit `in toolHandlers` pre-check in `mcpBridge.ts`, separate from `executeToolCall`'s own internal try/catch (which never throws — it already encodes handler-level failures as a JSON `{"error":...}` *string* result, matching how the built-in chat already treats tool exceptions). This keeps "unknown tool" as a real `tool_error` while everything else stays `tool_result`, consistent with existing chat semantics.
  - `src/mcp/routes.ts` sets CORS headers manually (mirroring `chat.ts`'s hijacked-reply pattern) rather than modifying the shared `@fastify/cors` plugin config, since `/api/mcp` is hijacked the same way `/api/chat` is.
- **Placeholder scan:** the only non-literal content is Task 2 Step 6's `/* the exact existing "..." string value, unchanged */` markers — these mark a verbatim cut-and-paste of text the implementing engineer already has open in the current `tools.ts`, not new content to invent; every other code block in this plan is complete and runnable as written.
- **Type consistency:** `EditorSocket`/`registerSession`/`unregisterSession`/`callTool`/`sessionCount`/`resetBridgeForTests`/`NO_SESSION_MESSAGE` (Task 4) are used with identical names/signatures in Task 5 (`server.ts`), Task 6 (`routes.ts`), and Task 7 (integration test). `BRIDGED_TOOL_NAMES`/`STATIC_TOOL_NAMES` (Task 5) match Task 8's and Task 14's hardcoded lists exactly. `McpBridge`/`startMcpBridgeIfConfigured` (Task 12) match their usage in Task 13. `useMcpBridgeStore`'s `status`/`setStatus` (Task 10) match every consumer in Tasks 12–13.
