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
