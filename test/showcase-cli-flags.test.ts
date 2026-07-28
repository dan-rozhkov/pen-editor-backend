import { describe, it, expect } from "vitest";
import { hasFlag, readFlag } from "../src/showcase/cliFlags.js";

describe("readFlag", () => {
  it("reads the --name=value form, keeping spaces in the value", () => {
    expect(readFlag(["--theme=билеты в кино"], "theme")).toBe("билеты в кино");
  });

  it("reads the separated --name value form", () => {
    expect(readFlag(["--model", "moonshotai/kimi-k2.5"], "model")).toBe(
      "moonshotai/kimi-k2.5",
    );
  });

  it("returns undefined when the flag is absent", () => {
    expect(readFlag(["--model=x"], "theme")).toBeUndefined();
    expect(readFlag([], "theme")).toBeUndefined();
  });

  it("does not swallow the next flag as a value", () => {
    expect(readFlag(["--theme", "--model=x"], "theme")).toBeUndefined();
  });

  it("returns undefined for a trailing flag with no value", () => {
    expect(readFlag(["--theme"], "theme")).toBeUndefined();
  });

  it("prefers the inline form when both are present", () => {
    expect(readFlag(["--theme=a", "--theme", "b"], "theme")).toBe("a");
  });

  it("accepts an explicitly empty value", () => {
    expect(readFlag(["--theme="], "theme")).toBe("");
  });
});

describe("hasFlag", () => {
  it("is false when the flag is absent", () => {
    expect(hasFlag([], "cover")).toBe(false);
    expect(hasFlag(["--model=x"], "cover")).toBe(false);
  });

  it("is true for the bare form, even with no value following", () => {
    expect(hasFlag(["--cover"], "cover")).toBe(true);
  });

  it("is true when followed by another flag instead of a value", () => {
    expect(hasFlag(["--cover", "--dry-run"], "cover")).toBe(true);
  });

  it("is true for the inline form", () => {
    expect(hasFlag(["--cover=2"], "cover")).toBe(true);
  });

  it("is true for the separated value form", () => {
    expect(hasFlag(["--cover", "2"], "cover")).toBe(true);
  });
});
