import { describe, expect, it } from "vitest";
import { maskTokenInUrl } from "../src/app.js";

// Regression test for a review finding: the MCP WS upgrade
// (GET /api/mcp/ws?token=...) carries the auth token in the query string,
// and Fastify's default pino logger logs req.url verbatim — leaking the
// secret into plaintext logs. app.ts wires this serializer into the default
// logger (only when buildApp is called without an explicit `logger` option,
// so `logger: false` in tests is untouched).
describe("maskTokenInUrl", () => {
  it("masks a token query param", () => {
    expect(maskTokenInUrl("/api/mcp/ws?token=super-secret-value")).toBe(
      "/api/mcp/ws?token=[redacted]",
    );
  });

  it("masks the token when other query params surround it", () => {
    expect(maskTokenInUrl("/api/mcp/ws?foo=bar&token=super-secret&baz=qux")).toBe(
      "/api/mcp/ws?foo=bar&token=[redacted]&baz=qux",
    );
  });

  it("leaves urls without a token param unchanged", () => {
    expect(maskTokenInUrl("/api/chat")).toBe("/api/chat");
    expect(maskTokenInUrl("/api/mcp?foo=bar")).toBe("/api/mcp?foo=bar");
  });

  // Regression test for a review finding: the original regex only matched
  // an exact lowercase `token=`, so a route carrying a differently-named
  // secret (e.g. DELETE /api/canvas/:id?editToken=..., before that route
  // moved editToken off the query string entirely) sailed straight through
  // unmasked into pino logs. The serializer must independently catch any
  // *token= query param, case-insensitively, for whatever route carries one.
  it("masks any *token= query param, case-insensitively", () => {
    expect(maskTokenInUrl("/api/canvas/abc?editToken=super-secret")).toBe(
      "/api/canvas/abc?editToken=[redacted]",
    );
    expect(maskTokenInUrl("/api/x?accessToken=super-secret&foo=bar")).toBe(
      "/api/x?accessToken=[redacted]&foo=bar",
    );
    expect(maskTokenInUrl("/api/x?EditToken=SuperSecret")).toBe(
      "/api/x?EditToken=[redacted]",
    );
  });
});
