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
async function tavilyRequest<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
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
  max_results: z
    .number()
    .int()
    .optional()
    .default(5)
    .transform((n) => Math.min(10, Math.max(1, n))),
  topic: z.enum(["general", "news"]).optional().default("general"),
  search_depth: z.enum(["basic", "advanced"]).optional().default("basic"),
});

const fetchUrlInput = z.object({
  urls: z
    .array(z.string().url())
    .min(1, "at least one url")
    .max(5, "at most 5 urls"),
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
