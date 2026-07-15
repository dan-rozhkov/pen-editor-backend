import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// Mocks: the provider returns a MockLanguageModelV3 (ai/test) and MCP tools
// are controlled per test — no network calls and no real API keys.
// ---------------------------------------------------------------------------

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
  mcpTools: {} as Record<string, unknown>,
}));

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => holders.mcpTools),
  closeAllMCPClients: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
    },
  ];
}

function mockModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
    }),
  });
}

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

async function startServer(
  config = makeConfig(),
  traceStore?: TraceStore | null,
): Promise<RunningServer> {
  const app = await buildApp(config, { logger: false, traceStore });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

async function postChat(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

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
    const { app, url } = await startServer(makeConfig(), store);
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
    const { app, url } = await startServer(makeConfig(), store);
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
    const { app, url } = await startServer(makeConfig(), store);
    const res = await postChat(url, { id: "tab-1-1", messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hi"); // stream completed normally
    await app.close();
  });
});
