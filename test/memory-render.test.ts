import { describe, expect, it } from "vitest";
import { renderMemoryBlock, renderMemorySnapshot } from "../src/ai/memory/render.js";

const RULE = "═".repeat(46);

describe("renderMemoryBlock", () => {
  it("renders the header, the usage gauge and the separated entries", () => {
    const block = renderMemoryBlock("memory", ["first note", "second note"]);
    expect(block).toBe(
      [
        RULE,
        "MEMORY (your personal notes) [1% — 24/2,200 chars]",
        RULE,
        "first note\n§\nsecond note",
      ].join("\n"),
    );
  });

  it("uses the USER PROFILE header for the user target", () => {
    expect(renderMemoryBlock("user", ["Name: Dan"])).toContain(
      "USER PROFILE (who the user is) [1% — 9/1,375 chars]",
    );
  });

  it("groups thousands in both numbers", () => {
    const block = renderMemoryBlock("memory", ["x".repeat(1474)]);
    expect(block).toContain("[67% — 1,474/2,200 chars]");
  });

  it("renders nothing for an empty target", () => {
    expect(renderMemoryBlock("memory", [])).toBe("");
  });
});

describe("renderMemorySnapshot", () => {
  it("renders user profile first, then memory, separated by a blank line", () => {
    const out = renderMemorySnapshot({ user: ["Name: Dan"], memory: ["Uses zsh"] });
    expect(out.indexOf("USER PROFILE")).toBeLessThan(out.indexOf("MEMORY (your personal notes)"));
    expect(out).toContain("\n\n");
  });

  it("returns an empty string when both targets are empty", () => {
    expect(renderMemorySnapshot({ user: [], memory: [] })).toBe("");
  });
});
