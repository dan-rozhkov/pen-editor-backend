# Clio-Style Trace Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect design-agent session traces in Postgres (Aiven), then run a worker that PII-strips, summarizes, LLM-clusters them and renders Markdown reports for agent improvement.

**Architecture:** The chat backend fire-and-forget-writes raw traces to a `raw_traces` table in `onFinish` (feature inert without `TRACE_DATABASE_URL`). A separate idempotent CLI worker (`npm run analyze`, `src/analysis/`) assembles sessions, sanitizes (regex → LLM constraints → regex output validation), summarizes with a cheap OpenRouter model via `generateObject`, clusters all summaries with one LLM call, writes a Markdown report, and enforces the raw-trace TTL. Spec: `docs/superpowers/specs/2026-07-15-trace-analysis-design.md`.

**Tech Stack:** Fastify 5, AI SDK v6 (`ai` / `generateObject`), zod 3, `pg` (node-postgres), pgvector on Aiven, Vitest (mocked LLM via `MockLanguageModelV3`, mocked pg — no real network/DB in tests), tsx for the worker.

## Global Constraints

- Repo: `pen-editor-backend` unless a task says `pen-editor` (frontend, sibling checkout, separate git repo).
- ESM + NodeNext: **relative imports must include `.js`** even in `.ts` source.
- TypeScript strict, `noUnusedLocals`, `noUnusedParameters`. `npm run lint` must stay at 0 errors.
- Tests: Vitest in `test/` (backend) — no real API keys, no real Postgres, no network. Mock the LLM with `MockLanguageModelV3` from `ai/test` (see `test/chat-route.test.ts`), mock `pg` with plain objects.
- Trace writing must NEVER affect the chat response (fire-and-forget, errors only `console.error`).
- New env vars (all optional, chat server works without them): `TRACE_DATABASE_URL`, `TRACE_RAW_TTL_DAYS` (default 14), `ANALYSIS_MODEL` (default `google/gemini-2.5-flash`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL` (default `text-embedding-004`).
- Permanent tables must never contain unsanitized user content. Only `raw_traces` (TTL-bound) holds raw data.
- Commit after every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (new/modified)

```
pen-editor-backend/
├── src/
│   ├── config.ts                      # MODIFY: new env vars
│   ├── app.ts                         # MODIFY: create/inject TraceStore, close on shutdown
│   ├── routes/chat.ts                 # MODIFY: read body.id, write raw traces
│   ├── tracing/
│   │   └── traceStore.ts              # NEW: pg pool + writeRawTrace (used by chat route)
│   └── analysis/
│       ├── migrations/001_init.sql    # NEW: schema
│       ├── migrate.ts                 # NEW: idempotent SQL migration runner
│       ├── pii.ts                     # NEW: regex scrubber + validator (pure)
│       ├── assemble.ts                # NEW: session assembly + text rendering (pure)
│       ├── summarize.ts               # NEW: generateObject summarizer + PII guard
│       ├── embeddings.ts              # NEW: optional Gemini embedder
│       ├── cluster.ts                 # NEW: LLM clustering
│       ├── report.ts                  # NEW: Markdown report renderer (pure)
│       └── run.ts                     # NEW: CLI orchestrator (npm run analyze)
├── test/
│   ├── helpers.ts                     # MODIFY: new config fields
│   ├── pii.test.ts                    # NEW
│   ├── trace-store.test.ts            # NEW
│   ├── chat-trace.test.ts             # NEW (integration)
│   ├── migrate.test.ts                # NEW
│   ├── assemble.test.ts               # NEW
│   ├── summarize.test.ts              # NEW
│   ├── embeddings.test.ts             # NEW
│   ├── cluster.test.ts                # NEW
│   └── report.test.ts                 # NEW
├── package.json                       # MODIFY: pg dep, analyze script, build copies migrations
├── .env.example                       # MODIFY: new vars
├── .gitignore                         # MODIFY: reports/
└── CLAUDE.md                          # MODIFY: document the analysis subsystem

pen-editor/  (separate repo)
└── src/hooks/__tests__/useDesignChat.test.ts   # MODIFY: pin stable body.id contract
```

---

### Task 1: Config vars + `pg` dependency

**Files:**
- Modify: `src/config.ts` (envSchema, after `IMAGE_GENERATION_TIMEOUT_MS`)
- Modify: `test/helpers.ts`
- Modify: `package.json`
- Test: `test/load-config.test.ts` (extend existing file)

**Interfaces:**
- Produces: `Config` gains `TRACE_DATABASE_URL?: string`, `TRACE_RAW_TTL_DAYS: number`, `ANALYSIS_MODEL: string`, `EMBEDDINGS_API_KEY?: string`, `EMBEDDINGS_MODEL: string`. All later tasks consume these via `Config`.

- [ ] **Step 1: Write the failing test** — append to `test/load-config.test.ts` (follow the file's existing pattern for setting `process.env` in tests):

```ts
it("defaults trace/analysis vars and accepts overrides", () => {
  // within the file's existing env-stubbing pattern:
  const config = loadConfig();
  expect(config.TRACE_DATABASE_URL).toBeUndefined();
  expect(config.TRACE_RAW_TTL_DAYS).toBe(14);
  expect(config.ANALYSIS_MODEL).toBe("google/gemini-2.5-flash");
  expect(config.EMBEDDINGS_MODEL).toBe("text-embedding-004");

  process.env.TRACE_RAW_TTL_DAYS = "7";
  process.env.TRACE_DATABASE_URL = "postgres://u:p@h:5432/db?sslmode=no-verify";
  const overridden = loadConfig();
  expect(overridden.TRACE_RAW_TTL_DAYS).toBe(7);
  expect(overridden.TRACE_DATABASE_URL).toContain("postgres://");
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- load-config` → FAIL (properties don't exist / defaults missing).

- [ ] **Step 3: Implement** — in `src/config.ts` add to `envSchema` (after `IMAGE_GENERATION_TIMEOUT_MS`):

```ts
  // --- Trace analysis (all optional; chat server works without them) ---
  // Postgres for raw traces + analysis artifacts (Aiven: append ?sslmode=no-verify —
  // TLS-encrypted, skips CA verification of Aiven's project CA).
  TRACE_DATABASE_URL: z.string().optional(),
  TRACE_RAW_TTL_DAYS: z.coerce.number().default(14),
  ANALYSIS_MODEL: z.string().default("google/gemini-2.5-flash"),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default("text-embedding-004"),
```

In `test/helpers.ts` `makeConfig`, add before `...overrides`:

```ts
    TRACE_DATABASE_URL: undefined,
    TRACE_RAW_TTL_DAYS: 14,
    ANALYSIS_MODEL: "google/gemini-2.5-flash",
    EMBEDDINGS_API_KEY: undefined,
    EMBEDDINGS_MODEL: "text-embedding-004",
```

Install dep: `npm install pg && npm install -D @types/pg`.

- [ ] **Step 4: Run tests** — `npm test -- load-config` → PASS; `npm run lint` → 0 errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): trace/analysis env vars and pg dependency"`

---

### Task 2: PII scrubber (`src/analysis/pii.ts`)

**Files:**
- Create: `src/analysis/pii.ts`
- Test: `test/pii.test.ts`

**Interfaces:**
- Produces: `scrubPii(text: string): string` (replaces PII with typed placeholders), `containsPii(text: string): boolean` (true if scrubbing would change the text). Consumed by Tasks 7 and 11.

- [ ] **Step 1: Write the failing test** — `test/pii.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scrubPii, containsPii } from "../src/analysis/pii.js";

describe("scrubPii", () => {
  it("replaces emails", () => {
    expect(scrubPii("contact john.doe+x@example.com please")).toBe(
      "contact [EMAIL] please",
    );
  });
  it("replaces phone numbers", () => {
    expect(scrubPii("call +7 (912) 345-67-89 now")).toBe("call [PHONE] now");
  });
  it("replaces API keys/tokens", () => {
    expect(scrubPii("use sk-abcdefghij1234567890abcd")).toBe("use [TOKEN]");
    expect(scrubPii("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe("[TOKEN]");
  });
  it("replaces credentials embedded in URLs, keeping the scheme", () => {
    expect(scrubPii("https://user:pass@db.example.com/x")).toBe(
      "https://[CREDENTIALS]@db.example.com/x",
    );
  });
  it("drops base64 data URLs entirely", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(200)}`;
    expect(scrubPii(`img ${dataUrl} end`)).toBe("img [DATA_URL] end");
  });
  it("replaces long high-entropy blobs", () => {
    expect(scrubPii(`x ${"Qq1".repeat(30)} y`)).toBe("x [BLOB] y");
  });
  it("leaves normal design-agent text untouched", () => {
    const text =
      "User asked to create a 3-column pricing frame; batch_design failed with 'Too many operations (30)'.";
    expect(scrubPii(text)).toBe(text);
    expect(containsPii(text)).toBe(false);
  });
});

