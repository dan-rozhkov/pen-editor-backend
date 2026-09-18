import { describe, expect, it, vi } from "vitest";
import {
  buildPgPoolOptions,
  createTraceStore,
  redactBase64DataUrls,
  writeRawTraceSafe,
  type RawTraceRow,
  type TraceQueryable,
} from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

// Finding 3: connectionTimeoutMillis must be opt-in per pool, not a blanket
// default baked into createPgPool — only the memory store's pool (the one
// sitting in /api/chat's hot path) should get it. `buildPgPoolOptions` is
// the pure options-builder factored out of `createPgPool` specifically so
// this can be asserted without spinning up a real pg.Pool/DB connection.
describe("buildPgPoolOptions", () => {
  it("omits connectionTimeoutMillis when not explicitly requested — pg's own 'wait forever' default applies", () => {
    const options = buildPgPoolOptions("postgres://example");
    expect(options.connectionTimeoutMillis).toBeUndefined();
    expect(options.max).toBe(3);
    expect(options.connectionString).toBe("postgres://example");
  });

  it("includes connectionTimeoutMillis only when the caller opts in", () => {
    const options = buildPgPoolOptions("postgres://example", { connectionTimeoutMillis: 5000 });
    expect(options.connectionTimeoutMillis).toBe(5000);
  });

  it("still allows overriding max independently of the timeout", () => {
    const options = buildPgPoolOptions("postgres://example", { max: 10 });
    expect(options.max).toBe(10);
    expect(options.connectionTimeoutMillis).toBeUndefined();
  });
});


