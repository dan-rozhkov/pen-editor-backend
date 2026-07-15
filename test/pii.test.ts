import { describe, expect, it } from "vitest";
import { scrubPii, containsPii } from "../src/analysis/pii.js";

describe("scrubPii", () => {
  it("replaces emails", () => {
    expect(scrubPii("contact john.doe+x@example.com please")).toBe(
      "contact [EMAIL] please",
    );
  });
  it("replaces phone numbers", () => {
    expect(scrubPii("call +7 (912) 345-67-89 now")).toBe("call [PHONE] now");
  });
  it("replaces API keys/tokens", () => {
    expect(scrubPii("use sk-abcdefghij1234567890abcd")).toBe("use [TOKEN]");
    expect(scrubPii("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toBe("[TOKEN]");
  });
  it("replaces credentials embedded in URLs, keeping the scheme", () => {
    expect(scrubPii("https://user:pass@db.example.com/x")).toBe(
      "https://[CREDENTIALS]@db.example.com/x",
    );
  });
  it("drops base64 data URLs entirely", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(200)}`;
    expect(scrubPii(`img ${dataUrl} end`)).toBe("img [DATA_URL] end");
  });
  it("replaces long high-entropy blobs", () => {
    expect(scrubPii(`x ${"Qq1".repeat(30)} y`)).toBe("x [BLOB] y");
  });
  it("leaves normal design-agent text untouched", () => {
    const text =
      "User asked to create a 3-column pricing frame; batch_design failed with 'Too many operations (30)'.";
    expect(scrubPii(text)).toBe(text);
    expect(containsPii(text)).toBe(false);
  });
});

describe("containsPii", () => {
  it("detects PII", () => {
    expect(containsPii("mail me at a@b.co")).toBe(true);
  });
});
