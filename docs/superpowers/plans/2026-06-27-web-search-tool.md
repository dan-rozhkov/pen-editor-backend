# Web Search Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the design agent two backend-executed tools — `web_search` and `fetch_url` — backed by the Tavily API, so it can search the internet and read pages to ground designs in real content.

**Architecture:** A new `src/ai/web-search.ts` module exports `getWebTools(config)` returning `{}` when `TAVILY_API_KEY` is unset, or `{ web_search, fetch_url }` (both with `execute`) when set — mirroring the `getMCPTools` optional pattern. Tools are merged into the default toolset in `chat.ts` alongside MCP tools. `penTools` is NOT modified, so both cross-repo contract tests stay green with no frontend changes.

**Tech Stack:** TypeScript (ESM, `NodeNext` — `.js` import extensions required), Vercel AI SDK `tool()`, zod, global `fetch`, Vitest.

## Global Constraints

- Relative TS imports MUST include `.js` extension (e.g. `import type { Config } from "../config.js"`).
- `web_search`/`fetch_url` must be **backend-executed** — each declares an `execute`.
- `execute` MUST NOT throw on API/network failure — return `{ error: string }` instead.
- Do NOT modify `penTools` in `src/ai/tools.ts`, nor either contract test.
- No network/API key in tests — stub global `fetch` with `vi.stubGlobal`.
- Tavily endpoints: `POST https://api.tavily.com/search`, `POST https://api.tavily.com/extract`. Auth via `api_key` field in JSON body.
- `console.warn` logs use a `[web]` prefix (matches the `[mcp]` convention).

## File Structure

- **Create** `src/ai/web-search.ts` — `getWebTools(config)`, the two tools, and the `tavilyRequest` helper. One responsibility: internet-search tools.
- **Create** `test/web-search.test.ts` — unit tests with stubbed `fetch`.
- **Modify** `src/config.ts` — add optional `TAVILY_API_KEY`.
- **Modify** `src/routes/chat.ts` — merge `getWebTools(config)` into the default toolset.
- **Modify** `src/ai/system-prompt.ts` — note the (conditional) availability of the tools.
- **Modify** `.env.example` — document `TAVILY_API_KEY`.

---

### Task 1: Add `TAVILY_API_KEY` to config