describe("containsPii", () => {
  it("detects PII", () => {
    expect(containsPii("mail me at a@b.co")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- pii` → FAIL (module not found).
- [ ] **Step 3: Implement** — `src/analysis/pii.ts`:

```ts
// Regex PII scrubber — layer (a) of the three-layer defense described in the
// spec. Order matters: data URLs and URL credentials are matched before the
// generic email/token/blob rules would mangle them. All regexes use /g and are
// applied via String.replace (never .test, which is stateful for /g).
const RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{50,}/gi, replacement: "[DATA_URL]" },
  { re: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: "$1[CREDENTIALS]@" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[EMAIL]" },
  // Common secret prefixes (OpenAI/Stripe-style sk-, GitHub ghp_/gho_/ghs_, Slack xox*)
  { re: /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[bpas])[-_][A-Za-z0-9_-]{16,}\b/g, replacement: "[TOKEN]" },
  // Long unbroken base64-ish blobs (embedded images, signatures, keys)
  { re: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: "[BLOB]" },
  // Phone numbers: 10+ digits with separators, not part of a larger number/decimal
  { re: /(?<![\d.])\+?\d[\d ().-]{8,}\d(?![\d.])/g, replacement: "[PHONE]" },
];

export function scrubPii(text: string): string {
  return RULES.reduce((acc, rule) => acc.replace(rule.re, rule.replacement), text);
}

export function containsPii(text: string): boolean {
  return scrubPii(text) !== text;
}
```

- [ ] **Step 4: Run tests** — `npm test -- pii` → PASS. If a regex over/under-matches, fix the regex, not the test intent.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): regex PII scrubber and validator"`

---

### Task 3: Trace store (`src/tracing/traceStore.ts`)

**Files:**
- Create: `src/tracing/traceStore.ts`
- Test: `test/trace-store.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces (used by Tasks 4, 5):

```ts
export interface RawTracePayload { messages: unknown[]; steps: unknown[]; systemPromptHash: string; }
export interface RawTraceRow {
  sessionId: string; model: string; agentMode: string;
  payload: RawTracePayload; streamError: string | null;
  inputTokens: number; outputTokens: number;
}
export interface TraceStore { writeRawTrace(row: RawTraceRow): Promise<void>; close(): Promise<void>; }
export function createTraceStore(config: Config, pool?: TraceQueryable): TraceStore | null;
export function writeRawTraceSafe(store: TraceStore, row: RawTraceRow): void;
export interface TraceQueryable { query(sql: string, params?: unknown[]): Promise<unknown>; end(): Promise<void>; }
```

- [ ] **Step 1: Write the failing test** — `test/trace-store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createTraceStore,
  writeRawTraceSafe,
  type RawTraceRow,
  type TraceQueryable,
} from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

function fakePool(): TraceQueryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    }),
    end: vi.fn(async () => {}),
  };
}

const row: RawTraceRow = {
  sessionId: "tab-1-1",
  model: "google/gemini-2.5-flash",
  agentMode: "edits",
  payload: { messages: [{ role: "user" }], steps: [], systemPromptHash: "abc" },
  streamError: null,
  inputTokens: 10,
  outputTokens: 5,
};

describe("createTraceStore", () => {
  it("returns null when TRACE_DATABASE_URL is not set", () => {
    expect(createTraceStore(makeConfig())).toBeNull();
  });

  it("inserts a raw_traces row with jsonb payload", async () => {
    const pool = fakePool();
    const store = createTraceStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    await store!.writeRawTrace(row);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toContain("INSERT INTO raw_traces");
    expect(pool.calls[0].params?.[0]).toBe("tab-1-1");
    expect(JSON.parse(pool.calls[0].params?.[3] as string)).toEqual(row.payload);
  });
});

