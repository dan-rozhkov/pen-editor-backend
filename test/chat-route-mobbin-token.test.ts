import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// Verifies the X-Mobbin-Token contract end to end over real HTTP:
//   - the header reaches getMCPTools via prepareChatTurn
//   - no token at all yields a request that never asked getMCPTools for one
//   - the raw token text never appears anywhere `messages`/raw_traces sees
// ---------------------------------------------------------------------------

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
  getMCPToolsCalls: [] as Array<{ mobbinAccessToken?: string } | undefined>,
}));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(() => holders.model) };
});

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async (_config: unknown, opts?: { mobbinAccessToken?: string }) => {
    holders.getMCPToolsCalls.push(opts);
    return {};
  }),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

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
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function mockModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) }),
  });
}

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

async function startServer(traceStore?: TraceStore | null): Promise<RunningServer> {
  const app = await buildApp(makeConfig(), { logger: false, traceStore });
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

describe("X-Mobbin-Token", () => {
  it("threads the header value into getMCPTools as mobbinAccessToken", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    holders.getMCPToolsCalls.length = 0;
    const { app, url } = await startServer();

    await (
      await postChat(
        url,
        { id: "tab-mobbin-1", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": "real-secret-token-value" },
      )
    ).text();

    expect(holders.getMCPToolsCalls.length).toBeGreaterThan(0);
    expect(holders.getMCPToolsCalls[0]?.mobbinAccessToken).toBe("real-secret-token-value");
    await app.close();
  });

  it("calls getMCPTools with no mobbinAccessToken when the header is absent", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    holders.getMCPToolsCalls.length = 0;
    const { app, url } = await startServer();

    await (await postChat(url, { id: "tab-mobbin-2", messages: [userMessage("hello")] })).text();

    expect(holders.getMCPToolsCalls.length).toBeGreaterThan(0);
    expect(holders.getMCPToolsCalls[0]?.mobbinAccessToken).toBeUndefined();
    await app.close();
  });

  it("ignores an absurdly long header value rather than passing it through", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    holders.getMCPToolsCalls.length = 0;
    const { app, url } = await startServer();

    await (
      await postChat(
        url,
        { id: "tab-mobbin-3", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": "x".repeat(8193) },
      )
    ).text();

    expect(holders.getMCPToolsCalls[0]?.mobbinAccessToken).toBeUndefined();
    await app.close();
  });

  it("never writes the token into the raw_traces row, even though the request carried one", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { app, url } = await startServer(store);
    const secretToken = "do-not-leak-this-mobbin-token-9f3e";

    await (
      await postChat(
        url,
        { id: "tab-mobbin-4", messages: [userMessage("hello")] },
        { "X-Mobbin-Token": secretToken },
      )
    ).text();

    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    // The whole point: nothing about this request's trace row — not the
    // stored messages, not any other field — ever contains the token text.
    expect(JSON.stringify(store.rows[0])).not.toContain(secretToken);
    await app.close();
  });
});
