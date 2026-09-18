import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";

// Same mocking shape as test/chat-route.test.ts — createModel is faked so no
// real provider call is ever made, but the REAL parseModelRef/isOpenCodeProvider
// (re-exported by src/ai/provider.js) keep running, since the chat route's
// opencode-key-required check depends on them.
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

interface RunningServer {
  app: FastifyInstance;
  url: string;
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

async function startServer(
  config = makeConfig(),
  analytics?: AnalyticsClient,
): Promise<RunningServer> {
  const app = await buildApp(config, { logger: false, analytics });
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

let server: RunningServer;

beforeAll(async () => {
  await loadSkills();
  server = await startServer();
});

afterAll(async () => {
  await server.app.close();
});

beforeEach(() => {
  holders.model = mockModel(textStreamChunks("ok"));
  holders.mcpTools = {};
});

describe("POST /api/chat — OpenCode BYOK model selection", () => {
  it("400s an allowlisted opencode model with no X-OpenCode-Key header", async () => {
    const analytics = recordingAnalyticsClient();
    const { app, url } = await startServer(makeConfig(), analytics);

    const res = await postChat(url, {
      messages: [userMessage("hi")],
      model: "opencode-go/glm-5.3-flash",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("opencode_key_required");
    expect(body.error).toBeTruthy();

    await vi.waitFor(() =>
      expect(
        analytics.events.some(
          (e) =>
            e.event === "agent_turn_failed" &&
            e.properties?.error_kind === "opencode_key_required",
        ),
      ).toBe(true),
    );

    await app.close();
  });

  it("runs the turn when an opencode model is picked WITH the header, and forwards the key + sessionId to createModel", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();

    const res = await postChat(
      server.url,
      {
        id: "tab-opencode-1",
        messages: [userMessage("hi")],
        model: "opencode-go/glm-5.3-flash",
      },
      { "X-OpenCode-Key": "sk-test-abc123" },
    );

    expect(res.status).toBe(200);
    await res.text();

    const call = vi.mocked(createModel).mock.calls[0];
    expect(call?.[1]).toBe("opencode-go/glm-5.3-flash");
    expect(call?.[2]).toMatchObject({
      chatAgent: true,
      sessionId: "tab-opencode-1",
      opencodeApiKey: "sk-test-abc123",
    });
  });

  it("still ignores an UNKNOWN model id and runs the default (no 400, no key required)", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();

    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: "opencode-go/totally-unknown-model",
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createModel).mock.calls[0]?.[1]).toBeUndefined();
  });

  it("still runs a normal OpenRouter model with no header", async () => {
    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: "z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});
