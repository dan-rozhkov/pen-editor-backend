import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalApp } from "../src/local/app.js";
import { loadLocalConfig } from "../src/local/config.js";
import { createFileMemoryStore } from "../src/ai/memory/fileStore.js";
import { MEMORY_REVIEW_PROMPT } from "../src/ai/memory/prompts.js";
import { userMessage } from "./chatMocks.js";
import { startMockProvider } from "../scripts/lib/mockOpenAiProvider.mjs";

const TOKEN = "local-memory-token";
const USER = "3b241101-e2bb-4255-8caf-4136c566a962";
const CAPS = { desktopBrowser: true, browser: "desktop" as const };

describe("local app memory", () => {
  let dir: string;
  let app: FastifyInstance;
  let url: string;
  let store: ReturnType<typeof createFileMemoryStore>;
  let mock: Awaited<ReturnType<typeof startMockProvider>>;
  const headers = { "x-sideform-local-token": TOKEN };
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}${path.includes("?") ? "&" : "?"}userId=${USER}`, {
      method,
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const chat = async () => {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-byok-base-url": mock.baseUrl, "x-byok-key": "sk-user-secret" },
      body: JSON.stringify({ messages: [userMessage("hi")], agentMode: "browser", model: "byok/mock-model", clientCapabilities: CAPS, userId: USER, id: "chat-1" }),
    });
    await res.text();
  };
  const modelCalls = () => mock.requests.filter((r) => r.url === "/v1/chat/completions");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-memory-"));
    mock = await startMockProvider("ok");
    store = createFileMemoryStore(join(dir, "agent-memory.json"));
    // Review after every completed turn.
    const config = { ...loadLocalConfig({}), MEMORY_REVIEW_INTERVAL: 1 };
    app = await buildLocalApp(config, { logger: false, token: TOKEN, memoryStore: store });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  afterAll(async () => {
    await app.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    mock.requests.length = 0;
  });

  it("needs the token and a userId", async () => {
    expect((await fetch(`${url}/api/memory?userId=${USER}`)).status).toBe(401);
    expect((await fetch(`${url}/api/memory`, { headers })).status).toBe(400);
    expect((await fetch(`${url}/api/memory/activity`, { headers })).status).toBe(400);
  });

  it("reads, switches, deletes and clears memory of the file store, and reports the activity", async () => {
    const empty = await (await call("GET", "/api/memory")).json();
    expect(empty).toMatchObject({ available: true, enabled: true, memory: [], user: [], limits: { memory: 2200, user: 1375 } });

    // Seed through the app's own store, as the model's memory tool would.
    await store.applyOperations({ userId: USER, target: "user", operations: [{ action: "add", content: "likes tea" }, { action: "add", content: "lives in Oslo" }], origin: "foreground" });
    await store.applyOperations({ userId: USER, target: "memory", operations: [{ action: "add", content: "site X needs a cookie click" }], origin: "background_review", attribution: { chatId: "c1", messageId: "m1" } });

    const stored = await (await call("GET", "/api/memory")).json();
    expect(stored).toMatchObject({ user: ["likes tea", "lives in Oslo"], memory: ["site X needs a cookie click"] });

    expect(await (await call("PUT", "/api/memory/settings", { enabled: false })).json()).toEqual({ enabled: false });
    expect(await (await call("GET", "/api/memory")).json()).toMatchObject({ enabled: false });
    await call("PUT", "/api/memory/settings", { enabled: true });

    expect((await call("DELETE", "/api/memory/entry", { target: "user", text: "nope" })).status).toBe(404);
    expect(await (await call("DELETE", "/api/memory/entry", { target: "user", text: "likes tea" })).json()).toEqual({ removed: true });
    expect(await (await call("GET", "/api/memory")).json()).toMatchObject({ user: ["lives in Oslo"] });

    const baseline = await (await call("GET", "/api/memory/activity")).json();
    expect(baseline).toEqual({ events: [], latestId: expect.any(Number) });
    const feed = (await (await call("GET", "/api/memory/activity?sinceId=0")).json()) as { events: Array<Record<string, unknown>> };
    expect(feed.events.map((e) => e.action)).toEqual(["add+add", "add", "remove_entry"]);
    expect(feed.events[1]).toMatchObject({ origin: "background_review", chatId: "c1", messageId: "m1", detail: { kind: "memory", target: "memory" } });

    expect(await (await call("DELETE", "/api/memory")).json()).toEqual({ cleared: { memory: 1, user: 1 } });
    expect(await (await call("GET", "/api/memory")).json()).toMatchObject({ memory: [], user: [] });

    // On the user's device, in the data dir.
    const onDisk = JSON.parse(await readFile(join(dir, "agent-memory.json"), "utf8")) as { users: Record<string, unknown> };
    expect(Object.keys(onDisk.users)).toEqual([USER]);
  });

  it("puts the stored memory into a browser turn, and reviews it on the user's own model and key", async () => {
    await store.applyOperations({ userId: USER, target: "user", operations: [{ action: "add", content: "prefers metric units" }], origin: "foreground" });

    await chat();
    // The foreground turn, then the background review (fire-and-forget).
    await vi.waitFor(() => expect(modelCalls()).toHaveLength(2));
    const [turn, review] = modelCalls();
    expect(JSON.stringify(turn.body.messages)).toContain("prefers metric units");
    expect((turn.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toContain("memory");
    expect(JSON.stringify(review.body.messages)).toContain(MEMORY_REVIEW_PROMPT.slice(0, 60));
    for (const r of [turn, review]) {
      expect(r.body.model).toBe("mock-model");
      expect(r.authorization).toBe("Bearer sk-user-secret");
    }
    // The credentials stay out of the stored file (audit rows included).
    expect(await readFile(join(dir, "agent-memory.json"), "utf8")).not.toContain("sk-user-secret");
    const audit = await store.listAuditActivity({ userId: USER, sinceId: 0 });
    expect(JSON.stringify(audit)).not.toContain("sk-user-secret");
  });
});

describe("local app without a data dir", () => {
  it("answers the unavailable shapes and runs a chat turn with no memory", async () => {
    const mock = await startMockProvider("ok");
    const app = await buildLocalApp(loadLocalConfig({}), { logger: false, insecureDev: true });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    expect(await (await fetch(`${url}/api/memory?userId=${USER}`)).json()).toMatchObject({ available: false, memory: [], user: [] });
    expect((await fetch(`${url}/api/memory?userId=${USER}`, { method: "DELETE" })).status).toBe(503);
    expect(await (await fetch(`${url}/api/memory/activity?userId=${USER}`)).json()).toEqual({ events: [], latestId: null });

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-byok-base-url": mock.baseUrl, "x-byok-key": "k" },
      body: JSON.stringify({ messages: [userMessage("hi")], agentMode: "browser", model: "byok/mock-model", clientCapabilities: CAPS, userId: USER }),
    });
    await res.text();
    const calls = mock.requests.filter((r) => r.url === "/v1/chat/completions");
    expect(calls).toHaveLength(1);
    expect((calls[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).not.toContain("memory");
    await app.close();
    await mock.close();
  });
});
