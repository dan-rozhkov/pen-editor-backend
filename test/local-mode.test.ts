import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildLocalApp } from "../src/local/app.js";
import { loadLocalConfig } from "../src/local/config.js";
import { createModel } from "../src/ai/provider.js";
import { errorStatusCode } from "../src/lib/httpDefaults.js";
import { watchParent } from "../src/local/parentWatch.js";
import { moveToolResultImagesToUserMessage } from "../src/ai/opencode.js";
import { parseSse } from "./chatHarness.js";
import { userMessage } from "./chatMocks.js";
import { makeConfig } from "./helpers.js";
import { startMockProvider } from "../scripts/lib/mockOpenAiProvider.mjs";
import { startLocalMemoryApp } from "./localMemoryApp.js";

const TOKEN = "local-test-token";
const MODEL_TEXT = "streamed from the user's own provider";
const CAPS = { desktopBrowser: true, browser: "desktop" as const };

describe("loadLocalConfig", () => {
  const hostedEnv = {
    OPENROUTER_API_KEY: "sk-or-real",
    TYPESAFE_API_KEY: "ts-key",
    TRACE_DATABASE_URL: "postgres://u:p@db/x",
    BETTER_AUTH_SECRET: "s".repeat(40),
    POSTHOG_API_KEY: "ph-key",
    S3_ENDPOINT: "https://s3.example.com",
    TAVILY_API_KEY: "tvly",
    GITHUB_TOKEN: "ghp",
    FAL_KEY: "fal",
    STEEL_API_KEY: "steel",
    MCP_AUTH_TOKEN: "m".repeat(32),
    MEMORY_ENABLED: "true",
    SELF_SKILLS_ENABLED: "true",
    SKILL_ROUTING_MODE: "enforce",
    VISION_MODEL: "openrouter:google/gemini-2.5-flash",
    QA_JUDGE_MODEL: "openrouter:google/gemini-2.5-flash",
    BYOK_ALLOW_PRIVATE_NETWORK: "false",
    CORS_ALLOWED_ORIGINS: "https://evil.example",
    PORT: "4123",
    HOST: "127.0.0.1",
  };

  it("needs no OPENROUTER_API_KEY and ignores every inherited server feature", () => {
    const config = loadLocalConfig(hostedEnv);
    expect(config).toMatchObject({
      SIDEFORM_LOCAL: true,
      OPENROUTER_API_KEY: "",
      // Memory is on (a file on the user's device); the TypeSafe write filter cannot be.
      MEMORY_ENABLED: true,
      MEMORY_FILTER_MODE: "off",
      SELF_SKILLS_ENABLED: false,
      SKILL_ROUTING_MODE: "off",
      VISION_MODEL: "",
      QA_JUDGE_MODEL: "off",
      BYOK_ALLOW_PRIVATE_NETWORK: true,
      BROWSE_MODE: "agent",
    });
    const unset = [
      "TYPESAFE_API_KEY", "TRACE_DATABASE_URL", "BETTER_AUTH_SECRET", "POSTHOG_API_KEY", "S3_ENDPOINT",
      "TAVILY_API_KEY", "GITHUB_TOKEN", "FAL_KEY", "STEEL_API_KEY", "MCP_AUTH_TOKEN", "CORS_ALLOWED_ORIGINS",
    ] as const;
    expect(unset.map((key) => config[key])).toEqual(unset.map(() => undefined));
  });

  it("takes only PORT from the environment and always binds 127.0.0.1", () => {
    expect(loadLocalConfig(hostedEnv)).toMatchObject({ PORT: 4123, HOST: "127.0.0.1" });
    expect(loadLocalConfig({ HOST: "0.0.0.0" })).toMatchObject({ PORT: 0, HOST: "127.0.0.1" });
  });
});

describe("createModel in local mode", () => {
  it("refuses a server-side model instead of calling OpenRouter", () => {
    const config = loadLocalConfig({});
    expect(() => createModel(config)).toThrow(/local mode/);
    expect(() => createModel(config, "openrouter:google/gemini-2.5-flash")).toThrow(/local mode/);
    // OpenCode would otherwise be built before the OpenRouter backstop.
    expect(() => createModel(config, "opencode-go/glm-5.3-flash", { opencodeApiKey: "k" })).toThrow(/local mode/);
  });

  it("refuses OpenRouter even in a hosted config without a key", () => {
    const noKey = () => createModel(makeConfig({ OPENROUTER_API_KEY: "" }));
    expect(noKey).toThrow(/No server-side model/);
    expect(noKey).not.toThrow(/local mode/);
  });
});

