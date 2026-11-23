import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { generateText } from "ai";
import { createByokModel } from "../src/ai/byok.js";
import { isOpenCodeHost, withOpenCodeHeaders } from "../src/ai/opencode.js";
import { byokRoutes, extractByokModels } from "../src/routes/byok.js";
import { makeConfig } from "./helpers.js";

const okChat = () =>
  new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

async function chatHeaders(baseUrl: string, sessionId?: string, times = 1) {
  const f = vi.fn<typeof fetch>(async () => okChat());
  const model = createByokModel({
    baseUrl,
    apiKey: "k",
    modelId: "m",
    allowPrivateNetwork: false,
    sessionId,
    fetch: f,
  });
  for (let i = 0; i < times; i++) await generateText({ model, prompt: "hi" });
  return f.mock.calls.map(([, init]) => new Headers(init?.headers));
}

describe("isOpenCodeHost", () => {
  it("matches opencode.ai and subdomains only", () => {
    expect(isOpenCodeHost("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeHost("https://api.opencode.ai/v1")).toBe(true);
    expect(isOpenCodeHost("https://evilopencode.ai/v1")).toBe(false);
    expect(isOpenCodeHost("https://opencode.ai.evil.com/v1")).toBe(false);
    expect(isOpenCodeHost("nope")).toBe(false);
  });
});

describe("createByokModel on OpenCode", () => {
  it("sends the sanitized session id and leaves the user agent alone", async () => {
    const [h] = await chatHeaders("https://opencode.ai/zen/go/v1", "chat 1\r\n/abc");
    expect(h.get("x-opencode-session")).toBe("chat1abc");
    expect(h.get("user-agent")).not.toContain("pen-editor-design-agent");
  });

  it("falls back to one random uuid per model instance", async () => {
    const hs = await chatHeaders("https://opencode.ai/zen/go/v1", "\r\n", 2);
    const id = hs[0].get("x-opencode-session");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(hs[1].get("x-opencode-session")).toBe(id);
  });

  it("adds no session header for other providers", async () => {
    const [h] = await chatHeaders("https://api.example.com/v1", "abc");
    expect(h.get("x-opencode-session")).toBeNull();
  });
});

describe("POST /api/byok/models on OpenCode", () => {
  const run = async (baseUrl: string, body: unknown) => {
    const upstream = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );
    const app = Fastify();
    await byokRoutes(app, makeConfig(), { fetchImpl: upstream });
    const res = await app.inject({
      method: "POST",
      url: "/api/byok/models",
      headers: { "x-byok-base-url": baseUrl, "x-byok-key": "sk" },
    });
    await app.close();
    return { res, init: upstream.mock.calls[0][1] };
  };

  it("sends the session header, keeps the user agent, filters by chat-completions", async () => {
    const { res, init } = await run("https://opencode.ai/zen/go/v1", {
      data: [
        { id: "a", api: { "chat-completions": {} } },
        { id: "b", api: { responses: {} } },
        { id: "c", api: { messages: {} } },
        { id: "d" },
        { id: "e", api: { "chat-completions": false } },
      ],
    });
    const h = new Headers(init?.headers);
    expect(h.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.get("authorization")).toBe("Bearer sk");
    expect(h.get("user-agent")).toBeNull();
    expect(res.json()).toEqual({ ok: true, models: [{ id: "a" }, { id: "d" }] });
  });

  it("changes nothing for other hosts", async () => {
    const { res, init } = await run("https://api.example.com/v1", {
      data: [{ id: "b", api: { responses: {} } }],
    });
    expect(new Headers(init?.headers).get("x-opencode-session")).toBeNull();
    expect(res.json()).toEqual({ ok: true, models: [{ id: "b" }] });
    expect(extractByokModels([{ id: "z", api: { responses: {} } }])).toEqual([{ id: "z" }]);
  });
});

describe("withOpenCodeHeaders", () => {
  it("keeps the headers of a Request input", async () => {
    const base = vi.fn<typeof fetch>(async () => new Response("{}"));
    const f = withOpenCodeHeaders(base, "s-1");
    await f(new Request("https://opencode.ai/zen/go/v1/models", { headers: { Authorization: "Bearer sk" } }));
    const h = new Headers(base.mock.calls[0][1]?.headers);
    expect(h.get("authorization")).toBe("Bearer sk");
    expect(h.get("x-opencode-session")).toBe("s-1");
    expect(h.get("user-agent")).toBeNull();
  });
});
