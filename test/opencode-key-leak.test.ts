import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";

// A visible canary value: the OpenCode key sent on this turn must never
// appear anywhere it could be persisted or exported — raw_traces, PostHog
// event properties, or (implicitly, since we never inspect them) log lines.
const CANARY_KEY = "sk-test-LEAK-CANARY";
const CANARY_MARKER = "LEAK-CANARY";

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
  mcpTools: {} as Record<string, unknown>,
}));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(() => holders.model) };
});

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => holders.mcpTools),
  closeAllMCPClients: vi.fn(async () => {}),
  // The Mobbin client cache hands out a lease per turn; prepareChatTurn and
  // the chat route both call these, so a mock of this module must declare
  // them or the route 500s on an undefined call.
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

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
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

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

async function startServer(opts: {
  traceStore: TraceStore;
  analytics: AnalyticsClient;
}): Promise<RunningServer> {
  const app = await buildApp(makeConfig(), {
    logger: false,
    traceStore: opts.traceStore,
    analytics: opts.analytics,
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

beforeAll(async () => {
  await loadSkills();
});

describe("OpenCode key never leaks into raw_traces or PostHog", () => {
  let server: RunningServer;
  let traceStore: TraceStore & { rows: RawTraceRow[] };
  let analytics: AnalyticsClient & { events: AnalyticsEvent[] };

  beforeAll(async () => {
    holders.model = mockModel(textStreamChunks("ok"));
    holders.mcpTools = {};
    traceStore = recordingTraceStore();
    analytics = recordingAnalyticsClient();
    server = await startServer({ traceStore, analytics });
  });

  afterAll(async () => {
    await server.app.close();
  });

  it("does not appear in the persisted raw_traces row or any captured analytics property", async () => {
    const res = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenCode-Key": CANARY_KEY,
      },
      body: JSON.stringify({
        id: "tab-leak-1",
        userId: "22222222-2222-4222-8222-222222222222",
        messages: [userMessage("hi")],
        model: "opencode-go/glm-5.3-flash",
      }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so onFinish fires

    await vi.waitFor(() => expect(traceStore.rows).toHaveLength(1));
    const traceSerialized = JSON.stringify(traceStore.rows);
    expect(traceSerialized).not.toContain(CANARY_MARKER);

    await vi.waitFor(() =>
      expect(analytics.events.some((e) => e.event === "agent_turn_completed")).toBe(
        true,
      ),
    );
    const analyticsSerialized = JSON.stringify(analytics.events);
    expect(analyticsSerialized).not.toContain(CANARY_MARKER);
  });

  it("does not appear anywhere in a rejected (no-key) opencode_key_required turn's analytics either", async () => {
    // Sanity companion: the 400 path itself must never echo a key back
    // (there is none on this request, but this pins that the failure
    // response/analytics never grow a field that could carry one).
    const res = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "tab-leak-2",
        messages: [userMessage("hi")],
        model: "opencode-go/glm-5.3-flash",
      }),
    });
    expect(res.status).toBe(400);
    const serialized = JSON.stringify(analytics.events);
    expect(serialized).not.toContain(CANARY_MARKER);
  });
});
