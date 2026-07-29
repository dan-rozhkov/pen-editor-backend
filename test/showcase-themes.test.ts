import { describe, expect, it } from "vitest";
import { SHOWCASE_THEMES, DESKTOP_THEMES } from "../src/showcase/themes.js";

describe("showcase theme pools", () => {
  it("are both non-empty", () => {
    expect(SHOWCASE_THEMES.length).toBeGreaterThan(0);
    expect(DESKTOP_THEMES.length).toBeGreaterThan(0);
  });

  it("have no overlap — each platform picks from its own pool", () => {
    const mobileSet = new Set(SHOWCASE_THEMES);
    const shared = DESKTOP_THEMES.filter((t) => mobileSet.has(t));
    expect(shared).toEqual([]);
  });

  it("have no internal duplicates in either pool", () => {
    expect(new Set(SHOWCASE_THEMES).size).toBe(SHOWCASE_THEMES.length);
    expect(new Set(DESKTOP_THEMES).size).toBe(DESKTOP_THEMES.length);
  });
});
