import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";

// Regression test for a silent breakage introduced by a dependency bump.
//
// app.ts used to pass `trustProxy: 1` (trust exactly one reverse-proxy hop,
// Render's). Fastify 5.12.1 dropped the numeric hop-count form: `number` is
// gone from FastifyServerOptions["trustProxy"], AND getTrustProxyFn now
// returns a function that always reports `false` for a number — hop-count
// trust cannot validate the immediate peer, so upstream chose to fail closed.
// The type error was loud, but the behavior change was not: had the value
// been kept alive through a cast, every request would have resolved to the
// proxy's own socket address, collapsing @fastify/rate-limit's per-IP buckets
// (src/plugins/rateLimit.ts keys on request.ip) into one shared bucket for
// all external traffic, with nothing to notice it by.
//
// These tests pin the observable behavior rather than the option's value, so
// they'd fail the same way if a future bump changes what the named ranges
// mean. Requests here arrive over 127.0.0.1, i.e. from a loopback peer, which
// stands in for Render's edge connecting from the internal 10/8 network.
describe("trustProxy", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function requestIp(headers: Record<string, string>): Promise<string> {
    app = await buildApp(makeConfig(), { logger: false });
    app.get("/__test_ip", (request, reply) => reply.send({ ip: request.ip }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/__test_ip`, { headers });
    const body = (await res.json()) as { ip: string };
    return body.ip;
  }

  it("resolves the client address a trusted proxy appended to X-Forwarded-For", async () => {
    expect(await requestIp({ "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores a client-forged entry ahead of the proxy-appended one", async () => {
    // A client sending its own X-Forwarded-For gets that value pushed left as
    // the proxy appends the real source address. Only the appended entry is
    // unforgeable, so that is the one request.ip must resolve to — otherwise
    // a client could mint a fresh rate-limit identity per request.
    expect(
      await requestIp({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" }),
    ).toBe("203.0.113.7");
  });

  it("falls back to the socket address when there is no X-Forwarded-For", async () => {
    expect(await requestIp({})).toBe("127.0.0.1");
  });
});
