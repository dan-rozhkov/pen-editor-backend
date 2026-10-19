import { describe, expect, it } from "vitest";
import {
  dealDirection,
  directionFontUrl,
  extractFontFamilies,
  fontFamiliesFromHtml,
  isNaturalsPalette,
  renderDirectionClause,
} from "../src/showcase/direction.js";
import { PALETTES, TYPE_SYSTEMS, type DirectionPalette } from "../src/showcase/directionLibrary.js";
import { BANNED_ACCENT_FAMILY, hueFamily } from "../src/showcase/palette.js";

// A deterministic stand-in for Math.random that walks every slot of a pool:
// dealing with randoms i/n for i in 0..n-1 covers each index exactly once.
function sweep(n: number): Array<() => number> {
  return Array.from({ length: n }, (_, i) => () => i / n);
}

function palette(bg: string, accent: string): DirectionPalette {
  return { ...PALETTES[0], bg, accent };
}

describe("extractFontFamilies", () => {
  it("reads every family out of a Google Fonts @import, decoding + as a space", () => {
    const html =
      `<style>@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@500` +
      `&family=Jost:wght@400;500&display=swap');</style>`;
    expect(extractFontFamilies(html)).toEqual(["Bodoni Moda", "Jost"]);
  });

  it("ignores stylesheets from other hosts, such as the Phosphor icon font", () => {
    const html = `<style>@import url('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');</style>`;
    expect(extractFontFamilies(html)).toEqual([]);
  });

  it("dedupes across screens of a run", () => {
    const screen = `@import url("https://fonts.googleapis.com/css2?family=Archivo:wght@400;600&display=swap");`;
    expect(fontFamiliesFromHtml([screen, screen])).toEqual(["Archivo"]);
  });
});

describe("isNaturalsPalette", () => {
  it("flags a warm ground under a terracotta or a sage accent", () => {
    expect(isNaturalsPalette(palette("#f4f1ea", "#c4704c"))).toBe(true);
    expect(isNaturalsPalette(palette("#f4f1ea", "#5c6b54"))).toBe(true);
  });

  it("passes a cool ground, and a warm ground under an accent outside both bands", () => {
    expect(isNaturalsPalette(palette("#f7f9fa", "#c4704c"))).toBe(false);
    expect(isNaturalsPalette(palette("#f4f1ea", "#b0298f"))).toBe(false);
  });
});

describe("dealDirection", () => {
  it("never deals the banned violet family or the naturals cluster", () => {
    for (const random of sweep(PALETTES.length)) {
      const { palette: dealt } = dealDirection({ random });
      expect(hueFamily(dealt.accent)).not.toBe(BANNED_ACCENT_FAMILY);
      expect(hueFamily(dealt.bg)).not.toBe(BANNED_ACCENT_FAMILY);
      expect(isNaturalsPalette(dealt)).toBe(false);
    }
  });

  it("skips the accent families the last runs used", () => {
    const avoid = ["blue", "teal/cyan", "red/crimson", "terracotta/amber"];
    for (const random of sweep(PALETTES.length)) {
      const family = hueFamily(dealDirection({ random, avoidHueFamilies: avoid }).palette.accent);
      expect(avoid).not.toContain(family);
    }
  });

  it("counts a saturated field ground against the avoid list, not only the accent", () => {
    for (const random of sweep(PALETTES.length)) {
      const dealt = dealDirection({ random, avoidHueFamilies: ["blue"] }).palette;
      expect(hueFamily(dealt.bg)).not.toBe("blue");
    }
  });

  it("skips the faces the last runs used, case-insensitively", () => {
    for (const random of sweep(TYPE_SYSTEMS.length)) {
      const { type } = dealDirection({ random, avoidFontFamilies: ["work sans", "Literata"] });
      expect([type.display.family, type.text.family]).not.toContain("Work Sans");
      expect([type.display.family, type.text.family]).not.toContain("Literata");
    }
  });

  it("falls back to the whole pool rather than dealing nothing", () => {
    const everyFace = TYPE_SYSTEMS.flatMap((t) => [t.display.family, t.text.family]);
    const { type } = dealDirection({ random: () => 0, avoidFontFamilies: everyFace });
    expect(type).toBe(TYPE_SYSTEMS[0]);
  });
});

describe("renderDirectionClause", () => {
  it("names both faces, the exact font url and every palette role", () => {
    const type = TYPE_SYSTEMS.find((t) => t.display.family !== t.text.family) ?? TYPE_SYSTEMS[0];
    const dealt = PALETTES[0];
    const clause = renderDirectionClause({ type, palette: dealt });
    expect(clause).toContain(type.display.family);
    expect(clause).toContain(type.text.family);
    expect(clause).toContain(directionFontUrl(type));
    for (const hex of [dealt.bg, dealt.surface, dealt.ink, dealt.muted, dealt.accent]) {
      expect(clause).toContain(hex);
    }
    expect(clause).toMatch(/hard requirement/);
  });

  it("loads the text face at the weights a UI needs", () => {
    const url = directionFontUrl({
      ...TYPE_SYSTEMS[0],
      display: { family: "Bodoni Moda", weights: [500], settings: "" },
      text: { family: "Jost", weights: [400], settings: "" },
    });
    expect(url).toBe(
      "https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@500&family=Jost:wght@400;500;600&display=swap",
    );
  });
});
