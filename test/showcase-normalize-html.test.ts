import { describe, expect, it } from "vitest";
import {
  hasShowcaseUaReset,
  normalizeShowcaseHtml,
} from "../src/showcase/normalizeHtml.js";

describe("normalizeShowcaseHtml", () => {
  it("injects the reset inside <head> when there is one", () => {
    const out = normalizeShowcaseHtml(
      "<!doctype html><html><head><style>body{}</style></head><body><button>Go</button></body></html>",
    );
    expect(hasShowcaseUaReset(out)).toBe(true);
    expect(out.indexOf("data-showcase-ua-reset")).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf("data-showcase-ua-reset")).toBeLessThan(out.indexOf("<body>"));
  });

  it("falls back to <html> when the document has no head", () => {
    const out = normalizeShowcaseHtml("<html><body><button>Go</button></body></html>");
    expect(out.indexOf("data-showcase-ua-reset")).toBeGreaterThan(out.indexOf("<html>"));
    expect(out.indexOf("data-showcase-ua-reset")).toBeLessThan(out.indexOf("<body>"));
  });

  it("prepends to a bare fragment", () => {
    const out = normalizeShowcaseHtml("<div><button>Go</button></div>");
    expect(out.startsWith("<style data-showcase-ua-reset>")).toBe(true);
    expect(out).toContain("<div><button>Go</button></div>");
  });

  it("is idempotent", () => {
    const once = normalizeShowcaseHtml("<html><head></head><body></body></html>");
    expect(normalizeShowcaseHtml(once)).toBe(once);
  });

  it("keeps the design's own markup and styles byte-for-byte", () => {
    const source =
      "<!doctype html><html><head><style>.b{border:3px dashed red}</style></head><body><button class='b'>Go</button></body></html>";
    const out = normalizeShowcaseHtml(source);
    // Everything the design wrote survives; the reset is purely additive.
    expect(out.replace(/\n?<style data-showcase-ua-reset>[\s\S]*?<\/style>\n?/, "")).toBe(source);
  });

  it("puts every rule in a cascade layer, so author declarations always win", () => {
    const out = normalizeShowcaseHtml("<div></div>");
    const block = /<style data-showcase-ua-reset>([\s\S]*?)<\/style>/.exec(out)?.[1] ?? "";
    expect(block).toContain("@layer showcase-ua-reset {");
    // No rule may sit outside the layer — an unlayered rule here would beat the
    // design's own CSS instead of deferring to it.
    const withoutLayer = block.replace(/@layer showcase-ua-reset \{[\s\S]*\}/, "").trim();
    expect(withoutLayer).toBe("");
  });

  it("leaves native widget inputs alone", () => {
    const out = normalizeShowcaseHtml("<div></div>");
    for (const type of ["checkbox", "radio", "range", "color", "file"]) {
      expect(out).not.toContain(`input[type="${type}"]`);
    }
  });
});
