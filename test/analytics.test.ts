import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import {
  createAnalyticsClient,
  wrapPostHogClient,
  type AnalyticsClient,
  type AnalyticsEvent,
  type PostHogLike,
} from "../src/analytics/posthog.js";
import { makeConfig } from "./helpers.js";

// ---------------------------------------------------------------------------
// Mocks: same shape as test/chat-route.test.ts / test/chat-trace.test.ts —
// the provider returns a MockLanguageModelV3 (ai/test) and MCP tools are
// controlled per test, no network calls and no real API keys.
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

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallStreamChunks(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: USAGE,
    },
  ];
}

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

async function startServer(analytics: AnalyticsClient): Promise<RunningServer> {
  const app = await buildApp(makeConfig(), { logger: false, analytics, traceStore: null });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

// ---------------------------------------------------------------------------
// createAnalyticsClient unit behavior
// ---------------------------------------------------------------------------

describe("createAnalyticsClient", () => {
  it("returns a no-op client when no apiKey is given — no network, never throws", async () => {
    const client = createAnalyticsClient({});
    expect(() => client.capture({ event: "x", distinctId: "1" })).not.toThrow();
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("capture() never propagates a thrown error from the real posthog-backed branch", () => {
    // Exercises wrapPostHogClient (the real branch createAnalyticsClient
    // returns when an apiKey is set) against a stub shaped like posthog-node's
    // PostHog whose capture() actually throws — unlike the no-op client, this
    // would fail if the try/catch in wrapPostHogClient were ever deleted.
    const throwingClient: PostHogLike = {
      capture() {
        throw new Error("boom");
      },
      async shutdown() {},
    };
    const client = wrapPostHogClient(throwingClient);
    expect(() => client.capture({ event: "x", distinctId: "1" })).not.toThrow();
  });

  it("shutdown() resolves even when the underlying client's shutdown rejects", async () => {
    // Covers finding #1: shutdown() must not hang or reject the onClose
    // chain when posthog-node's own shutdown() rejects (e.g. a PostHog
    // outage at process exit).
    const rejectingClient: PostHogLike = {
      capture() {},
      async shutdown() {
        throw new Error("network outage");
      },
    };
    const client = wrapPostHogClient(rejectingClient);
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown() passes a bounded timeout to the underlying client", async () => {
    let receivedTimeout: number | undefined;
    const client = wrapPostHogClient({
      capture() {},
      async shutdown(timeoutMs) {
        receivedTimeout = timeoutMs;
      },
    });
    await client.shutdown();
    expect(receivedTimeout).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// Chat route integration: agent_turn_completed, PII guard
// ---------------------------------------------------------------------------

describe("chat route analytics", () => {
  it("captures agent_turn_completed with the expected shape and no message text anywhere in properties", async () => {
    holders.model = mockModel(textStreamChunks("this is the secret user message content"));
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "tab-analytics-1",
        userId: "11111111-1111-4111-8111-111111111111",
        messages: [userMessage("this is the secret user message content")],
      }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream so onFinish fires

    await vi.waitFor(() =>
      expect(analytics.events.some((e) => e.event === "agent_turn_completed")).toBe(true),
    );
    const event = analytics.events.find((e) => e.event === "agent_turn_completed")!;

    expect(event.distinctId).toBe("11111111-1111-4111-8111-111111111111");
    expect(event.properties).toMatchObject({
      model: expect.any(String),
      duration_ms: expect.any(Number),
      tool_call_count: 0,
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      mode: "edits",
      // Finding #2: a step-less final step is a real, complete user turn.
      turn_complete: true,
    });

    // PII guard: the raw message text must never appear anywhere in the
    // captured properties of ANY event this turn produced.
    const serialized = JSON.stringify(analytics.events);
    expect(serialized).not.toContain("this is the secret user message content");

    await app.close();
  });

  it("falls back to the session id as distinctId when no userId is sent", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    await (
      await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "tab-no-user-1", messages: [userMessage("hi")] }),
      })
    ).text();

    await vi.waitFor(() =>
      expect(analytics.events.some((e) => e.event === "agent_turn_completed")).toBe(true),
    );
    const event = analytics.events.find((e) => e.event === "agent_turn_completed")!;
    expect(event.distinctId).toBe("tab-no-user-1");

    await app.close();
  });

  it("marks turn_complete: false when the final step still has a pending client-executed tool call", async () => {
    // batch_design has no `execute` in penTools (client-executed), so the
    // step ends with a tool call the model handed to the browser — the
    // client would auto-resend a continuation request for this one, so it
    // must NOT be reported as a complete user turn.
    holders.model = mockModel(
      toolCallStreamChunks("batch_design", { screens: [] }),
    );
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    await (
      await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "tab-turn-incomplete-1", messages: [userMessage("hi")] }),
      })
    ).text();

    await vi.waitFor(() =>
      expect(analytics.events.some((e) => e.event === "agent_turn_completed")).toBe(true),
    );
    const event = analytics.events.find((e) => e.event === "agent_turn_completed")!;
    expect(event.properties?.turn_complete).toBe(false);
    expect(event.properties?.tool_call_count as number).toBeGreaterThan(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// api_request onResponse hook
// ---------------------------------------------------------------------------

describe("api_request analytics hook", () => {
  it("fires for a normal route and does not fire for excluded routes", async () => {
    holders.model = mockModel(textStreamChunks("hi"));
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    // A normal route: GET /api/models.
    const modelsRes = await fetch(`${url}/api/models`);
    expect(modelsRes.status).toBe(200);

    // The excluded chat route.
    await (
      await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "tab-hook-1", messages: [userMessage("hi")] }),
      })
    ).text();

    await vi.waitFor(() =>
      expect(analytics.events.some((e) => e.event === "api_request")).toBe(true),
    );

    const apiRequestEvents = analytics.events.filter((e) => e.event === "api_request");
    expect(apiRequestEvents.some((e) => e.properties?.route === "/api/models")).toBe(true);
    expect(apiRequestEvents.some((e) => e.properties?.route === "/api/chat")).toBe(false);

    // Finding #3: api_request has no real person behind its fixed "api"
    // distinctId, so every event must opt out of PostHog's person-profile
    // processing; agent_turn_completed carries a real anonymous user id and
    // must stay person-scoped (the property must be absent, not `true`).
    for (const event of apiRequestEvents) {
      expect(event.properties?.$process_person_profile).toBe(false);
    }
    const turnCompletedEvent = analytics.events.find((e) => e.event === "agent_turn_completed");
    expect(turnCompletedEvent?.properties?.$process_person_profile).toBeUndefined();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Early-rejection analytics (finding #6): requests that never reach
// streamText must still emit an agent_turn_failed with a coarse error_kind.
// ---------------------------------------------------------------------------

describe("early-rejection analytics", () => {
  it("captures agent_turn_failed with error_kind: model_not_allowed for a disallowed model", async () => {
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "tab-early-reject-1",
        model: "not-a-real-model",
        messages: [userMessage("hi")],
      }),
    });
    expect(res.status).toBe(400);

    expect(analytics.events).toContainEqual(
      expect.objectContaining({
        event: "agent_turn_failed",
        distinctId: "tab-early-reject-1",
        properties: expect.objectContaining({ error_kind: "model_not_allowed" }),
      }),
    );

    await app.close();
  });

  it("captures agent_turn_failed with error_kind: invalid_request for a malformed body", async () => {
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(analytics);

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);

    expect(analytics.events).toContainEqual(
      expect.objectContaining({
        event: "agent_turn_failed",
        properties: expect.objectContaining({ error_kind: "invalid_request" }),
      }),
    );

    await app.close();
  });
});
