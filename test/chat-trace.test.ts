import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { TraceStore } from "../src/tracing/traceStore.js";
import { makeConfig } from "./helpers.js";
import {
  chatMocks,
  mockModel,
  sequenceModel,
  textStreamChunks,
  toolCallStreamChunks,
  userMessage,
} from "./chatMocks.js";
import { chatTurn, postChat, recordingTraceStore, startApp } from "./chatHarness.js";

// ---------------------------------------------------------------------------
// Mocks: the provider returns a MockLanguageModelV3 (ai/test) and MCP tools
// are controlled per test — no network calls and no real API keys. See the
// hoisting contract at the top of test/chatMocks.ts.
// ---------------------------------------------------------------------------

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

// Step 1 of a two-step turn: a server-executed tool call (get_guidelines)
// whose result makes streamText run a second model step.
const guidelinesStep = () => toolCallStreamChunks("get_guidelines", { topic: "table" });

// Starts an app whose raw_traces writes land in an in-memory recorder.
async function startTracedApp(store: TraceStore = recordingTraceStore()) {
  return startApp(makeConfig(), { traceStore: store });
}

describe("chat route trace writing", () => {
  it("writes a raw trace row with the client session id after a completed stream", async () => {
    chatMocks.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { url, close } = await startTracedApp(store);
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
    await close();
  });

  it("writes a null userId when the request body has none", async () => {
    chatMocks.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { url, close } = await startTracedApp(store);
    await chatTurn(url, { id: "tab-nouser-1", messages: [userMessage("hello")] });
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].userId).toBeNull();
    await close();
  });

  it("writes a null userId when the body's userId is shape-invalid", async () => {
    chatMocks.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { url, close } = await startTracedApp(store);
    await chatTurn(url, {
      id: "tab-baduser-1",
      messages: [userMessage("hello")],
      userId: "not-a-real-id",
    });
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].userId).toBeNull();
    await close();
  });

  it("generates a fallback session id when the body has no id", async () => {
    chatMocks.model = mockModel(textStreamChunks("hi"));
    const store = recordingTraceStore();
    const { url, close } = await startTracedApp(store);
    await chatTurn(url, { messages: [userMessage("hello")] });
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].sessionId).toMatch(/^anon-/);
    await close();
  });

  it("records the real completed steps (not an empty array) when the client aborts mid-session", async () => {
    // Step 1: a server-executed tool call (get_guidelines) that resolves and
    // triggers a second model turn. Step 2's stream never finishes, giving
    // the test a deterministic window to abort the client connection while
    // step 1 is already on record — exercising the onAbort trace path with
    // real steps instead of the historical `steps: []`.
    let call = 0;
    chatMocks.model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: guidelinesStep(),
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
    const { url, close } = await startTracedApp(store);

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
    await close();
  });

  it("a throwing trace store does not break the chat response", async () => {
    chatMocks.model = mockModel(textStreamChunks("hi"));
    const store: TraceStore = {
      writeRawTrace: async () => {
        throw new Error("db down");
      },
      close: async () => {},
    };
    const { url, close } = await startTracedApp(store);
    const res = await postChat(url, { id: "tab-1-1", messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("hi"); // stream completed normally
    await close();
  });

  it("records v6 step tool input/output into payload.steps", async () => {
    // Turn 1 calls the tool; turn 2 (after the tool result) finishes with text.
    chatMocks.model = sequenceModel(guidelinesStep(), textStreamChunks("done"));
    const store = recordingTraceStore();
    const { url, close } = await startTracedApp(store);
    await chatTurn(url, {
      id: "tab-args-1",
      messages: [userMessage("give me table guidelines")],
    });
    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    const steps = store.rows[0].payload.steps as Array<{
      toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
      toolResults: Array<{ toolName: string; result: unknown }>;
    }>;
    expect(steps[0].toolCalls[0].toolName).toBe("get_guidelines");
    expect(steps[0].toolCalls[0].args).toEqual({ topic: "table" });
    expect(steps[0].toolResults[0].result).toBeTruthy();
    await close();
  });
});