// 94% of every byte in raw_traces turned out to be base64 screenshots stored
// once per tool-loop continuation (see traceStore.ts). The analysis pipeline
// never reads the pixels, so they are dropped on the way in.
describe("redactBase64DataUrls", () => {
  const big = "A".repeat(2000);

  it("replaces a large base64 data URL with a size marker", () => {
    const out = redactBase64DataUrls(`{"image":"data:image/png;base64,${big}"}`);
    expect(out).toBe(`{"image":"data:image/png;base64,[redacted 2000 chars]"}`);
    expect(JSON.parse(out).image).toContain("[redacted 2000 chars]");
  });

  it("redacts every image in the string, not just the first", () => {
    const out = redactBase64DataUrls(
      `data:image/png;base64,${big} and data:image/jpeg;base64,${big}`,
    );
    expect(out).not.toContain(big);
    expect(out).toContain("data:image/png;base64,[redacted");
    expect(out).toContain("data:image/jpeg;base64,[redacted");
  });

  it("keeps small data URLs — inline icons cost nothing and stay readable", () => {
    const small = `{"icon":"data:image/gif;base64,R0lGODlhAQABAAAAACw="}`;
    expect(redactBase64DataUrls(small)).toBe(small);
  });

  it("leaves ordinary text untouched", () => {
    const text = `{"text":"here is a very long sentence ${"word ".repeat(300)}"}`;
    expect(redactBase64DataUrls(text)).toBe(text);
  });

  // Finding 2: an MCP tool result (Mobbin's search_screens/search_sections,
  // etc.) carries its image as the raw MCP content-part shape —
  // {"type":"image","data":"<base64>", ...} — with NO "data:...;base64,"
  // prefix at all. BASE64_DATA_URL_RE alone can't match this, so before
  // this fix it sailed straight into raw_traces on every tool-loop step,
  // reproducing the exact failure that already once filled the Neon
  // quota with base64 screenshots.
  it("redacts a bare MCP image content-part 'data' field with no data: prefix", () => {
    const big = "A".repeat(2000);
    const json = `{"type":"image","data":"${big}","mimeType":"image/jpeg"}`;
    const out = redactBase64DataUrls(json);
    expect(out).not.toContain(big);
    expect(out).toContain(`"data":"[redacted 2000 chars]"`);
    // Round-trips as valid JSON with everything else intact.
    expect(JSON.parse(out)).toEqual({
      type: "image",
      data: `[redacted 2000 chars]`,
      mimeType: "image/jpeg",
    });
  });

  it("redacts a bare MCP embedded-resource 'blob' field with no data: prefix", () => {
    const big = "B".repeat(2000);
    const json = `{"type":"resource","resource":{"blob":"${big}","mimeType":"image/png"}}`;
    const out = redactBase64DataUrls(json);
    expect(out).not.toContain(big);
    expect(JSON.parse(out).resource.blob).toBe("[redacted 2000 chars]");
  });

  it("keeps a small bare 'data' field untouched — same floor as data URLs", () => {
    const small = `{"type":"image","data":"AAA","mimeType":"image/png"}`;
    expect(redactBase64DataUrls(small)).toBe(small);
  });

  it("does not touch an ordinary 'data' field that just happens to hold a short, non-base64-length string", () => {
    const json = `{"data":"not-an-image","other":"value"}`;
    expect(redactBase64DataUrls(json)).toBe(json);
  });

  // Regression (defect 4): an MCP server can return
  // `content:[{type:"text", text:"<JSON-encoded string>"}]` with a base64
  // "data"/"blob" field INSIDE that string. Once the outer payload goes
  // through JSON.stringify (as buildTraceRow's payload always does before
  // reaching redactBase64DataUrls), every `"` inside that inner JSON string
  // is escaped to `\"` — so the literal substring is `\"data\":\"<base64>\"`,
  // not `"data":"<base64>"`, and the old regex (which only matched an
  // UNESCAPED `"data":"..."`) silently sailed straight past it. This is
  // exactly the shape that once filled the Neon raw_traces quota, just one
  // level of encoding deeper than the case already covered above.
  it("redacts a bare 'data' field nested one level inside a JSON-encoded string (escaped quotes)", () => {
    const big = "C".repeat(2000);
    // Build the inner JSON exactly as a real MCP text-content part would
    // carry it, then JSON.stringify the WHOLE thing the way buildTraceRow
    // does — this is what actually produces the escaped-quote form.
    const inner = JSON.stringify({ type: "image", data: big, mimeType: "image/jpeg" });
    const outer = JSON.stringify({
      content: [{ type: "text", text: inner }],
    });
    // Sanity check: the naive OLD pattern genuinely cannot see this — the
    // literal, unescaped substring never occurs in `outer` at all.
    expect(outer).not.toContain(`"data":"${big}"`);
    expect(outer).toContain(big);

    const out = redactBase64DataUrls(outer);
    expect(out).not.toContain(big);

    // Must still round-trip as valid JSON at BOTH levels — the outer
    // object, and the inner JSON string once re-parsed — since this exact
    // string is inserted into a `::jsonb` column.
    const parsedOuter = JSON.parse(out) as { content: Array<{ text: string }> };
    const parsedInner = JSON.parse(parsedOuter.content[0].text) as { data: string };
    expect(parsedInner.data).toBe("[redacted 2000 chars]");
  });

  it("redacts a nested 'blob' field the same way", () => {
    const big = "D".repeat(2000);
    const inner = JSON.stringify({
      type: "resource",
      resource: { blob: big, mimeType: "image/png" },
    });
    const outer = JSON.stringify({ content: [{ type: "text", text: inner }] });

    const out = redactBase64DataUrls(outer);
    expect(out).not.toContain(big);

    const parsedOuter = JSON.parse(out) as { content: Array<{ text: string }> };
    const parsedInner = JSON.parse(parsedOuter.content[0].text) as {
      resource: { blob: string };
    };
    expect(parsedInner.resource.blob).toBe("[redacted 2000 chars]");
  });

  it("keeps a small nested 'data' field untouched — same floor applies one level deep", () => {
    const inner = JSON.stringify({ type: "image", data: "AAA", mimeType: "image/png" });
    const outer = JSON.stringify({ content: [{ type: "text", text: inner }] });
    expect(redactBase64DataUrls(outer)).toBe(outer);
  });
});

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
    expect(pool.calls[0].params?.[1]).toBeNull(); // no userId on this fixture row
    expect(JSON.parse(pool.calls[0].params?.[4] as string)).toEqual(row.payload);
  });

  it("strips base64 image payloads out of the stored history", async () => {
    const pool = fakePool();
    const store = createTraceStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const base64 = "A".repeat(4000);
    await store!.writeRawTrace({
      ...row,
      payload: {
        ...row.payload,
        messages: [
          { role: "user", parts: [{ type: "text", text: "look" }] },
          {
            role: "assistant",
            parts: [
              {
                type: "tool-get_screenshot",
                output: `data:image/png;base64,${base64}`,
              },
            ],
          },
        ],
      },
    });
    const stored = pool.calls[0].params?.[4] as string;
    expect(stored).not.toContain(base64);
    expect(stored).toContain("[redacted 4000 chars]");
    // Everything that is not an image survives verbatim.
    expect(JSON.parse(stored).messages[0].parts[0].text).toBe("look");
  });

  // Finding 2, end to end: a Mobbin MCP tool result stored as a raw
  // toolResults[].result object (see routes/chat.ts's mapSteps, which
  // writes `tr.output ?? tr.result` verbatim) — NOT a data: URL string —
  // must still get its image payload redacted before landing in
  // raw_traces.
  it("strips a bare MCP image content-part ('data', no data: prefix) out of a tool result", async () => {
    const pool = fakePool();
    const store = createTraceStore(
      makeConfig({ TRACE_DATABASE_URL: "postgres://x" }),
      pool,
    );
    const base64 = "M".repeat(4000);
    await store!.writeRawTrace({
      ...row,
      payload: {
        ...row.payload,
        steps: [
          {
            toolResults: [
              {
                toolName: "search_screens",
                result: {
                  content: [
                    { type: "image", data: base64, mimeType: "image/jpeg" },
                    { type: "text", text: "iOS onboarding screen" },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const stored = pool.calls[0].params?.[4] as string;
    expect(stored).not.toContain(base64);
    expect(stored).toContain("[redacted 4000 chars]");
    const parsedSteps = JSON.parse(stored).steps;
    expect(parsedSteps[0].toolResults[0].result.content[1].text).toBe(
      "iOS onboarding screen",
    );
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

  it("swallows synchronous throws from writeRawTrace", () => {
    const store = {
      writeRawTrace: vi.fn((): Promise<void> => {
        throw new Error("sync boom");
      }),
      close: async () => {},
    };
    expect(() => writeRawTraceSafe(store, row)).not.toThrow();
    expect(store.writeRawTrace).toHaveBeenCalled();
  });
});
