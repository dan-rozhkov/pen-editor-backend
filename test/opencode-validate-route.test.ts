import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

async function startServer(): Promise<RunningServer> {
  const app = await buildApp(makeConfig(), { logger: false });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

let server: RunningServer;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  await server.app.close();
});

describe("POST /api/opencode/validate", () => {
  it("400s with opencode_key_required when the header is missing", async () => {
    const res = await fetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("opencode_key_required");
  });

  it("returns ok:true with the parsed model ids on a successful upstream response", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      expect(url).toBe("https://opencode.ai/zen/go/v1/models");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-test-key");
      return new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-test-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string; models: string[] };
    expect(body).toEqual({ ok: true, provider: "opencode-go", models: ["glm-5.3-flash"] });
  });

  it("hits the requested provider's base URL when provider is 'opencode'", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      expect(url).toBe("https://opencode.ai/zen/v1/models");
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-test-key" },
      body: JSON.stringify({ provider: "opencode" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("opencode");
  });

  it("returns ok:false reason:invalid_key on an upstream 401", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      return new Response("unauthorized", { status: 401 });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-bad-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "invalid_key" });
  });

  it("returns ok:false reason:upstream_error on an upstream 500", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      return new Response("boom", { status: 500 });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-test-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "upstream_error" });
  });

  // Regression (defect 4): the default provider used to be hardcoded to
  // "opencode-go", so a key that only works on Zen ("opencode") always
  // failed validation here even though the same key would succeed in a
  // real chat turn on a Zen model. With no `provider` in the body, Go must
  // be tried first, and — because Go rejects it with 401 — Zen must be
  // tried second and win.
  it("falls back to the Zen base when Go rejects the key and no provider was specified", async () => {
    let goCalled = false;
    let zenCalled = false;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      if (url === "https://opencode.ai/zen/go/v1/models") {
        goCalled = true;
        return new Response("unauthorized", { status: 401 });
      }
      if (url === "https://opencode.ai/zen/v1/models") {
        zenCalled = true;
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-zen-only-key");
        return new Response(JSON.stringify({ data: [{ id: "minimax-m3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected upstream url: ${url}`);
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-zen-only-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string; models: string[] };
    expect(body).toEqual({ ok: true, provider: "opencode", models: ["minimax-m3"] });
    expect(goCalled).toBe(true);
    expect(zenCalled).toBe(true);
  });

  it("returns ok:false reason:invalid_key when BOTH bases reject the key and no provider was specified", async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      callCount += 1;
      return new Response("unauthorized", { status: 401 });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-bad-everywhere" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "invalid_key" });
    expect(callCount).toBe(2);
  });

  it("makes exactly ONE outgoing request when provider is explicitly given", async () => {
    let callCount = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      callCount += 1;
      expect(url).toBe("https://opencode.ai/zen/go/v1/models");
      return new Response("unauthorized", { status: 401 });
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-test-key" },
      body: JSON.stringify({ provider: "opencode-go" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "invalid_key" });
    expect(callCount).toBe(1);
  });

  it("returns ok:false reason:upstream_error when the upstream fetch rejects (network error)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith(server.url)) {
        return realFetch(input, init);
      }
      throw new Error("network unreachable");
    });

    const res = await realFetch(`${server.url}/api/opencode/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenCode-Key": "sk-test-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body).toEqual({ ok: false, reason: "upstream_error" });
  });
});

// Real, unmocked fetch — captured before any spy is installed so the tests
// above can still reach the real HTTP server they started.
const realFetch = globalThis.fetch.bind(globalThis);

describe("POST /api/opencode/validate rate limiting", () => {
  // Regression (defect 3): the route had no `config.rateLimit`, and
  // registerRateLimit (src/plugins/rateLimit.ts) is registered with
  // `global: false` — so without an explicit opt-in this route was entirely
  // unthrottled, unlike every other unauthenticated route that calls out to
  // a third party (chat: 60/min, generateImage/fal/repo: 20/min,
  // prototype-link: 10/min). An unlimited, unauthenticated relay that
  // reports whether an arbitrary caller-supplied key is valid is a free
  // credential-checking oracle. This confirms a 429 now fires once the
  // per-IP budget (10/min, same as prototype-link) is exceeded.
  it("returns 429 once the per-IP limit (10/min) is exceeded", async () => {
    const server2 = await startServer();
    try {
      const responses: Response[] = [];
      for (let i = 0; i < 11; i++) {
        responses.push(
          await realFetch(`${server2.url}/api/opencode/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }),
        );
      }
      const statuses = responses.map((r) => r.status);
      // Every one of the first 10 requests is missing the key header, so
      // each is a 400 (opencode_key_required) — a rejection this route
      // returns BEFORE any upstream call, but still after the rate-limit
      // plugin's onRequest hook, which is what's under test here.
      expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await server2.app.close();
    }
  });
});
