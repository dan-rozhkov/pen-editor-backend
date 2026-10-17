import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { chatMocks, mockModel, textStreamChunks, userMessage } from "./chatMocks.js";
import { postChat, startApp, type RunningApp } from "./chatHarness.js";

// Confirms @fastify/rate-limit's route-level config.rateLimit still fires a
// 429 on /api/chat despite the handler calling reply.hijack() and piping to
// reply.raw — the plugin's check runs on the onRequest hook, which executes
// before the route handler body (and therefore before hijack()) regardless.

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

let server: RunningApp;

beforeAll(async () => {
  await loadSkills();
  chatMocks.model = mockModel(textStreamChunks("hi"));
  server = await startApp(makeConfig());
});

afterAll(async () => {
  await server.close();
});

function chatBody() {
  return {
    id: "session-1",
    messages: [userMessage("hello")],
  };
}

describe("POST /api/chat rate limiting", () => {
  it("returns 429 once the per-IP limit (60/min) is exceeded, even though the route hijacks the reply", async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 61; i++) {
      responses.push(await postChat(server.url, chatBody()));
    }
    const statuses = responses.map((r) => r.status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);

    // The 429 must be a real, well-formed Fastify response — not a hung or
    // truncated stream — confirming the rate-limit check ran on the
    // onRequest hook and short-circuited before the handler's reply.hijack().
    const body = await responses[60].json();
    expect(body).toHaveProperty("error");
  });
});

describe("POST /api/chat rate limiting: browse turns", () => {
  const shapeOf = async (r: Response) => ({
    status: r.status,
    headerNames: ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"].map((h) => [h, r.headers.has(h)]),
    body: await r.json(),
  });

  it("lets browse turns past the main cap of 60 with 200s, while main turns stay limited at 60", async () => {
    const own = await startApp(makeConfig({ BROWSE_MODE: "agent" }));
    try {
      const browseBody = { ...chatBody(), agentMode: "browse" };
      for (let i = 0; i < 70; i++) {
        expect((await postChat(own.url, browseBody)).status).toBe(200);
      }
      // The main counter is untouched by those 70 browse turns.
      for (let i = 0; i < 60; i++) {
        expect((await postChat(own.url, chatBody())).status).toBe(200);
      }
      expect((await postChat(own.url, chatBody())).status).toBe(429);
    } finally {
      await own.close();
    }
  });

  it("caps browse turns at the total limit, with the same 429 shape as the main cap", async () => {
    const own = await startApp(makeConfig({ BROWSE_MODE: "agent" }), {
      chatRateLimits: { total: 8, main: 3 },
    });
    try {
      const browseBody = { ...chatBody(), agentMode: "browse" };
      for (let i = 0; i < 8; i++) {
        expect((await postChat(own.url, browseBody)).status).toBe(200);
      }
      const totalCap = await shapeOf(await postChat(own.url, browseBody));
      expect(totalCap.status).toBe(429);
      await own.close();

      const own2 = await startApp(makeConfig({ BROWSE_MODE: "agent" }), {
        chatRateLimits: { total: 8, main: 3 },
      });
      try {
        for (let i = 0; i < 3; i++) await postChat(own2.url, chatBody());
        const mainCap = await shapeOf(await postChat(own2.url, chatBody()));
        expect(mainCap.status).toBe(429);
        expect(mainCap.headerNames).toEqual(totalCap.headerNames);
        expect(Object.keys(mainCap.body)).toEqual(Object.keys(totalCap.body));
        expect(mainCap.body).toMatchObject({ statusCode: 429, error: "Too Many Requests" });
        expect(mainCap.body.message).toMatch(/^Rate limit exceeded, retry in /);
      } finally {
        await own2.close();
      }
    } finally {
      // own already closed above on the happy path; closing twice is harmless.
      await own.close().catch(() => {});
    }
  });

  it("treats agentMode browse as a main turn when BROWSE_MODE is not agent", async () => {
    const own = await startApp(makeConfig(), { chatRateLimits: { total: 100, main: 3 } });
    try {
      const body = { ...chatBody(), agentMode: "browse" };
      // The route refuses these with 400 (browse disabled) but they still count as main.
      for (let i = 0; i < 3; i++) await postChat(own.url, body);
      expect((await postChat(own.url, body)).status).toBe(429);
    } finally {
      await own.close();
    }
  });
});
