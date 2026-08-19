import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
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

// A tool-call step followed by a delayed text-only step, so a test can abort
// the client fetch in the gap between them and land in onAbort with one
// already-finished step on record.
function toolThenSlowTextChunks(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "get_guidelines",
      input: JSON.stringify({ topic: "table" }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
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
      userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so onFinish fires
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].sessionId).toBe("tab-123-1");
    expect(store.rows[0].agentMode).toBe("edits");
    expect(store.rows[0].payload.messages).toHaveLength(1);
    expect(store.rows[0].payload.systemPromptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(store.rows[0].userId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    await app.close();
  });

  it("writes a null userId when the request body has none", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { app, url } = await startServer(makeConfig(), store);
    await (
      await postChat(url, { id: "tab-nouser-1", messages: [userMessage("hello")] })
    ).text();
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].userId).toBeNull();
    await app.close();
  });

  it("writes a null userId when the body's userId is shape-invalid", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { app, url } = await startServer(makeConfig(), store);
    await (
      await postChat(url, {
        id: "tab-baduser-1",
        messages: [userMessage("hello")],
        userId: "not-a-real-id",
      })
    ).text();
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].userId).toBeNull();
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

  it("records the real completed steps (not an empty array) when the client aborts mid-session", async () => {
    // Step 1: a server-executed tool call (get_guidelines) that resolves and
    // triggers a second model turn. Step 2's stream never finishes, giving
    // the test a deterministic window to abort the client connection while
    // step 1 is already on record — exercising the onAbort trace path with
    // real steps instead of the historical `steps: []`.
    let call = 0;
    holders.model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: toolThenSlowTextChunks(),
              chunkDelayInMs: null,
            }),
          };
        }
        // Step 2: a stream that only ever settles by rejecting when the
        // request's abortSignal fires — mirrors how a real HTTP-backed
        // provider stream reacts to client disconnect, and is what actually
        // drives the AI SDK's onAbort callback (it reacts to a read()
        // rejecting with an AbortError, not to the signal directly).
        return {
          stream: new ReadableStream({
            start(controller) {
              abortSignal?.addEventListener("abort", () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              });
            },
          }),
        };
      },
    });
    const store = recordingTraceStore();
    const { app, url } = await startServer(makeConfig(), store);

    // Use a raw http.request (not fetch) so the test can force-destroy the
    // underlying TCP socket — that reliably fires Node's 'close' event on
    // the server's reply.raw, which is what actually drives onAbort.
    const body = JSON.stringify({
      id: "tab-abort-1",
      messages: [userMessage("do something")],
    });
    const { hostname, port } = new URL(url);
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname,
          port,
          path: "/api/chat",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          // Wait long enough that step 1 (tool call + result) has definitely
          // streamed and step 2 is stalled awaiting abort, then destroy the
          // socket to simulate an abrupt client disconnect.
          res.on("data", () => {});
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 100);
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => reject(new Error("timed out waiting for response data")), 5000);
    });

    await vi.waitFor(() => expect(store.rows.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const row = store.rows.find((r) => r.streamError === "client-aborted")!;
    expect(row).toBeDefined();
    expect(row.payload.steps).not.toEqual([]);
    const steps = row.payload.steps as Array<{
      toolCalls: Array<{ toolName: string }>;
    }>;
    expect(steps[0].toolCalls[0].toolName).toBe("get_guidelines");
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

  it("records v6 step tool input/output into payload.steps", async () => {
    // Turn 1 calls the tool; turn 2 (after the tool result) finishes with text.
    let call = 0;
    holders.model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: call === 1 ? toolThenSlowTextChunks() : textStreamChunks("done"),
            chunkDelayInMs: null,
          }),
        };
      },
    });
    const store = recordingTraceStore();
    const { app, url } = await startServer(makeConfig(), store);
    await (
      await postChat(url, {
        id: "tab-args-1",
        messages: [userMessage("give me table guidelines")],
      })
    ).text();
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    const steps = store.rows[0].payload.steps as Array<{
      toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
      toolResults: Array<{ toolName: string; result: unknown }>;
    }>;
    expect(steps[0].toolCalls[0].toolName).toBe("get_guidelines");
    expect(steps[0].toolCalls[0].args).toEqual({ topic: "table" });
    expect(steps[0].toolResults[0].result).toBeTruthy();
    await app.close();
  });
});