describe("local app", () => {
  let app: FastifyInstance;
  let url: string;
  let mock: Awaited<ReturnType<typeof startMockProvider>>;
  const authed = { "x-sideform-local-token": TOKEN };
  const byokHeaders = () => ({ ...authed, "x-byok-base-url": mock.baseUrl, "x-byok-key": "sk-user" });
  const post = (path: string, body: unknown, headers: Record<string, string> = authed) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const chat = (extra: Record<string, unknown>) =>
    post("/api/chat", { messages: [userMessage("hi")], clientCapabilities: CAPS, ...extra }, byokHeaders());

  beforeAll(async () => {
    mock = await startMockProvider(MODEL_TEXT);
    app = await buildLocalApp(loadLocalConfig({}), { logger: false, token: TOKEN, chatRateLimits: { main: 5 } });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await app.close();
    await mock.close();
  });
  afterEach(() => {
    mock.requests.length = 0;
    vi.restoreAllMocks();
  });

  it("403s a Host header other than 127.0.0.1:<port> / localhost:<port> (DNS rebinding), before the token check", async () => {
    const port = new URL(url).port;
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `localhost.evil.example:${port}`, ""]) {
      const res = await app.inject({ method: "GET", url: "/api/models", headers: { ...authed, host } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden_host" });
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await app.inject({ method: "GET", url: "/api/models", headers: { ...authed, host } })).statusCode).toBe(200);
    }
  });

  it("401s a request without or with a wrong token, on every route", async () => {
    for (const headers of [{}, { "x-sideform-local-token": "nope" }, { "x-sideform-local-token": `${TOKEN}x` }]) {
      const res = await fetch(`${url}/api/models`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await post("/api/chat", {}, {})).status).toBe(401);
    expect((await fetch(`${url}/nothing-here`)).status).toBe(401);
  });

  it("serves GET /api/models with no server models", async () => {
    const res = await fetch(`${url}/api/models`, { headers: authed });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [],
      default: null,
      visionFallback: false,
      imageOps: { removeBackground: false, vectorize: false },
    });
  });

  it("answers 400 provider_required for no model or a non-byok model", async () => {
    for (const extra of [{}, { model: "deepseek/deepseek-v4.1-flash" }, { model: "opencode-go/glm-5.3-flash" }]) {
      const res = await chat({ agentMode: "browser", ...extra });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "provider_required" });
    }
    expect(mock.requests).toEqual([]);
  });

  it("answers 400 agent_mode_unsupported for any other agentMode, without using up the rate limit", async () => {
    // main limit is 5 per minute: more refused requests than that must not trip it.
    for (const extra of [{}, { agentMode: "edits" }, { agentMode: "research" }, { agentMode: "prototype" }, { agentMode: "edits" }]) {
      const res = await chat({ model: "byok/mock-model", ...extra });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "agent_mode_unsupported" });
    }
    for (let i = 0; i < 4; i++) {
      expect((await chat({ agentMode: "browser", model: "deepseek/x" })).status).toBe(400);
    }
    const ok = await chat({ agentMode: "browser", model: "byok/mock-model" });
    expect(ok.status).toBe(200);
    await ok.text();
    expect(mock.requests).not.toEqual([]);
  });

  it.each(["browser", "browse"] as const)(
    "streams the user's provider text in agentMode %s and talks to no other host",
    async (agentMode) => {
      const globalFetch = vi.spyOn(globalThis, "fetch");
      const res = await chat({ agentMode, model: "byok/mock-model" });
      const body = await res.text();
      expect(res.status).toBe(200);
      const text = parseSse(body)
        .filter((c) => c.type === "text-delta")
        .map((c) => c.delta)
        .join("");
      expect(text).toBe(MODEL_TEXT);
      // Every model call went to the mock, on the parent's model id, with the user's key.
      const calls = mock.requests.filter((r) => r.url === "/v1/chat/completions");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((r) => r.body.model === "mock-model" && r.authorization === "Bearer sk-user")).toBe(true);
      // The only global fetch is this test's own call to the app: nothing else
      // (OpenRouter, vision, judge, ...) left the process through it.
      expect(globalFetch.mock.calls.map(([target]) => String(target))).toEqual([`${url}/api/chat`]);
    },
  );

  it("loads a provider's model list through POST /api/byok/models", async () => {
    const res = await post("/api/byok/models", {}, byokHeaders());
    expect(await res.json()).toEqual({ ok: true, models: [{ id: "mock-model", contextWindow: 32000 }] });
  });

  it("answers the QA judge as disabled and the TypeSafe browse routes as 503", async () => {
    const judge = await post("/api/browse/judge", {});
    expect(judge.status).toBe(200);
    expect(await judge.json()).toEqual({ disabled: true });
    for (const path of ["/api/browse/step", "/api/browse/plan", "/api/browse/locate"]) {
      expect((await post(path, {})).status).toBe(503);
    }
  });

  it("has no other route", async () => {
    for (const path of ["/api/skills", "/api/doc-templates", "/api/auth/get-session", "/api/upload", "/api/mcp", "/health"]) {
      expect((await fetch(`${url}${path}`, { headers: authed })).status).toBe(404);
    }
    for (const path of ["/api/generate-image", "/api/prompt-suggestion", "/api/vector", "/api/showcase/publish"]) {
      expect((await post(path, {})).status).toBe(404);
    }
  });

  it("sets no CORS headers", async () => {
    const res = await chat({ agentMode: "browser", model: "byok/mock-model" });
    await res.text();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const withOrigin = await fetch(`${url}/api/models`, { headers: { ...authed, origin: "https://evil.example" } });
    expect(withOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("screenshots on the user's own model (local mode)", () => {
  const DATA_URL = "data:image/jpeg;base64,QUJDRUxFTUVOVFM";
  const history = () => [
    userMessage("check the signup page"),
    {
      id: "b1",
      role: "assistant",
      parts: [
        {
          type: "tool-browse_screenshot",
          toolCallId: "call-b1",
          state: "output-available",
          input: {},
          output: JSON.stringify({ imageData: DATA_URL, url: "https://example.com", title: "Sign up", width: 390, height: 844 }),
        },
      ],
    },
  ];

  it("keeps browse_screenshot in the browse turn (and not the browser main turn, which delegates)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const config = loadLocalConfig({});
    const byok = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" };
    const browse = await prepareChatTurn({ config, messages: history(), agentMode: "browse", modelOverride: "byok/m", byok, clientCapabilities: CAPS });
    expect(browse.tools.browse_screenshot).toBeDefined();
    const browser = await prepareChatTurn({ config, messages: history(), agentMode: "browser", modelOverride: "byok/m", byok, clientCapabilities: CAPS });
    expect(Object.keys(browser.tools)).toContain("browse_agent");
    expect(browser.tools.browse_screenshot).toBeUndefined();
  });

  it("hosted BYOK is unchanged: no vision, no screenshot tool", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ VISION_MODEL: "" }),
      messages: history(),
      agentMode: "browse",
      modelOverride: "byok/m",
      byok: { baseUrl: "https://api.example.com/v1", apiKey: "k" },
      clientCapabilities: CAPS,
    });
    expect(turn.tools.browse_screenshot).toBeUndefined();
  });

  it("sends a screenshot to the user's model in a user message after a text-only tool message", async () => {
    const mock = await startMockProvider("saw it");
    const app = await buildLocalApp(loadLocalConfig({}), { logger: false, insecureDev: true });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-byok-base-url": mock.baseUrl, "x-byok-key": "k" },
      body: JSON.stringify({ messages: history(), agentMode: "browse", model: "byok/mock-model", clientCapabilities: CAPS }),
    });
    await res.text();
    const sent = mock.requests.find((r) => r.url === "/v1/chat/completions")?.body;
    const messages = sent?.messages as Array<{ role: string; content: unknown }>;
    const toolAt = messages.findIndex((m) => m.role === "tool");
    // OpenAI allows only text in a tool message: no image part, no base64 blob.
    expect(typeof messages[toolAt]?.content).toBe("string");
    expect(messages[toolAt]?.content).toContain("[screenshot attached in the next user message]");
    expect(messages[toolAt]?.content).not.toContain("QUJDRUxFTUVOVFM");
    // The image follows in a user message that names the tool call.
    expect(messages[toolAt + 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Image from tool call call-b1:" },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    });
    expect(JSON.stringify(messages).match(/"type":"image_url"/g)).toHaveLength(1);
    await app.close();
    await mock.close();
  });
});

