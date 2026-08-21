import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";

// Exercises the /api/chat transparent-retry path (src/ai/streamWithRetry.ts):
// a retryable provider error that arrives before any content chunk should be
// invisible to the client — the second attempt's output streams through as
// if it were the only attempt. An error after content, or a non-retryable
// error, must behave exactly as before (no retry, error surfaces).

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

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function finishChunk(): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
  };
}

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    finishChunk(),
  ];
}

function errorChunks(error: unknown): LanguageModelV3StreamPart[] {
  return [{ type: "stream-start", warnings: [] }, { type: "error", error }];
}

function errorAfterTextChunks(text: string, error: unknown): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "error", error },
  ];
}

/** A model whose Nth doStream() call returns the Nth entry of `sequence` (1-indexed calls). */
function sequencedModel(sequence: LanguageModelV3StreamPart[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = sequence[Math.min(call, sequence.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) };
    },
  });
}

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

interface RunningServerOptions {
  config?: ReturnType<typeof makeConfig>;
  traceStore?: TraceStore | null;
  analytics?: AnalyticsClient;
  baseDelayMs?: number;
}

async function startServer(options: RunningServerOptions = {}): Promise<RunningServer> {
  const app = await buildApp(options.config ?? makeConfig(), {
    logger: false,
    // Small, deterministic delays — this test asserts retry *happened*, not
    // real-world backoff timing.
    chatRetryPolicy: { maxRetries: 2, baseDelayMs: options.baseDelayMs ?? 5 },
    traceStore: options.traceStore,
    analytics: options.analytics,
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
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

function recordingAnalyticsClient(): AnalyticsClient & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return {
    events,
    capture(event) {
      events.push(event);
    },
    async shutdown() {},
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

async function postChat(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let server: RunningServer;

beforeAll(async () => {
  await loadSkills();
  server = await startServer();
});

afterAll(async () => {
  await server.app.close();
});

afterEach(() => {
  holders.mcpTools = {};
});

describe("POST /api/chat — transparent retry", () => {
  it("retries a retryable error that arrives before any content: the client sees a clean success", async () => {
    holders.model = sequencedModel([
      errorChunks(new Error("503 Service Unavailable")),
      textChunks("Hello after retry"),
    ]);

    const res = await postChat(server.url, { messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain('"type":"error"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("Hello after retry");
    expect(body).toContain("[DONE]");
  });

  it("does not retry an error that arrives after a content chunk — the error surfaces as-is", async () => {
    holders.model = sequencedModel([
      errorAfterTextChunks("partial", new Error("503 Service Unavailable")),
      textChunks("should never be reached"),
    ]);

    const res = await postChat(server.url, { messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("partial");
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain("should never be reached");
  });

  it("does not retry a non-retryable error", async () => {
    holders.model = sequencedModel([
      errorChunks(new Error("insufficient_quota")),
      textChunks("should never be reached"),
    ]);

    const res = await postChat(server.url, { messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('"type":"error"');
    expect(body).not.toContain("should never be reached");
  });

  it("surfaces the error once the retry budget (2) is exhausted", async () => {
    holders.model = sequencedModel([
      errorChunks(new Error("503 Service Unavailable")),
      errorChunks(new Error("502 Bad Gateway")),
      errorChunks(new Error("504 Gateway Timeout")),
    ]);

    const res = await postChat(server.url, { messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('"type":"text-delta"');
  });
});

// ---------------------------------------------------------------------------
// Findings #1 and #6: trace/analytics side effects for a retried turn.
// Each test spins up its own server (with its own recording traceStore/
// analytics client) instead of reusing the shared `server` above, since
// these assert exact row/event counts and must not see other tests' writes.
// ---------------------------------------------------------------------------

describe("POST /api/chat — trace/analytics side effects around retry (findings #1 and #6)", () => {
  afterEach(() => {
    holders.mcpTools = {};
  });

  it("finding #1: writes a streamError trace row and fires agent_turn_failed exactly once for an error that arrives AFTER content", async () => {
    holders.model = sequencedModel([
      errorAfterTextChunks("partial", new Error("503 Service Unavailable")),
    ]);
    const store = recordingTraceStore();
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer({ traceStore: store, analytics });

    const res = await postChat(url, { id: "tab-post-content-error", messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    await res.text();

    // This attempt is never discarded (it's the only attempt — no retry
    // happens for a post-content error), so streamText's own onFinish also
    // fires and writes its own (streamError: null) row — a separate,
    // pre-existing v6 quirk (see finding #6's doc comment) that's out of
    // scope here. What finding #1 fixes is specifically that a row WITH the
    // streamError, and the matching agent_turn_failed event, now exist at
    // all — before the fix, neither did for a post-content error.
    await vi.waitFor(() =>
      expect(store.rows.some((r) => r.streamError === "503 Service Unavailable")).toBe(true),
    );

    const failedEvents = analytics.events.filter((e) => e.event === "agent_turn_failed");
    expect(failedEvents).toHaveLength(1);

    await app.close();
  });

  it("finding #6: exactly one trace row and one agent_turn_completed for a turn with one pre-content retry", async () => {
    holders.model = sequencedModel([
      errorChunks(new Error("503 Service Unavailable")),
      textChunks("Hello after retry"),
    ]);
    const store = recordingTraceStore();
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer({ traceStore: store, analytics });

    const res = await postChat(url, { id: "tab-retried-success", messages: [userMessage("hi")] });
    expect(res.status).toBe(200);
    await res.text();

    await vi.waitFor(() => expect(store.rows).toHaveLength(1));
    expect(store.rows[0].streamError).toBeNull();

    const completedEvents = analytics.events.filter((e) => e.event === "agent_turn_completed");
    expect(completedEvents).toHaveLength(1);
    const failedEvents = analytics.events.filter((e) => e.event === "agent_turn_failed");
    expect(failedEvents).toHaveLength(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Finding #5: client disconnect while a retry's backoff sleep is in
// progress (i.e. between attempts, no streamText call active) must still
// leave a trace/analytics record, same as any other disconnect.
// ---------------------------------------------------------------------------

describe("POST /api/chat — client disconnect during retry backoff (finding #5)", () => {
  afterEach(() => {
    holders.mcpTools = {};
  });

  it("records a client-aborted trace row and an agent_turn_failed(aborted) event", async () => {
    // A single retryable pre-content error, then (if ever reached) a
    // legitimate finish — the test aborts during the backoff sleep before
    // the second attempt's stream is read, so the second entry should never
    // actually matter.
    holders.model = sequencedModel([
      errorChunks(new Error("503 Service Unavailable")),
      textChunks("should never be reached"),
    ]);
    const store = recordingTraceStore();
    const analytics = recordingAnalyticsClient();
    // A large-ish base delay gives the test a comfortable window to destroy
    // the connection while the backoff sleep is in progress.
    const { app, url } = await startServer({ traceStore: store, analytics, baseDelayMs: 300 });

    const body = JSON.stringify({
      id: "tab-backoff-abort",
      messages: [userMessage("hi")],
    });
    const { hostname, port } = new URL(url);
    await new Promise<void>((resolve, reject) => {
      // No response headers/bytes reach the client until the SECOND attempt
      // produces content (nothing is written during the first attempt's
      // error + backoff sleep), so the destroy timer must NOT wait for the
      // `(res) => ...` response callback — that callback wouldn't fire until
      // the turn is basically already done, which is exactly the race that
      // made this test flaky against the un-fixed code (it looked like the
      // abort never happened, when really it was scheduled too late).
      // Schedule the destroy independently, right after the request is
      // issued, well inside the ~225-300ms backoff window.
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
          res.on("data", () => {});
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => {
        req.destroy();
      }, 80);
      setTimeout(() => reject(new Error("timed out waiting for response")), 5000);
    });

    await vi.waitFor(() => expect(store.rows.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].streamError).toBe("client-aborted");

    const abortedEvents = analytics.events.filter(
      (e) => e.event === "agent_turn_failed" && e.properties?.error_kind === "aborted",
    );
    expect(abortedEvents).toHaveLength(1);

    await app.close();
  });
});
