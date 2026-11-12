import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";
import { chatMocks, resetChatMocks, userMessage } from "./chatMocks.js";
import {
  chatTurn,
  postChat,
  recordingAnalyticsClient,
  recordingTraceStore,
  startApp,
  waitForEvent,
  type RunningApp,
} from "./chatHarness.js";

// A visible canary value: the OpenCode key sent on this turn must never
// appear anywhere it could be persisted or exported — raw_traces, PostHog
// event properties, or (implicitly, since we never inspect them) log lines.
const CANARY_KEY = "sk-test-LEAK-CANARY";
const CANARY_MARKER = "LEAK-CANARY";

// See the hoisting contract at the top of test/chatMocks.ts.
vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

beforeAll(async () => {
  await loadSkills();
});

describe("OpenCode key never leaks into raw_traces or PostHog", () => {
  let server: RunningApp;
  let traceStore: TraceStore & { rows: RawTraceRow[] };
  let analytics: AnalyticsClient & { events: AnalyticsEvent[] };

  beforeAll(async () => {
    resetChatMocks();
    traceStore = recordingTraceStore();
    analytics = recordingAnalyticsClient();
    server = await startApp(makeConfig(), { traceStore, analytics });
  });

  afterAll(async () => {
    await server.close();
  });

  it("does not appear in the persisted raw_traces row or any captured analytics property", async () => {
    const { res } = await chatTurn(
      server.url,
      {
        id: "tab-leak-1",
        userId: "22222222-2222-4222-8222-222222222222",
        messages: [userMessage("hi")],
        model: "opencode-go/glm-5.3-flash",
      },
      { "X-OpenCode-Key": CANARY_KEY },
    );
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(traceStore.rows).toHaveLength(1));
    const traceSerialized = JSON.stringify(traceStore.rows);
    expect(traceSerialized).not.toContain(CANARY_MARKER);

    await waitForEvent(analytics, "agent_turn_completed");
    const analyticsSerialized = JSON.stringify(analytics.events);
    expect(analyticsSerialized).not.toContain(CANARY_MARKER);
  });

  it("does not appear anywhere in a rejected (no-key) opencode_key_required turn's analytics either", async () => {
    // Sanity companion: the 400 path itself must never echo a key back
    // (there is none on this request, but this pins that the failure
    // response/analytics never grow a field that could carry one).
    const res = await postChat(server.url, {
      id: "tab-leak-2",
      messages: [userMessage("hi")],
      model: "opencode-go/glm-5.3-flash",
    });
    expect(res.status).toBe(400);
    const serialized = JSON.stringify(analytics.events);
    expect(serialized).not.toContain(CANARY_MARKER);
  });

  it("does not leak the BYOK key or base URL into raw_traces or analytics", async () => {
    const { res } = await chatTurn(
      server.url,
      { id: "tab-leak-byok", messages: [userMessage("hi")], model: "byok/some-model" },
      { "X-BYOK-Key": "sk-BYOK-CANARY", "X-BYOK-Base-URL": "https://byok-canary.example.com/v1" },
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(traceStore.rows.some((r) => r.sessionId === "tab-leak-byok")).toBe(true));
    await waitForEvent(analytics, "agent_turn_completed");
    const serialized = JSON.stringify([traceStore.rows, analytics.events]);
    expect(serialized).not.toContain("BYOK-CANARY");
    expect(serialized).not.toContain("byok-canary.example.com");
  });

  it("keeps host and key out of traces and analytics when the BYOK provider fails", async () => {
    chatMocks.model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "401 from https://byok-canary.example.com/v1 for key sk-BYOK-CANARY",
          url: "https://byok-canary.example.com/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 401,
          responseBody: "bad key sk-BYOK-CANARY",
        });
      },
    });
    await chatTurn(
      server.url,
      { id: "tab-leak-byok-fail", messages: [userMessage("hi")], model: "byok/some-model" },
      { "X-BYOK-Key": "sk-BYOK-CANARY", "X-BYOK-Base-URL": "https://byok-canary.example.com/v1" },
    );
    await vi.waitFor(() => expect(traceStore.rows.some((r) => r.sessionId === "tab-leak-byok-fail")).toBe(true));
    const row = traceStore.rows.find((r) => r.sessionId === "tab-leak-byok-fail");
    expect(row?.streamError).toBe("byok provider error (HTTP 401)");
    await waitForEvent(analytics, "agent_turn_failed");
    const serialized = JSON.stringify([traceStore.rows.filter((r) => r.sessionId === "tab-leak-byok-fail"), analytics.events]);
    expect(serialized).not.toContain("BYOK-CANARY");
    expect(serialized).not.toContain("byok-canary.example.com");
    resetChatMocks();
  });
});
