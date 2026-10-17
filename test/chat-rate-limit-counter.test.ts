import { describe, expect, it } from "vitest";
import { isBrowseTurn } from "../src/routes/chatRateLimit.js";

describe("isBrowseTurn", () => {
  it("needs both agentMode browse and BROWSE_MODE agent", () => {
    expect(isBrowseTurn("browse", "agent")).toBe(true);
    expect(isBrowseTurn("browse", "task")).toBe(false);
    expect(isBrowseTurn("edits", "agent")).toBe(false);
    expect(isBrowseTurn(undefined, "agent")).toBe(false);
  });
});
