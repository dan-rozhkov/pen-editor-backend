import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

// Finding 4: /api/mobbin/register (and /token, /refresh) are unauthenticated
// — with no allowlist configured, isAllowedRedirectUri accepts any loopback
// port, so without a per-IP cost guard a caller could hammer these routes
// with distinct redirectUris and trigger one live upstream call per request,
// unbounded. Confirms @fastify/rate-limit's route-level config.rateLimit
// actually fires here — the plugin is registered globally with
// `global: false` (src/plugins/rateLimit.ts), so it only applies where a
// route opts in via `config.rateLimit`.
describe("POST /api/mobbin/register rate limiting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns 429 once the per-IP limit (20/min) is exceeded", async () => {
    const app = await buildApp(makeConfig(), { logger: false });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });

    // Stubbing global fetch would also swap out THIS test's own fetch(...)
    // calls to the local server below (they share the same global
    // binding) — so the stub must pass local-server requests straight
    // through to the real fetch, and only fake the outbound call the
    // route handler itself makes to Mobbin's discovery endpoint.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const target = typeof input === "string" ? input : (input as Request).url;
        if (target.startsWith(url)) return realFetch(input as never, init);
        return Promise.resolve(new Response("", { status: 500 }));
      }),
    );

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${url}/api/mobbin/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectUri: `http://localhost:${5000 + i}/oauth/mobbin/callback` }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 20).every((s) => s === 502)).toBe(true);
    expect(statuses[20]).toBe(429);
    await app.close();
  });
});
