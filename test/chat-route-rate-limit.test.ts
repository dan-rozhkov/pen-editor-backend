import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

// Confirms @fastify/rate-limit's route-level config.rateLimit still fires a
// 429 on /api/chat despite the handler calling reply.hijack() and piping to
// reply.raw — the plugin's check runs as a preHandler, which executes before
// the route handler body (and therefore before hijack()) regardless.

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

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(
    () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: textStreamChunks("hi"),
            chunkDelayInMs: null,
          }),
        }),
      }),
  ),
}));

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  await loadSkills();
  app = await buildApp(makeConfig(), { logger: false });
  // The chat route hijacks the reply and pipes to reply.raw, which
  // app.inject() does not stream reliably — use a real listener + fetch,
  // same as test/chat-route.test.ts.
  url = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

function chatBody() {
  return {
    id: "session-1",
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ],
  };
}

async function postChat(): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatBody()),
  });
}

describe("POST /api/chat rate limiting", () => {
  it("returns 429 once the per-IP limit (60/min) is exceeded, even though the route hijacks the reply", async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 61; i++) {
      responses.push(await postChat());
    }
    const statuses = responses.map((r) => r.status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);

    // The 429 must be a real, well-formed Fastify response — not a hung or
    // truncated stream — confirming the rate-limit check ran as a
    // preHandler and short-circuited before the handler's reply.hijack().
    const body = await responses[60].json();
    expect(body).toHaveProperty("error");
  });
});
