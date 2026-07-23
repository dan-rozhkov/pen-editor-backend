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
});
