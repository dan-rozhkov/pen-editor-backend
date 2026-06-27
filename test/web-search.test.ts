import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { getWebTools } from "../src/ai/web-search.js";

function cfg(over: Partial<Config> = {}): Config {
  return { TAVILY_API_KEY: "test-key", ...over } as Config;
}

type ToolLike = {
  inputSchema: { parse: (v: unknown) => unknown };
  execute: (a: unknown) => Promise<unknown>;
};
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
      query: "x",
      max_results: 5,
      topic: "general",
      search_depth: "basic",
    });
    expect(
      (schema.parse({ query: "x", max_results: 99 }) as { max_results: number })
        .max_results,
    ).toBe(10);
    expect(
      (schema.parse({ query: "x", max_results: 0 }) as { max_results: number })
        .max_results,
    ).toBe(1);
    expect(() => schema.parse({})).toThrow();
  });

  it("maps Tavily /search response and sends include_answer", async () => {
    const calls = stubFetch(() => ({
      json: {
        answer: "an answer",
        results: [
          {
            title: "T",
            url: "https://a.com",
            content: "snippet",
            score: 0.9,
            raw_content: "ignored",
          },
        ],
      },
    }));
    const out = (await tools(cfg()).web_search.execute({
      query: "best dashboards",
      max_results: 3,
      topic: "general",
      search_depth: "basic",
    })) as { query: string; answer?: string; results: unknown[] };

    expect(calls[0].url).toBe("https://api.tavily.com/search");
    expect(calls[0].body).toMatchObject({
      api_key: "test-key",
      query: "best dashboards",
      include_answer: true,
    });
    expect(out).toEqual({
      query: "best dashboards",
      answer: "an answer",
      results: [{ title: "T", url: "https://a.com", content: "snippet", score: 0.9 }],
    });
  });

  it("returns { error } on non-2xx and on thrown fetch", async () => {
    stubFetch(() => ({ ok: false, status: 401, json: { error: "unauthorized" } }));
    const a = (await tools(cfg()).web_search.execute({
      query: "x",
      max_results: 5,
      topic: "general",
      search_depth: "basic",
    })) as { error?: string };
    expect(a.error).toBeTruthy();

    stubFetch(() => new Error("network down"));
    const b = (await tools(cfg()).web_search.execute({
      query: "x",
      max_results: 5,
      topic: "general",
      search_depth: "basic",
    })) as { error?: string };
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
    const out = (await tools(cfg()).fetch_url.execute({
      urls: ["https://a.com", "https://b.com"],
      extract_depth: "basic",
    })) as { results: unknown[]; failed: unknown[] };
    expect(calls[0].url).toBe("https://api.tavily.com/extract");
    expect(calls[0].body).toMatchObject({
      api_key: "test-key",
      urls: ["https://a.com", "https://b.com"],
    });
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
