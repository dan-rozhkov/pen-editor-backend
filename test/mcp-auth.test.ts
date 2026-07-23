import { describe, expect, it } from "vitest";
import { constantTimeEqual, extractBearerToken } from "../src/mcp/auth.js";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
  });

  it("returns null for a missing or malformed header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  it("uses the first value when the header is an array", () => {
    expect(extractBearerToken(["Bearer first", "Bearer second"])).toBe(
      "first",
    );
  });
});