describe("writeRawTraceSafe", () => {
  it("swallows write errors (fire-and-forget)", async () => {
    const store = {
      writeRawTrace: vi.fn(async () => {
        throw new Error("db down");
      }),
      close: async () => {},
    };
    expect(() => writeRawTraceSafe(store, row)).not.toThrow();
    await vi.waitFor(() => expect(store.writeRawTrace).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- trace-store` → FAIL (module not found).
- [ ] **Step 3: Implement** — `src/tracing/traceStore.ts`:

```ts
import pg from "pg";
import type { Config } from "../config.js";

export interface RawTracePayload {
  messages: unknown[];
  steps: unknown[];
  systemPromptHash: string;
}

export interface RawTraceRow {
  sessionId: string;
  model: string;
  agentMode: string;
  payload: RawTracePayload;
  streamError: string | null;
  inputTokens: number;
  outputTokens: number;
}

// Minimal query surface so tests can pass a fake instead of a real pg.Pool.
export interface TraceQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export interface TraceStore {
  writeRawTrace(row: RawTraceRow): Promise<void>;
  close(): Promise<void>;
}

export function createTraceStore(
  config: Config,
  pool?: TraceQueryable,
): TraceStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable =
    pool ??
    (() => {
      const p = new pg.Pool({
        connectionString: config.TRACE_DATABASE_URL,
        max: 3,
      });
      // Idle-client errors must never crash the chat server.
      p.on("error", (err) => console.error("[trace] pool error:", err.message));
      return p;
    })();

  return {
    async writeRawTrace(row) {
      await db.query(
        `INSERT INTO raw_traces
           (session_id, model, agent_mode, payload, stream_error, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          row.sessionId,
          row.model,
          row.agentMode,
          JSON.stringify(row.payload),
          row.streamError,
          row.inputTokens,
          row.outputTokens,
        ],
      );
    },
    close: () => db.end(),
  };
}

export function writeRawTraceSafe(store: TraceStore, row: RawTraceRow): void {
  store.writeRawTrace(row).catch((err) => {
    console.error("[trace] failed to write raw trace:", err);
  });
}
```

- [ ] **Step 4: Run tests** — `npm test -- trace-store` → PASS; `npm run lint` → 0 errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(tracing): raw trace store with fire-and-forget writes"`

---

### Task 4: Wire trace writing into the chat route

**Files:**
- Modify: `src/routes/chat.ts`
- Modify: `src/app.ts`
- Test: `test/chat-trace.test.ts`

**Interfaces:**
- Consumes: `TraceStore`, `writeRawTraceSafe`, `RawTraceRow` (Task 3).
- Produces: `chatRoutes(app, config, traceStore?: TraceStore | null)` — third optional param, default `null`. `buildApp` creates the store from config; `BuildAppOptions` gains `traceStore?: TraceStore | null` for test injection.

- [ ] **Step 1: Write the failing test** — `test/chat-trace.test.ts`. Reuse the exact mock/server pattern from `test/chat-route.test.ts` (copy its `holders`, `vi.mock` blocks for `../src/ai/provider.js` and `../src/ai/mcp.js`, `USAGE`, `textStreamChunks`, `mockModel`, `startServer`, `userMessage`, `postChat` helpers — they are file-local there). Differences: `startServer` passes a `traceStore` via `buildApp` options.

```ts
// ...copied mocks/helpers from chat-route.test.ts...
import { buildApp } from "../src/app.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";

function recordingTraceStore(): TraceStore & { rows: RawTraceRow[] } {
  const rows: RawTraceRow[] = [];
  return {
    rows,
    writeRawTrace: async (row) => {
      rows.push(row);
    },
    close: async () => {},
  };
}

describe("chat route trace writing", () => {
  it("writes a raw trace row with the client session id after a completed stream", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const app = await buildApp(makeConfig(), { logger: false, traceStore: store });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await postChat(url, {
      id: "tab-123-1",
      messages: [userMessage("hello")],
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so onFinish fires
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].sessionId).toBe("tab-123-1");
    expect(store.rows[0].agentMode).toBe("edits");
    expect(store.rows[0].payload.messages).toHaveLength(1);
    expect(store.rows[0].payload.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
    await app.close();
  });

  it("generates a fallback session id when the body has no id", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const app = await buildApp(makeConfig(), { logger: false, traceStore: store });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    await (await postChat(url, { messages: [userMessage("hello")] })).text();
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].sessionId).toMatch(/^anon-/);
    await app.close();
  });

  it("a throwing trace store does not break the chat response", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store: TraceStore = {
      writeRawTrace: async () => {
        throw new Error("db down");
      },
      close: async () => {},
    };
    const app = await buildApp(makeConfig(), { logger: false, traceStore: store });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await postChat(url, { id: "tab-1-1", messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hi"); // stream completed normally
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- chat-trace` → FAIL (`traceStore` option unknown / no rows written).
- [ ] **Step 3: Implement.**

`src/app.ts` — accept/create the store and close it on shutdown:

```ts
import { createTraceStore, type TraceStore } from "./tracing/traceStore.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  // Test seam: inject a fake trace store. `undefined` = create from config,
  // `null` = explicitly disabled.
  traceStore?: TraceStore | null;
}

// inside buildApp, before chatRoutes:
  const traceStore =
    options.traceStore !== undefined
      ? options.traceStore
      : createTraceStore(config);
  if (traceStore) {
    app.addHook("onClose", async () => {
      await traceStore.close();
    });
  }
  await chatRoutes(app, config, traceStore);
```

`src/routes/chat.ts`:

1. Extend the body schema (the AI SDK's `DefaultChatTransport` already sends `id`):

```ts
const chatBodySchema = z.object({
  id: z.string().max(200).optional(),
  messages: z.array(z.record(z.unknown())).min(1, "messages must not be empty"),
  canvasContext: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
});
```

2. Change the signature: `export async function chatRoutes(app: FastifyInstance, config: Config, traceStore: TraceStore | null = null)`. Import `createHash` from `node:crypto`, and `writeRawTraceSafe`, `type TraceStore` from `../tracing/traceStore.js`.

3. In the handler, after parsing: `const { id: chatSessionId, messages, ... } = parsed.data;` and near `const system = ...`:

```ts
    const traceSessionId = chatSessionId ?? `anon-${randomUUID()}`;
    const systemPromptHash = createHash("sha256")
      .update(system)
      .digest("hex")
      .slice(0, 16);
```

4. In `onFinish`, build `logSteps` **once** (move the existing `steps.map(...)` mapping out of the `if (config.ENABLE_AGENT_LOGGING)` block so both the file logger and the trace store share it; the `.logs/` write stays behind its flag). Then append:

```ts
        if (traceStore) {
          writeRawTraceSafe(traceStore, {
            sessionId: traceSessionId,
            model: selectedModelId,
            agentMode,
            payload: {
              // Full incoming history: client-tool results/errors from prior
              // turns live here; storing the system prompt itself is redundant
              // (hash identifies the prompt version).
              messages: messages as unknown[],
              steps: logSteps,
              systemPromptHash,
            },
            streamError: null,
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          });
        }
```

5. Record stream errors: in the `pipeUIMessageStreamToResponse` call, wrap `onError`:

```ts
    result.pipeUIMessageStreamToResponse(reply.raw, {
      onError: (error) => {
        if (traceStore) {
          writeRawTraceSafe(traceStore, {
            sessionId: traceSessionId,
            model: selectedModelId,
            agentMode,
            payload: { messages: messages as unknown[], steps: [], systemPromptHash },
            streamError: error instanceof Error ? error.message : String(error),
            inputTokens: 0,
            outputTokens: 0,
          });
        }
        return streamErrorMessage(error);
      },
    });
```

6. In `onAbort({ steps })` (existing callback), add a trace write with `streamError: "client-aborted"`, `steps: []`-payload analogous to step 5 (usage is not available there; use zeros).

- [ ] **Step 4: Run tests** — `npm test -- chat-trace` → PASS, then full `npm test` → all green (existing chat-route tests must not regress; they call `chatRoutes` via `buildApp` with `traceStore` unset → `createTraceStore` returns `null` because `makeConfig()` has no `TRACE_DATABASE_URL`... note: `buildApp` options in old tests don't set `traceStore`, so it's created from config = null — inert). `npm run lint` → 0 errors.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(tracing): write raw session traces from the chat route"`

---

### Task 5: Schema migrations (`001_init.sql` + `migrate.ts`)

**Files:**
- Create: `src/analysis/migrations/001_init.sql`
- Create: `src/analysis/migrate.ts`
- Modify: `package.json` (build script copies migrations to dist, like skills)
- Test: `test/migrate.test.ts`

**Interfaces:**
- Produces: `migrate(client: QueryClient, dir?: string): Promise<string[]>` (applied file names); `interface QueryClient { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }`. Consumed by Task 11.

- [ ] **Step 1: Write the failing test** — `test/migrate.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, type QueryClient } from "../src/analysis/migrate.js";

function fakeClient(appliedNames: string[] = []) {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const client: QueryClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params });
      if (sql.includes("SELECT 1 FROM schema_migrations")) {
        return { rows: appliedNames.includes(params?.[0] as string) ? [1] : [] };
      }
      return { rows: [] };
    }),
  };
  return { client, executed };
}

async function makeMigrationsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrations-"));
  await writeFile(join(dir, "002_second.sql"), "CREATE TABLE two (id int);");
  await writeFile(join(dir, "001_first.sql"), "CREATE TABLE one (id int);");
  return dir;
}

describe("migrate", () => {
  it("applies pending migrations in sorted order inside transactions", async () => {
    const { client, executed } = fakeClient();
    const applied = await migrate(client, await makeMigrationsDir());
    expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
    const sqls = executed.map((e) => e.sql);
    expect(sqls.filter((s) => s === "BEGIN")).toHaveLength(2);
    expect(sqls.filter((s) => s === "COMMIT")).toHaveLength(2);
    expect(sqls.indexOf("CREATE TABLE one (id int);")).toBeLessThan(
      sqls.indexOf("CREATE TABLE two (id int);"),
    );
  });

  it("skips already-applied migrations", async () => {
    const { client } = fakeClient(["001_first.sql"]);
    const applied = await migrate(client, await makeMigrationsDir());
    expect(applied).toEqual(["002_second.sql"]);
  });

  it("rolls back and rethrows on failure", async () => {
    const dir = await makeMigrationsDir();
    const executed: string[] = [];
    const client: QueryClient = {
      query: vi.fn(async (sql: string) => {
        executed.push(sql);
        if (sql.startsWith("CREATE TABLE one")) throw new Error("boom");
        return { rows: [] };
      }),
    };
    await expect(migrate(client, dir)).rejects.toThrow("boom");
    expect(executed).toContain("ROLLBACK");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- migrate` → FAIL (module not found).
- [ ] **Step 3: Implement.**

`src/analysis/migrations/001_init.sql` (exact content — this is the whole schema from the spec):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS raw_traces (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  model         TEXT        NOT NULL,
  agent_mode    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  stream_error  TEXT,
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS raw_traces_session_idx ON raw_traces (session_id, created_at);
CREATE INDEX IF NOT EXISTS raw_traces_created_idx ON raw_traces (created_at);

CREATE TABLE IF NOT EXISTS session_summaries (
  id               BIGSERIAL PRIMARY KEY,
  session_id       TEXT        NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_goal        TEXT        NOT NULL,
  summary          TEXT        NOT NULL,
  outcome          TEXT        NOT NULL CHECK (outcome IN ('success','partial','failure','unclear')),
  tool_errors      JSONB       NOT NULL DEFAULT '[]',
  frustration      BOOLEAN     NOT NULL DEFAULT false,
  model            TEXT        NOT NULL,
  agent_mode       TEXT        NOT NULL,
  step_count       INTEGER     NOT NULL DEFAULT 0,
  embedding        vector(768),
  pii_check_passed BOOLEAN     NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_days   INTEGER,
  summary_count INTEGER     NOT NULL,
  model         TEXT        NOT NULL,
  report_md     TEXT        NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  name        TEXT   NOT NULL,
  description TEXT   NOT NULL,
  size        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_clusters (
  cluster_id BIGINT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  summary_id BIGINT NOT NULL REFERENCES session_summaries(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, summary_id)
);
```

`src/analysis/migrate.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export interface QueryClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export async function migrate(
  client: QueryClient,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rows } = await client.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [file],
    );
    if (rows.length > 0) continue;
    const sql = await readFile(join(dir, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    applied.push(file);
  }
  return applied;
}
```

`package.json` build script (migrations must exist in dist like skills do):

```json
"build": "tsc && rm -rf dist/skills && cp -R src/skills dist/skills && rm -rf dist/analysis/migrations && cp -R src/analysis/migrations dist/analysis/migrations",
```

- [ ] **Step 4: Run tests** — `npm test -- migrate` → PASS; `npm run build` → dist contains `analysis/migrations/001_init.sql`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): postgres schema and migration runner"`

---

### Task 6: Session assembly (`src/analysis/assemble.ts`)

**Files:**
- Create: `src/analysis/assemble.ts`
- Test: `test/assemble.test.ts`

**Interfaces:**
- Produces (consumed by Task 11):

```ts
export interface RawTraceDbRow {
  id: number; session_id: string; created_at: Date; model: string; agent_mode: string;
  payload: { messages?: unknown[]; steps?: unknown[]; systemPromptHash?: string };
  stream_error: string | null; input_tokens: number; output_tokens: number;
}
export interface AssembledSession {
  sessionId: string; model: string; agentMode: string;
  startedAt: Date; endedAt: Date; requestCount: number;
  messages: unknown[]; streamErrors: string[]; stepCount: number;
  totalInputTokens: number; totalOutputTokens: number;
}
export function assembleSession(rows: RawTraceDbRow[]): AssembledSession;
export function renderSessionText(session: AssembledSession, maxChars?: number): string; // default 60_000
```

- [ ] **Step 1: Write the failing test** — `test/assemble.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assembleSession,
  renderSessionText,
  type RawTraceDbRow,
} from "../src/analysis/assemble.js";

function row(overrides: Partial<RawTraceDbRow>): RawTraceDbRow {
  return {
    id: 1,
    session_id: "tab-1-1",
    created_at: new Date("2026-07-15T10:00:00Z"),
    model: "google/gemini-2.5-flash",
    agent_mode: "edits",
    payload: { messages: [], steps: [] },
    stream_error: null,
    input_tokens: 10,
    output_tokens: 5,
    ...overrides,
  };
}

const userMsg = { role: "user", parts: [{ type: "text", text: "make a card" }] };
const toolErrorMsg = {
  role: "assistant",
  parts: [
    {
      type: "tool-batch_design",
      toolCallId: "c1",
      state: "output-available",
      input: { operations: [] },
      output: '{"error":"Too many operations (30). Maximum is 25."}',
    },
  ],
};

describe("assembleSession", () => {
  it("uses the longest message history and merges stream errors from all rows", () => {
    const rows: RawTraceDbRow[] = [
      row({ id: 1, payload: { messages: [userMsg], steps: [{}] } }),
      row({
        id: 2,
        created_at: new Date("2026-07-15T10:01:00Z"),
        payload: { messages: [userMsg, toolErrorMsg, userMsg], steps: [{}, {}] },
        stream_error: "An error occurred.",
        input_tokens: 20,
        output_tokens: 7,
      }),
    ];
    const s = assembleSession(rows);
    expect(s.messages).toHaveLength(3);
    expect(s.requestCount).toBe(2);
    expect(s.streamErrors).toEqual(["An error occurred."]);
    expect(s.stepCount).toBe(3);
    expect(s.totalInputTokens).toBe(30);
    expect(s.totalOutputTokens).toBe(12);
    expect(s.startedAt.toISOString()).toBe("2026-07-15T10:00:00.000Z");
    expect(s.endedAt.toISOString()).toBe("2026-07-15T10:01:00.000Z");
  });
});

describe("renderSessionText", () => {
  it("renders roles, text, tool calls with errors, and stream errors; omits images", () => {
    const s = assembleSession([
      row({
        payload: {
          messages: [
            userMsg,
            { role: "user", parts: [{ type: "file", mediaType: "image/png", url: "data:..." }] },
            toolErrorMsg,
          ],
          steps: [],
        },
        stream_error: "boom",
      }),
    ]);
    const text = renderSessionText(s);
    expect(text).toContain("user: make a card");
    expect(text).toContain("[image omitted]");
    expect(text).toContain("[tool batch_design]");
    expect(text).toContain("Too many operations");
    expect(text).toContain("Stream errors:\nboom");
    expect(text).not.toContain("data:");
  });

  it("truncates to maxChars keeping head and tail", () => {
    const long = {
      role: "user",
      parts: [{ type: "text", text: "x".repeat(2000) }],
    };
    const s = assembleSession([
      row({ payload: { messages: Array.from({ length: 100 }, () => long), steps: [] } }),
    ]);
    const text = renderSessionText(s, 10_000);
    expect(text.length).toBeLessThanOrEqual(10_100);
    expect(text).toContain("[...truncated...]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- assemble` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/assemble.ts`:

```ts
export interface RawTraceDbRow {
  id: number;
  session_id: string;
  created_at: Date;
  model: string;
  agent_mode: string;
  payload: { messages?: unknown[]; steps?: unknown[]; systemPromptHash?: string };
  stream_error: string | null;
  input_tokens: number;
  output_tokens: number;
}

export interface AssembledSession {
  sessionId: string;
  model: string;
  agentMode: string;
  startedAt: Date;
  endedAt: Date;
  requestCount: number;
  messages: unknown[];
  streamErrors: string[];
  stepCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// Later requests of a session carry the entire prior history (split-execution:
// client-tool results/errors ride along in `messages`), so the row with the
// longest history IS the session transcript.
export function assembleSession(rows: RawTraceDbRow[]): AssembledSession {
  if (rows.length === 0) throw new Error("assembleSession: no rows");
  const sorted = [...rows].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const longest = sorted.reduce((best, r) =>
    (r.payload.messages?.length ?? 0) >= (best.payload.messages?.length ?? 0)
      ? r
      : best,
  );
  const last = sorted[sorted.length - 1];
  return {
    sessionId: last.session_id,
    model: last.model,
    agentMode: last.agent_mode,
    startedAt: sorted[0].created_at,
    endedAt: last.created_at,
    requestCount: sorted.length,
    messages: longest.payload.messages ?? [],
    streamErrors: sorted
      .map((r) => r.stream_error)
      .filter((e): e is string => Boolean(e)),
    stepCount: sorted.reduce((n, r) => n + (r.payload.steps?.length ?? 0), 0),
    totalInputTokens: sorted.reduce((n, r) => n + r.input_tokens, 0),
    totalOutputTokens: sorted.reduce((n, r) => n + r.output_tokens, 0),
  };
}

const MAX_PART_CHARS = 1_500;

function clip(value: unknown, max = MAX_PART_CHARS): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function renderPart(part: Record<string, unknown>): string | null {
  const type = String(part.type ?? "");
  if (type === "text") return clip(part.text);
  if (type === "file" || type === "image") return "[image omitted]";
  if (type === "reasoning") return null;
  if (type.startsWith("tool-") || type === "dynamic-tool") {
    const name =
      type === "dynamic-tool" ? String(part.toolName ?? "?") : type.slice(5);
    const input = part.input === undefined ? "" : ` input: ${clip(part.input, 500)}`;
    const output =
      part.output === undefined ? "" : ` output: ${clip(part.output, 1000)}`;
    return `[tool ${name}]${input}${output}`;
  }
  return null;
}

export function renderSessionText(
  session: AssembledSession,
  maxChars = 60_000,
): string {
  const lines: string[] = [];
  for (const msg of session.messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const parts = Array.isArray(m.parts) ? m.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const rendered = renderPart(part as Record<string, unknown>);
      if (rendered) lines.push(`${role}: ${rendered}`);
    }
  }
  if (session.streamErrors.length > 0) {
    lines.push(`Stream errors:\n${session.streamErrors.join("\n")}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}
```

- [ ] **Step 4: Run tests** — `npm test -- assemble` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): session assembly and transcript rendering"`

---

### Task 7: Summarizer with PII guard (`src/analysis/summarize.ts`)

**Files:**
- Create: `src/analysis/summarize.ts`
- Test: `test/summarize.test.ts`

**Interfaces:**
- Consumes: `scrubPii`, `containsPii` (Task 2).
- Produces (consumed by Task 11):

```ts
export const sessionSummarySchema: z.ZodObject<...>; // { user_goal, summary, outcome, tool_errors, frustration }
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export async function summarizeWithPiiGuard(
  model: LanguageModel, sessionText: string, maxRetries?: number, // default 2
): Promise<{ summary: SessionSummary; piiCheckPassed: boolean }>;
```

- [ ] **Step 1: Write the failing test** — `test/summarize.test.ts`. Mock model helper for `generateObject` (v6 `doGenerate` returns `content` array):

```ts
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  summarizeWithPiiGuard,
  sessionSummarySchema,
} from "../src/analysis/summarize.js";

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const cleanSummary = {
  user_goal: "Create a pricing page frame",
  summary:
    "User asked for a 3-column pricing layout; the agent created frames but batch_design failed once with an operation-limit error, then succeeded after splitting.",
  outcome: "partial",
  tool_errors: [{ tool: "batch_design", error: "operation limit exceeded" }],
  frustration: false,
};

function objectModel(objects: Array<Record<string, unknown>>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: "text", text: JSON.stringify(objects[Math.min(call++, objects.length - 1)]) },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("summarizeWithPiiGuard", () => {
  it("returns a validated summary when output is clean", async () => {
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([cleanSummary]),
      "user: make a pricing page",
    );
    expect(piiCheckPassed).toBe(true);
    expect(summary.outcome).toBe("partial");
    expect(summary.tool_errors[0].tool).toBe("batch_design");
  });

  it("retries when the summary contains PII, then succeeds", async () => {
    const dirty = { ...cleanSummary, summary: "User john@example.com asked for a card." };
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([dirty, cleanSummary]),
      "text",
    );
    expect(piiCheckPassed).toBe(true);
    expect(summary.summary).not.toContain("john@example.com");
  });

  it("after exhausting retries, scrubs fields and marks pii_check failed", async () => {
    const dirty = { ...cleanSummary, summary: "Email john@example.com leaked." };
    const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
      objectModel([dirty]),
      "text",
      1,
    );
    expect(piiCheckPassed).toBe(false);
    expect(summary.summary).toContain("[EMAIL]");
    expect(summary.summary).not.toContain("john@example.com");
  });

  it("schema rejects unknown outcome values", () => {
    expect(
      sessionSummarySchema.safeParse({ ...cleanSummary, outcome: "great" }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- summarize` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/summarize.ts`:

```ts
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { containsPii, scrubPii } from "./pii.js";

export const sessionSummarySchema = z.object({
  user_goal: z
    .string()
    .describe("What the user was trying to accomplish, as a general pattern"),
  summary: z
    .string()
    .describe("What happened in the session: agent actions, failures, recovery"),
  outcome: z.enum(["success", "partial", "failure", "unclear"]),
  tool_errors: z.array(
    z.object({
      tool: z.string().describe("Tool name"),
      error: z.string().describe("Error category, not the verbatim message"),
    }),
  ),
  frustration: z
    .boolean()
    .describe("User showed frustration (repeats, complaints, giving up)"),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

// Clio principle: the summary describes BEHAVIOR PATTERNS, never content.
const SUMMARIZER_SYSTEM = `You analyze a trace of a session between a user and an AI design agent that edits a canvas via tools.

Produce a structured summary for aggregate analysis. STRICT PRIVACY RULES:
- Never include personal names, emails, phone numbers, addresses, company names, or credentials.
- Never quote user text verbatim. Describe what the user did, not what they wrote.
- Describe design content generically ("a landing page hero", "a pricing table"), never specific copy.
- tool_errors: report the tool name and a short error CATEGORY (e.g. "operation limit exceeded", "unknown node id"), not raw error payloads.`;

async function summarizeOnce(
  model: LanguageModel,
  sessionText: string,
): Promise<SessionSummary> {
  const { object } = await generateObject({
    model,
    schema: sessionSummarySchema,
    system: SUMMARIZER_SYSTEM,
    prompt: scrubPii(sessionText),
  });
  return object;
}

function summaryText(s: SessionSummary): string {
  return [s.user_goal, s.summary, ...s.tool_errors.map((e) => `${e.tool} ${e.error}`)].join("\n");
}

function scrubSummary(s: SessionSummary): SessionSummary {
  return {
    ...s,
    user_goal: scrubPii(s.user_goal),
    summary: scrubPii(s.summary),
    tool_errors: s.tool_errors.map((e) => ({
      tool: scrubPii(e.tool),
      error: scrubPii(e.error),
    })),
  };
}

export async function summarizeWithPiiGuard(
  model: LanguageModel,
  sessionText: string,
  maxRetries = 2,
): Promise<{ summary: SessionSummary; piiCheckPassed: boolean }> {
  let last: SessionSummary | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await summarizeOnce(model, sessionText);
    if (!containsPii(summaryText(last))) {
      return { summary: last, piiCheckPassed: true };
    }
  }
  // Last resort: hard-scrub the fields so nothing raw persists, and flag it.
  return { summary: scrubSummary(last!), piiCheckPassed: false };
}
```

- [ ] **Step 4: Run tests** — `npm test -- summarize` → PASS. (If `generateObject` + `MockLanguageModelV3` needs a different content shape, mirror whatever `ai@6` expects — check `node_modules/ai/test` typings; adjust the test helper, not the module API.)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): session summarizer with three-layer PII guard"`

---

### Task 8: Optional embedder (`src/analysis/embeddings.ts`)

**Files:**
- Create: `src/analysis/embeddings.ts`
- Test: `test/embeddings.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces (consumed by Task 11): `interface Embedder { embed(text: string): Promise<number[]> }`, `createEmbedder(config: Config, fetchFn?: typeof fetch): Embedder | null` (null when `EMBEDDINGS_API_KEY` unset).

- [ ] **Step 1: Write the failing test** — `test/embeddings.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createEmbedder } from "../src/analysis/embeddings.js";
import { makeConfig } from "./helpers.js";

describe("createEmbedder", () => {
  it("returns null without an API key", () => {
    expect(createEmbedder(makeConfig())).toBeNull();
  });

  it("calls the Gemini embedContent endpoint and returns values", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ embedding: { values: [0.1, 0.2] } }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const embedder = createEmbedder(
      makeConfig({ EMBEDDINGS_API_KEY: "k", EMBEDDINGS_MODEL: "text-embedding-004" }),
      fetchFn,
    );
    const values = await embedder!.embed("hello");
    expect(values).toEqual([0.1, 0.2]);
    const url = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain("models/text-embedding-004:embedContent");
    expect(url).not.toContain("key=k"); // key travels in a header, not the URL
  });

  it("throws on non-OK responses and on missing values", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const embedder = createEmbedder(makeConfig({ EMBEDDINGS_API_KEY: "k" }), bad);
    await expect(embedder!.embed("x")).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- embeddings` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/embeddings.ts`:

```ts
import type { Config } from "../config.js";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

// Gemini embeddings REST API (OpenRouter has no stable embeddings endpoint).
// text-embedding-004 returns 768 dims — matches vector(768) in the schema.
export function createEmbedder(
  config: Config,
  fetchFn: typeof fetch = fetch,
): Embedder | null {
  const apiKey = config.EMBEDDINGS_API_KEY;
  if (!apiKey) return null;
  const model = config.EMBEDDINGS_MODEL;
  return {
    async embed(text) {
      const res = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        },
      );
      if (!res.ok) {
        throw new Error(`Embeddings API error: ${res.status}`);
      }
      const json = (await res.json()) as { embedding?: { values?: number[] } };
      const values = json.embedding?.values;
      if (!Array.isArray(values)) {
        throw new Error("Embeddings API returned no values");
      }
      return values;
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npm test -- embeddings` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): optional Gemini embedder for summaries"`

---

### Task 9: LLM clustering (`src/analysis/cluster.ts`)

**Files:**
- Create: `src/analysis/cluster.ts`
- Test: `test/cluster.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 10, 11):

```ts
export interface SummaryItem { id: number; summary: string }
export interface ClusterAssignment { name: string; description: string; summaryIds: number[] }
export async function clusterSummaries(model: LanguageModel, items: SummaryItem[]): Promise<ClusterAssignment[]>;
```

- [ ] **Step 1: Write the failing test** — `test/cluster.test.ts` (reuse the `objectModel` helper shape from `test/summarize.test.ts` — copy it locally):

```ts
import { describe, expect, it } from "vitest";
import { clusterSummaries } from "../src/analysis/cluster.js";
// ...local objectModel helper identical to test/summarize.test.ts...

const items = [
  { id: 1, summary: "batch_design failed with operation limit" },
  { id: 2, summary: "batch_design failed with unknown node id" },
  { id: 3, summary: "successful landing page creation" },
];

describe("clusterSummaries", () => {
  it("returns clusters and routes unassigned/invalid ids to Unclustered", async () => {
    const model = objectModel([
      {
        clusters: [
          {
            name: "batch_design failures",
            description: "Sessions where batch_design rejected operations",
            summary_ids: [1, 2, 99], // 99 is invalid — must be dropped
          },
        ],
      },
    ]);
    const clusters = await clusterSummaries(model, items);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].name).toBe("batch_design failures");
    expect(clusters[0].summaryIds).toEqual([1, 2]);
    expect(clusters[1].name).toBe("Unclustered");
    expect(clusters[1].summaryIds).toEqual([3]);
  });

  it("assigns each summary to exactly one cluster (first wins on duplicates)", async () => {
    const model = objectModel([
      {
        clusters: [
          { name: "A", description: "a", summary_ids: [1, 2] },
          { name: "B", description: "b", summary_ids: [2, 3] },
        ],
      },
    ]);
    const clusters = await clusterSummaries(model, items);
    expect(clusters.find((c) => c.name === "A")!.summaryIds).toEqual([1, 2]);
    expect(clusters.find((c) => c.name === "B")!.summaryIds).toEqual([3]);
    expect(clusters.find((c) => c.name === "Unclustered")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- cluster` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/cluster.ts`:

```ts
import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

export interface SummaryItem {
  id: number;
  summary: string;
}

export interface ClusterAssignment {
  name: string;
  description: string;
  summaryIds: number[];
}

const clusteringSchema = z.object({
  clusters: z.array(
    z.object({
      name: z.string().describe("Short cluster name (a problem or pattern)"),
      description: z.string().describe("1-2 sentences: what unites these sessions"),
      summary_ids: z.array(z.number()),
    }),
  ),
});

const CLUSTERING_SYSTEM = `You group session summaries of an AI design agent into clusters of recurring problems and usage patterns, to guide agent improvements.

Rules:
- Prefer clusters that are ACTIONABLE for improving the agent (recurring tool failures, misunderstood requests, workflow friction) over generic topical groups.
- 3-10 clusters for typical inputs; small inputs may yield fewer.
- Every summary id should appear in exactly one cluster.
- Cluster names/descriptions must not contain personal data or verbatim quotes.`;

export async function clusterSummaries(
  model: LanguageModel,
  items: SummaryItem[],
): Promise<ClusterAssignment[]> {
  const prompt = items.map((i) => `[${i.id}] ${i.summary}`).join("\n\n");
  const { object } = await generateObject({
    model,
    schema: clusteringSchema,
    system: CLUSTERING_SYSTEM,
    prompt,
  });

  const validIds = new Set(items.map((i) => i.id));
  const seen = new Set<number>();
  const result: ClusterAssignment[] = [];
  for (const c of object.clusters) {
    const ids = c.summary_ids.filter((id) => validIds.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (ids.length > 0) {
      result.push({ name: c.name, description: c.description, summaryIds: ids });
    }
  }
  const leftover = items.map((i) => i.id).filter((id) => !seen.has(id));
  if (leftover.length > 0) {
    result.push({
      name: "Unclustered",
      description: "Sessions the model did not assign to any cluster",
      summaryIds: leftover,
    });
  }
  return result;
}
```

- [ ] **Step 4: Run tests** — `npm test -- cluster` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): LLM clustering of session summaries"`

---

### Task 10: Report renderer (`src/analysis/report.ts`)

**Files:**
- Create: `src/analysis/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Produces (consumed by Task 11):

```ts
export interface ReportCluster { name: string; description: string; size: number; examples: string[] }
export interface ReportInput {
  date: string;                                  // "2026-07-15"
  windowDays: number | null;                     // null = all time
  summaryCount: number;
  clusters: ReportCluster[];
  previousClusters: Array<{ name: string; size: number }>;  // [] if no prior run
  outcomes: Record<string, number>;              // outcome -> count
  toolErrors: Array<{ tool: string; error: string; count: number }>;
}
export function renderReport(input: ReportInput): string;  // Markdown
```

- [ ] **Step 1: Write the failing test** — `test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderReport, type ReportInput } from "../src/analysis/report.js";

const input: ReportInput = {
  date: "2026-07-15",
  windowDays: null,
  summaryCount: 5,
  clusters: [
    { name: "Small", description: "d1", size: 1, examples: ["e1"] },
    { name: "batch_design failures", description: "d2", size: 4, examples: ["e2", "e3"] },
  ],
  previousClusters: [{ name: "batch_design failures", size: 2 }],
  outcomes: { success: 2, failure: 3 },
  toolErrors: [{ tool: "batch_design", error: "operation limit", count: 3 }],
};

describe("renderReport", () => {
  it("orders clusters by size desc and marks deltas vs previous run", () => {
    const md = renderReport(input);
    const bd = md.indexOf("batch_design failures");
    const small = md.indexOf("## Small");
    expect(bd).toBeGreaterThan(-1);
    expect(bd).toBeLessThan(small);
    expect(md).toContain("+2 vs previous run"); // 4 vs 2
    expect(md).toContain("(new)"); // "Small" absent from previous run
  });

  it("includes header, outcomes and tool errors", () => {
    const md = renderReport(input);
    expect(md).toContain("# Agent Trace Analysis — 2026-07-15");
    expect(md).toContain("Window: all time");
    expect(md).toContain("Sessions analyzed: 5");
    expect(md).toContain("| failure | 3 |");
    expect(md).toContain("| batch_design | operation limit | 3 |");
    expect(md).toContain("- e2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- report` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/report.ts`:

```ts
export interface ReportCluster {
  name: string;
  description: string;
  size: number;
  examples: string[];
}

export interface ReportInput {
  date: string;
  windowDays: number | null;
  summaryCount: number;
  clusters: ReportCluster[];
  previousClusters: Array<{ name: string; size: number }>;
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
}

function delta(cluster: ReportCluster, prev: Map<string, number>): string {
  if (!prev.size) return "";
  const before = prev.get(cluster.name);
  if (before === undefined) return " (new)";
  const d = cluster.size - before;
  if (d === 0) return " (unchanged)";
  return ` (${d > 0 ? "+" : ""}${d} vs previous run)`;
}

export function renderReport(input: ReportInput): string {
  const prev = new Map(input.previousClusters.map((c) => [c.name, c.size]));
  const clusters = [...input.clusters].sort((a, b) => b.size - a.size);
  const lines: string[] = [
    `# Agent Trace Analysis — ${input.date}`,
    "",
    `Window: ${input.windowDays === null ? "all time" : `last ${input.windowDays} days`}`,
    `Sessions analyzed: ${input.summaryCount}`,
    "",
    "## Outcomes",
    "",
    "| Outcome | Count |",
    "|---|---|",
    ...Object.entries(input.outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Top tool errors",
    "",
    "| Tool | Error | Count |",
    "|---|---|---|",
    ...input.toolErrors
      .sort((a, b) => b.count - a.count)
      .map((e) => `| ${e.tool} | ${e.error} | ${e.count} |`),
    "",
    "# Clusters",
  ];
  for (const c of clusters) {
    lines.push(
      "",
      `## ${c.name}`,
      "",
      `**${c.size} session(s)**${delta(c, prev)}`,
      "",
      c.description,
      "",
      ...c.examples.map((e) => `- ${e}`),
    );
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 4: Run tests** — `npm test -- report` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(analysis): markdown report renderer"`

---### Task 11: Worker orchestrator (`src/analysis/run.ts`) + scripts/docs

**Files:**
- Create: `src/analysis/run.ts`
- Modify: `package.json` (add `"analyze": "tsx --env-file=.env src/analysis/run.ts"` to scripts)
- Modify: `.env.example` (document new vars)
- Modify: `.gitignore` (add `reports/`)
- Modify: `CLAUDE.md` (short section on the analysis subsystem)
- Test: `test/analysis-run.test.ts` (pure helpers only)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: `parseWindowDays(argv: string[]): number | null` and `tally(summaries)` exported for tests; `main()` not exported.

The orchestrator is deliberately thin — every step is a tested module; `main()` is glue and is exercised manually against a real Aiven instance (documented below), mirroring how the repo treats other side-effectful entry points.

- [ ] **Step 1: Write the failing test** — `test/analysis-run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWindowDays, tally } from "../src/analysis/run.js";

describe("parseWindowDays", () => {
  it("parses --window-days=30 and defaults to null", () => {
    expect(parseWindowDays(["node", "run.ts", "--window-days=30"])).toBe(30);
    expect(parseWindowDays(["node", "run.ts"])).toBeNull();
    expect(parseWindowDays(["node", "run.ts", "--window-days=abc"])).toBeNull();
  });
});

describe("tally", () => {
  it("counts outcomes and tool errors", () => {
    const rows = [
      { outcome: "failure", tool_errors: [{ tool: "batch_design", error: "limit" }] },
      { outcome: "failure", tool_errors: [{ tool: "batch_design", error: "limit" }] },
      { outcome: "success", tool_errors: [] },
    ];
    const { outcomes, toolErrors } = tally(rows);
    expect(outcomes).toEqual({ failure: 2, success: 1 });
    expect(toolErrors).toEqual([{ tool: "batch_design", error: "limit", count: 2 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test -- analysis-run` → FAIL.
- [ ] **Step 3: Implement** — `src/analysis/run.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createModel } from "../ai/provider.js";
import { migrate } from "./migrate.js";
import { assembleSession, renderSessionText, type RawTraceDbRow } from "./assemble.js";
import { summarizeWithPiiGuard } from "./summarize.js";
import { createEmbedder } from "./embeddings.js";
import { clusterSummaries } from "./cluster.js";
import { renderReport } from "./report.js";

export function parseWindowDays(argv: string[]): number | null {
  const arg = argv.find((a) => a.startsWith("--window-days="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface TallyRow {
  outcome: string;
  tool_errors: Array<{ tool: string; error: string }>;
}

export function tally(rows: TallyRow[]): {
  outcomes: Record<string, number>;
  toolErrors: Array<{ tool: string; error: string; count: number }>;
} {
  const outcomes: Record<string, number> = {};
  const errCounts = new Map<string, { tool: string; error: string; count: number }>();
  for (const row of rows) {
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    for (const e of row.tool_errors) {
      const key = `${e.tool} ${e.error}`;
      const entry = errCounts.get(key) ?? { tool: e.tool, error: e.error, count: 0 };
      entry.count += 1;
      errCounts.set(key, entry);
    }
  }
  return {
    outcomes,
    toolErrors: [...errCounts.values()].sort((a, b) => b.count - a.count),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TRACE_DATABASE_URL) {
    console.error("[analyze] TRACE_DATABASE_URL is required");
    process.exit(1);
  }
  const windowDays = parseWindowDays(process.argv);
  const pool = new pg.Pool({ connectionString: config.TRACE_DATABASE_URL, max: 3 });
  try {
    const applied = await migrate(pool);
    if (applied.length) console.log(`[analyze] applied migrations: ${applied.join(", ")}`);
    const model = createModel(config, config.ANALYSIS_MODEL);
    const embedder = createEmbedder(config);

    // 1. Summarize completed, not-yet-summarized sessions (quiet for 30+ min).
    const { rows: pending } = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM raw_traces rt
       WHERE NOT EXISTS (
         SELECT 1 FROM session_summaries ss WHERE ss.session_id = rt.session_id
       )
       GROUP BY session_id
       HAVING max(created_at) < now() - interval '30 minutes'
       ORDER BY 1`,
    );
    console.log(`[analyze] ${pending.length} session(s) to summarize`);
    for (const { session_id } of pending) {
      const { rows } = await pool.query<RawTraceDbRow>(
        "SELECT * FROM raw_traces WHERE session_id = $1 ORDER BY created_at",
        [session_id],
      );
      const session = assembleSession(rows);
      const { summary, piiCheckPassed } = await summarizeWithPiiGuard(
        model,
        renderSessionText(session),
      );
      let embedding: string | null = null;
      if (embedder && piiCheckPassed) {
        try {
          embedding = `[${(await embedder.embed(summary.summary)).join(",")}]`;
        } catch (err) {
          console.warn(`[analyze] embedding failed for ${session_id}:`, err);
        }
      }
      await pool.query(
        `INSERT INTO session_summaries
           (session_id, user_goal, summary, outcome, tool_errors, frustration,
            model, agent_mode, step_count, embedding, pii_check_passed)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::vector,$11)
         ON CONFLICT (session_id) DO NOTHING`,
        [
          session_id,
          summary.user_goal,
          summary.summary,
          summary.outcome,
          JSON.stringify(summary.tool_errors),
          summary.frustration,
          session.model,
          session.agentMode,
          session.stepCount,
          embedding,
          piiCheckPassed,
        ],
      );
      console.log(`[analyze] summarized ${session_id}: ${summary.outcome}`);
    }

    // 2. Cluster the window and write a report.
    const { rows: summaries } = await pool.query<{
      id: number;
      summary: string;
      outcome: string;
      tool_errors: Array<{ tool: string; error: string }>;
    }>(
      `SELECT id, summary, outcome, tool_errors FROM session_summaries
       WHERE pii_check_passed
         AND ($1::int IS NULL OR created_at > now() - ($1 || ' days')::interval)
       ORDER BY id`,
      [windowDays],
    );
    if (summaries.length === 0) {
      console.log("[analyze] no summaries in window; skipping clustering");
    } else {
      const clusters = await clusterSummaries(
        model,
        summaries.map((s) => ({ id: s.id, summary: s.summary })),
      );
      const { rows: prevClusters } = await pool.query<{ name: string; size: number }>(
        `SELECT name, size FROM clusters
         WHERE run_id = (SELECT max(id) FROM analysis_runs)`,
      );
      const byId = new Map(summaries.map((s) => [s.id, s]));
      const date = new Date().toISOString().slice(0, 10);
      const reportMd = renderReport({
        date,
        windowDays,
        summaryCount: summaries.length,
        clusters: clusters.map((c) => ({
          name: c.name,
          description: c.description,
          size: c.summaryIds.length,
          examples: c.summaryIds.slice(0, 5).map((id) => byId.get(id)!.summary),
        })),
        previousClusters: prevClusters,
        ...tally(summaries),
      });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const runRes = await client.query<{ id: number }>(
          `INSERT INTO analysis_runs (window_days, summary_count, model, report_md)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [windowDays, summaries.length, config.ANALYSIS_MODEL, reportMd],
        );
        const runId = runRes.rows[0].id;
        for (const c of clusters) {
          const clusterRes = await client.query<{ id: number }>(
            `INSERT INTO clusters (run_id, name, description, size)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [runId, c.name, c.description, c.summaryIds.length],
          );
          for (const summaryId of c.summaryIds) {
            await client.query(
              "INSERT INTO summary_clusters (cluster_id, summary_id) VALUES ($1,$2)",
              [clusterRes.rows[0].id, summaryId],
            );
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await mkdir("reports", { recursive: true });
      const reportPath = join("reports", `${date}.md`);
      await writeFile(reportPath, reportMd);
      console.log(`[analyze] report written to ${reportPath} (${clusters.length} clusters)`);
    }

    // 3. TTL cleanup of raw traces.
    const del = await pool.query(
      `DELETE FROM raw_traces WHERE created_at < now() - ($1 || ' days')::interval`,
      [config.TRACE_RAW_TTL_DAYS],
    );
    console.log(`[analyze] deleted ${del.rowCount ?? 0} expired raw trace row(s)`);
  } finally {
    await pool.end();
  }
}

// Only run as a script, not on import (tests import the pure helpers).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((err) => {
    console.error("[analyze] failed:", err);
    process.exit(1);
  });
}
```

`package.json` scripts: add `"analyze": "tsx --env-file=.env src/analysis/run.ts"`.

`.env.example` — append:

```bash
# --- Trace analysis (optional) ---
# Postgres for agent traces (Aiven free tier). Append ?sslmode=no-verify for Aiven.
TRACE_DATABASE_URL=
# Days to keep raw (unsanitized) traces before the analyze worker deletes them.
TRACE_RAW_TTL_DAYS=14
# Cheap model used by the analysis worker for summarization/clustering.
ANALYSIS_MODEL=google/gemini-2.5-flash
# Optional: Gemini API key for summary embeddings (skipped when empty).
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=text-embedding-004
```

`.gitignore` — add `reports/`.

`CLAUDE.md` — add a short section after the existing env-var paragraph:

```markdown
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
```

- [ ] **Step 4: Run tests** — `npm test -- analysis-run` → PASS; then full `npm test`, `npm run lint`, `npm run build` → all green.
- [ ] **Step 5: Manual smoke (requires a real Aiven DB; skip in CI).** With `TRACE_DATABASE_URL` set in `.env`: run `npm run dev`, send a couple of chat messages from the editor, wait 30+ min (or temporarily lower the interval in the SQL to `'0 minutes'` locally — do not commit), run `npm run analyze`, verify `reports/<date>.md` exists and `session_summaries` has rows without PII. Report the result honestly in the PR/commit notes.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(analysis): analyze worker — summarize, cluster, report, TTL cleanup"`

---

### Task 12: Frontend contract test (repo `pen-editor`)

**Files:**
- Modify: `pen-editor/src/hooks/__tests__/useDesignChat.test.ts`

**Interfaces:**
- Consumes: nothing new — pins existing behavior: every `/api/chat` request body contains a stable `id` (the chat session/tab id) that trace stitching relies on.

- [ ] **Step 1: Add the assertion to the existing two-request test.** In `useDesignChat.test.ts`, the test `"executes a streamed tool call locally and sends the output back"` already captures both request bodies in `requests`. After the existing assertions on `requests[1].body.messages`, add:

```ts
    // Trace-stitching contract (pen-editor-backend raw_traces.session_id):
    // every request of one conversation must carry the same non-empty id.
    expect(requests[0].body.id).toBeTypeOf("string");
    expect((requests[0].body.id as string).length).toBeGreaterThan(0);
    expect(requests[1].body.id).toBe(requests[0].body.id);
```

- [ ] **Step 2: Run** — in `pen-editor/`: `npm test -- useDesignChat` → PASS (behavior already exists; if it fails, the transport stopped sending `id` — that's a real regression to investigate, not a test to weaken).
- [ ] **Step 3: Commit (in the `pen-editor` repo)** — `git add src/hooks/__tests__/useDesignChat.test.ts && git commit -m "test(chat): pin stable request body id for backend trace stitching"`

---

## Final verification (after all tasks)

- Backend: `npm run lint && npm test && npm run build` → all green.
- Frontend: `npm test` → green.
- Confirm `git log` shows one commit per task in each repo.
