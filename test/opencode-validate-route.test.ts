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
