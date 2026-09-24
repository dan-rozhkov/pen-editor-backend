import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";
import { resetChatMocks, userMessage } from "./chatMocks.js";
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
});