describe("moveToolResultImagesToUserMessage", () => {
  const img = (data: string) => ({ type: "file", mediaType: "image/png", data: { type: "data", data } });
  const tool = (id: string, parts: unknown[]) => ({ role: "tool", tool_call_id: id, content: JSON.stringify(parts) });

  it("puts the images of a run of tool messages into one user message after the run", () => {
    const out = moveToolResultImagesToUserMessage({
      messages: [
        { role: "assistant", content: null },
        tool("a", [{ type: "text", text: "shot a" }, img("AAA")]),
        tool("b", [img("BBB")]),
        { role: "assistant", content: "next" },
      ],
    }).messages as Array<Record<string, unknown>>;
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
    expect(out[1]?.content).toBe("shot a\n[screenshot attached in the next user message]");
    expect(out[3]?.content).toEqual([
      { type: "text", text: "Image from tool call a:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "text", text: "Image from tool call b:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
    ]);
  });

  it("appends the user message when the history ends with a tool message, and leaves image-free bodies untouched", () => {
    const withImage = moveToolResultImagesToUserMessage({ messages: [tool("a", [img("AAA")])] }).messages as unknown[];
    expect(withImage).toHaveLength(2);
    const plain = { messages: [{ role: "tool", tool_call_id: "a", content: "plain text" }, { role: "user", content: "hi" }] };
    expect(moveToolResultImagesToUserMessage(plain)).toBe(plain);
  });
});

describe("local app without a token", () => {
  it("refuses to build without a token unless insecureDev, and refuses a hosted config", async () => {
    await expect(buildLocalApp(loadLocalConfig({}), { logger: false })).rejects.toThrow(/token/);
    await expect(buildLocalApp(loadLocalConfig({}), { logger: false, token: "" })).rejects.toThrow(/token/);
    await expect(buildLocalApp(makeConfig(), { logger: false, token: TOKEN })).rejects.toThrow(/local config/);
    const app = await buildLocalApp(loadLocalConfig({}), { logger: false, insecureDev: true });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    expect((await fetch(`${url}/api/models`)).status).toBe(200);
    await app.close();
  });
});

describe("shared http defaults", () => {
  it("answers 500 unless the error carries a valid 4xx/5xx statusCode", () => {
    expect([undefined, "404", 200, NaN, 99, 600, 4.5, null].map((statusCode) => errorStatusCode({ statusCode }))).toEqual(Array(8).fill(500));
    expect(errorStatusCode(new Error("x"))).toBe(500);
    expect([400, 429, 503].map((statusCode) => errorStatusCode({ statusCode }))).toEqual([400, 429, 503]);
  });
});

describe("watchParent", () => {
  afterEach(() => vi.useRealTimers());
  const run = (kill: (pid: number, signal: 0) => unknown, currentPpid: () => number = () => 4242) => {
    vi.useFakeTimers();
    const onGone = vi.fn();
    watchParent({ ppid: 4242, onGone, kill, currentPpid });
    return onGone;
  };
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("calls onGone once when the parent pid is gone (ESRCH)", () => {
    let alive = true;
    const onGone = run(() => {
      if (!alive) throw errno("ESRCH");
    });
    vi.advanceTimersByTime(4000);
    expect(onGone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("calls onGone when the process was reparented", () => {
    let ppid = 4242;
    const onGone = run(() => undefined, () => ppid);
    ppid = 1;
    vi.advanceTimersByTime(2000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("treats EPERM as alive", () => {
    const onGone = run(() => {
      throw errno("EPERM");
    });
    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe("local app POST /api/memory/operations", () => {
  const USER = "3b241101-e2bb-4255-8caf-4136c566a962";
  let url: string;
  let close: () => Promise<void>;
  const auth = { "x-sideform-local-token": TOKEN };

  beforeAll(async () => {
    ({ url, close } = await startLocalMemoryApp(TOKEN, "local-mode-memory-ops-"));
  });
  afterAll(() => close());

  const post = (body: unknown, token = true) =>
    fetch(`${url}/api/memory/operations?userId=${USER}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? auth : {}) },
      body: JSON.stringify(body),
    });
  const activity = async (sinceId: number) =>
    (await fetch(`${url}/api/memory/activity?userId=${USER}&sinceId=${sinceId}`, { headers: auth })).json() as Promise<{ latestId: number | null; events: unknown[] }>;

  it("is exposed, needs the token, writes, and emits no activity for a no-op batch", async () => {
    expect((await post({ target: "user", operations: [{ action: "add", content: "a" }] }, false)).status).toBe(401);
    const base = (await activity(0)).latestId ?? 0;
    const add = await post({ target: "user", operations: [{ action: "add", content: "likes tea" }] });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ ok: true, user: ["likes tea"], memory: [] });
    expect((await activity(base)).events).toHaveLength(1);
    const again = await post({ target: "user", operations: [{ action: "add", content: "likes tea" }] });
    expect((await again.json()).user).toEqual(["likes tea"]);
    expect((await activity(base)).events).toHaveLength(1);
  });

  it("409s once memory is switched off", async () => {
    await fetch(`${url}/api/memory/settings?userId=${USER}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await post({ target: "user", operations: [{ action: "add", content: "b" }] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("memory_disabled");
  });
});