**Files:**
- Modify: `src/config.ts:25` (next to `REFERO_API_KEY`)
- Modify: `.env.example:19-20`
- Test: `test/config.test.ts` (if present; otherwise covered by Task 2's import)

**Interfaces:**
- Produces: `Config.TAVILY_API_KEY?: string` — read by `getWebTools` in Task 2.

- [ ] **Step 1: Add the env field**

In `src/config.ts`, inside `envSchema`, immediately after the `REFERO_API_KEY` line (line 25):

```ts
  REFERO_API_KEY: z.string().optional(),
  // Internet search (optional) — enables the web_search/fetch_url tools (Tavily).
  // Free tier: 1,000 credits/month (basic search = 1 credit).
  TAVILY_API_KEY: z.string().optional(),
```

- [ ] **Step 2: Document it in `.env.example`**

After the Refero block (line 20), add:

```
# Internet search (optional) — enables web_search/fetch_url tools (Tavily).
# Free tier: 1,000 credits/month. Get a key at https://app.tavily.com
TAVILY_API_KEY=
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS (no type errors). `Config` now includes the optional field.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat: add optional TAVILY_API_KEY config"
```

---

### Task 2: Implement `getWebTools` with `web_search` and `fetch_url`

**Files:**
- Create: `src/ai/web-search.ts`
- Test: `test/web-search.test.ts`

**Interfaces:**
- Consumes: `Config.TAVILY_API_KEY?` (Task 1).
- Produces:
  - `getWebTools(config: Config): Record<string, unknown>` — `{}` without a key, else `{ web_search, fetch_url }`.
  - `web_search` input `{ query: string, max_results?: number (1..10, default 5), topic?: "general"|"news" (default "general"), search_depth?: "basic"|"advanced" (default "basic") }`; result `{ query, answer?, results: [{title,url,content,score}] }` or `{ error }`.
  - `fetch_url` input `{ urls: string[] (1..5), extract_depth?: "basic"|"advanced" (default "basic") }`; result `{ results: [{url,raw_content}], failed: [{url,error}] }` or `{ error }`.

- [ ] **Step 1: Write the failing test**

Create `test/web-search.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { getWebTools } from "../src/ai/web-search.js";

function cfg(over: Partial<Config> = {}): Config {
  return { TAVILY_API_KEY: "test-key", ...over } as Config;
}

type ToolLike = { inputSchema: { parse: (v: unknown) => unknown }; execute: (a: unknown) => Promise<unknown> };
const tools = (c: Config) => getWebTools(c) as Record<string, ToolLike>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const result = impl(url, init);
      if (result instanceof Error) throw result;
      return {
        ok: (result as { ok?: boolean }).ok ?? true,
        status: (result as { status?: number }).status ?? 200,
        json: async () => (result as { json: unknown }).json,
      } as Response;
    }),
  );
  return calls;
}

describe("getWebTools", () => {
  it("returns {} without an API key", () => {
    expect(getWebTools({} as Config)).toEqual({});
    expect(getWebTools({ TAVILY_API_KEY: "" } as Config)).toEqual({});
  });

  it("returns web_search and fetch_url, both with execute", () => {
    const t = tools(cfg());
    expect(Object.keys(t).sort()).toEqual(["fetch_url", "web_search"]);
    expect(typeof t.web_search.execute).toBe("function");
    expect(typeof t.fetch_url.execute).toBe("function");
  });
});

describe("web_search", () => {
  it("applies defaults and clamps max_results", () => {
    const schema = tools(cfg()).web_search.inputSchema;
    expect(schema.parse({ query: "x" })).toEqual({
      query: "x", max_results: 5, topic: "general", search_depth: "basic",
    });
    expect((schema.parse({ query: "x", max_results: 99 }) as { max_results: number }).max_results).toBe(10);
    expect((schema.parse({ query: "x", max_results: 0 }) as { max_results: number }).max_results).toBe(1);
    expect(() => schema.parse({})).toThrow();
  });

  it("maps Tavily /search response and sends include_answer", async () => {
    const calls = stubFetch(() => ({
      json: {
        answer: "an answer",
        results: [{ title: "T", url: "https://a.com", content: "snippet", score: 0.9, raw_content: "ignored" }],
      },
    }));
    const out = (await tools(cfg()).web_search.execute({
      query: "best dashboards", max_results: 3, topic: "general", search_depth: "basic",
    })) as { query: string; answer?: string; results: unknown[] };

    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect(calls[0].body).toMatchObject({ api_key: "test-key", query: "best dashboards", include_answer: true });
    expect(out).toEqual({
      query: "best dashboards",
      answer: "an answer",
      results: [{ title: "T", url: "https://a.com", content: "snippet", score: 0.9 }],
    });
  });

  it("returns { error } on non-2xx and on thrown fetch", async () => {
    stubFetch(() => ({ ok: false, status: 401, json: { error: "unauthorized" } }));
    const a = (await tools(cfg()).web_search.execute({ query: "x", max_results: 5, topic: "general", search_depth: "basic" })) as { error?: string };
    expect(a.error).toBeTruthy();

    stubFetch(() => new Error("network down"));
    const b = (await tools(cfg()).web_search.execute({ query: "x", max_results: 5, topic: "general", search_depth: "basic" })) as { error?: string };
    expect(b.error).toBeTruthy();
  });
});

describe("fetch_url", () => {
  it("maps Tavily /extract response into results + failed", async () => {
    const calls = stubFetch(() => ({
      json: {
        results: [{ url: "https://a.com", raw_content: "full text" }],
        failed_results: [{ url: "https://b.com", error: "timeout" }],
      },
    }));
    const out = (await tools(cfg()).fetch_url.execute({ urls: ["https://a.com", "https://b.com"], extract_depth: "basic" })) as {
      results: unknown[]; failed: unknown[];
    };
    expect(calls[0].url).toBe("https://api.tavily.com/extract");
    expect(calls[0].body).toMatchObject({ api_key: "test-key", urls: ["https://a.com", "https://b.com"] });
    expect(out).toEqual({
      results: [{ url: "https://a.com", raw_content: "full text" }],
      failed: [{ url: "https://b.com", error: "timeout" }],
    });
  });

  it("rejects empty and oversized url lists", () => {
    const schema = tools(cfg()).fetch_url.inputSchema;
    expect(() => schema.parse({ urls: [] })).toThrow();
    expect(() => schema.parse({ urls: Array(6).fill("https://a.com") })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- web-search`
Expected: FAIL — `Cannot find module '../src/ai/web-search.js'` (file not created yet).

- [ ] **Step 3: Write the implementation**

Create `src/ai/web-search.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}
interface TavilySearchResponse {
  answer?: string;
  results?: TavilySearchResult[];
}
interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
}
interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: { url?: string; error?: string }[];
}

// POST JSON to Tavily. Throws on non-2xx (callers convert to { error }).
async function tavilyRequest<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: unknown };
      detail = typeof data.error === "string" ? `: ${data.error}` : "";
    } catch {
      // non-JSON error body — ignore
    }
    throw new Error(`Tavily request failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
}

const webSearchInput = z.object({
  query: z.string().min(1, "query is required"),
  max_results: z.number().int().optional().default(5).transform((n) => Math.min(10, Math.max(1, n))),
  topic: z.enum(["general", "news"]).optional().default("general"),
  search_depth: z.enum(["basic", "advanced"]).optional().default("basic"),
});

const fetchUrlInput = z.object({
  urls: z.array(z.string().url()).min(1, "at least one url").max(5, "at most 5 urls"),
  extract_depth: z.enum(["basic", "advanced"]).optional().default("basic"),
});

export function getWebTools(config: Config): Record<string, unknown> {
  const apiKey = config.TAVILY_API_KEY;
  if (!apiKey) return {};

  const web_search = tool({
    description:
      "Search the public internet for up-to-date information, references, copy, data, or design inspiration. Returns a synthesized answer plus a list of result snippets with URLs. Use fetch_url afterwards to read a specific page in full.",
    inputSchema: webSearchInput,
    execute: async ({ query, max_results, topic, search_depth }) => {
      try {
        const data = await tavilyRequest<TavilySearchResponse>(SEARCH_URL, {
          api_key: apiKey,
          query,
          max_results,
          topic,
          search_depth,
          include_answer: true,
          include_raw_content: false,
          include_images: false,
        });
        return {
          query,
          ...(data.answer ? { answer: data.answer } : {}),
          results: (data.results ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.url ?? "",
            content: r.content ?? "",
            score: r.score ?? 0,
          })),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[web] web_search failed:`, message);
        return { error: message };
      }
    },
  });

  const fetch_url = tool({
    description:
      "Read the full text content of one or more specific web pages (up to 5). Use after web_search when a result looks worth reading in detail.",
    inputSchema: fetchUrlInput,
    execute: async ({ urls, extract_depth }) => {
      try {
        const data = await tavilyRequest<TavilyExtractResponse>(EXTRACT_URL, {
          api_key: apiKey,
          urls,
          extract_depth,
        });
        return {
          results: (data.results ?? []).map((r) => ({
            url: r.url ?? "",
            raw_content: r.raw_content ?? "",
          })),
          failed: (data.failed_results ?? []).map((f) => ({
            url: f.url ?? "",
            error: f.error ?? "",
          })),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[web] fetch_url failed:`, message);
        return { error: message };
      }
    },
  });

  return { web_search, fetch_url };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- web-search`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + build**

Run: `npm run lint && npm run build`
Expected: PASS (0 errors).

- [ ] **Step 6: Commit**

```bash
git add src/ai/web-search.ts test/web-search.test.ts
git commit -m "feat: add web_search and fetch_url tools (Tavily)"
```

---

### Task 3: Wire web tools into the chat route

**Files:**
- Modify: `src/routes/chat.ts:18-19` (imports), `src/routes/chat.ts:222-224` (toolset)
- Test: covered by existing `test/chat-route.test.ts` staying green + `npm run build`

**Interfaces:**
- Consumes: `getWebTools` (Task 2).

- [ ] **Step 1: Import `getWebTools`**

In `src/routes/chat.ts`, after the `getMCPTools` import (line 20):

```ts
import { getMCPTools } from "../ai/mcp.js";
import { getWebTools } from "../ai/web-search.js";
```

- [ ] **Step 2: Merge into the default toolset**

Replace the `tools` assignment (lines 222-224):

```ts
    const tools = isResearch
      ? (mcpTools as ToolSet)
      : { ...penTools, ...getWebTools(config), ...mcpTools };
```

- [ ] **Step 3: Build + run the chat-route tests**

Run: `npm run build && npm test -- chat-route`
Expected: PASS — existing chat-route tests are unaffected (no `TAVILY_API_KEY` in their config, so `getWebTools` returns `{}`).

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat.ts
git commit -m "feat: expose web tools in the default agent toolset"
```

---

### Task 4: Tell the agent the tools exist

**Files:**
- Modify: `src/ai/system-prompt.ts` — `CORE_PROMPT` Workflow list (~line 183) and Design Principles (~line 200)
- Test: covered by `npm run build` + existing `test/system-prompt.test.ts` (update its assertion only if it pins exact text)

**Interfaces:** none (prompt text only).

- [ ] **Step 1: Check whether a system-prompt test pins exact content**

Run: `grep -n "Workflow\|web_search\|toContain" test/system-prompt.test.ts || echo "no exact-text assertions"`
If it asserts on specific substrings, keep those substrings intact while inserting new lines.

- [ ] **Step 2: Add a Workflow step**

In `src/ai/system-prompt.ts`, in the `CORE_PROMPT` Workflow list, after the `get_guidelines` line (line 183), insert:

```
3a. **web_search / fetch_url** *(if available)* — when a task needs real-world content, references, data, or inspiration, search the internet with \`web_search\`, then read a specific page with \`fetch_url\`. These tools exist only when the server is configured for internet search; if a call returns an error, continue without it.
```

- [ ] **Step 3: Add a Design Principle**

After the line about checking variables/tokens (line 195), insert:

```
- When you need real content, facts, or up-to-date references for a design, use \`web_search\` (and \`fetch_url\` to read a page) if those tools are available — do not invent data when you can look it up.
```

- [ ] **Step 4: Build + test**

Run: `npm run build && npm test`
Expected: PASS (full suite green, including both contract tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/ai/system-prompt.ts
git commit -m "docs: guide the agent to use web_search/fetch_url when available"
```

---

## Self-Review

**Spec coverage:**
- `web-search.ts` + `getWebTools` → Task 2. ✓
- `web_search` tool (schema, mapping, include_answer, error handling) → Task 2. ✓
- `fetch_url` tool (extract, results/failed mapping) → Task 2. ✓
- Optional via `TAVILY_API_KEY` (returns `{}`) → Task 1 + Task 2 test. ✓
- `chat.ts` wiring into default toolset, research unchanged → Task 3. ✓
- Config field + `.env.example` → Task 1. ✓
- System-prompt note (conditional) → Task 4. ✓
- Tests with stubbed fetch, no network → Task 2. ✓
- Contract tests untouched & green → verified in Task 3 & 4 (`penTools` never modified). ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; error handling shown explicitly. ✓

**Type consistency:** `getWebTools(config: Config)` used identically in Tasks 2 & 3. Tool names `web_search`/`fetch_url`, response keys (`results`, `answer`, `failed`, `raw_content`, `score`) consistent between implementation and tests. Tavily response uses `failed_results` (input) → mapped to `failed` (output) consistently. ✓
