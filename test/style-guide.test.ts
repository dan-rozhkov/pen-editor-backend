import { describe, expect, it } from "vitest";
import { getStyleGuideImpl, getStyleGuideTagsImpl } from "../src/ai/tools.js";

// Converts a "#RRGGBB" hex string to its HSV hue (0-360). Returns null for
// achromatic colors (r === g === b), since hue is undefined there and can
// never be "violet" regardless of the numeric value chroma.js/color libs
// would report.
function hueOf(hex: string): number | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`not a hex color: ${hex}`);
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null; // grayscale, no hue
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

const VIOLET_BAND: [number, number] = [255, 295];

function isInVioletBand(hue: number | null): boolean {
  if (hue === null) return false;
  return hue >= VIOLET_BAND[0] && hue <= VIOLET_BAND[1];
}

// WCAG relative luminance, enough to tell "this button is visible on this
// page" from "this button is the page".
function luminanceOf(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`not a hex color: ${hex}`);
  const int = parseInt(m[1], 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("getStyleGuideImpl: brand roles stay legible on their own ground", () => {
  // Regression: `pastel` carries value 95, and an elegant/playful valBoost
  // pushed it to 100, so `primary` came back as #CCF7FF on a #F2FBFC
  // background — a technically-pastel palette whose primary button was
  // invisible. The brand roles are now clamped to the legible side of the
  // ground. Caught by exercising the tool, not by the no-purple checks.
  it("keeps primary/secondary/accent readable against background for every tag pair", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const style of tags.style) {
      for (const color of tags.color) {
        const guide = await getStyleGuideImpl({ tags: [style, color] });
        const c = guide.colors as Record<string, string>;
        for (const role of ["primary", "secondary", "accent"] as const) {
          // 3:1 is the WCAG floor for large text and UI components — the right
          // bar for a fill/CTA color, which is what these roles are.
          expect(
            contrastRatio(c[role], c.background),
            `${style}+${color} ${role} ${c[role]} on ${c.background}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("does not tint the ground when the palette has no hue", async () => {
    const guide = await getStyleGuideImpl({ tags: ["modern", "monochrome"] });
    const c = guide.colors as Record<string, string>;
    // A 4% tint at hue 0 made "monochrome" hand back a pink page.
    expect(hueOf(c.background)).toBeNull();
    expect(hueOf(c.surface)).toBeNull();
  });
});

describe("getStyleGuideImpl: the returned tokens are internally coherent", () => {
  // Google Fonts serves these as a single 400 weight. The prototype skill
  // mandates loading via `@import url('...css2?family=NAME:wght@N')` because
  // <link> is stripped on the canvas, and that URL is an HTTP 400 for a weight
  // the family does not ship — so the whole @import fails and NO font loads,
  // not even a fallback weight. Verified against the live API when this list
  // was written.
  const SINGLE_WEIGHT_400_FAMILIES = ["Archivo Black", "Righteous"];

  it("never asks a single-weight display family for a weight it does not ship", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const style of tags.style) {
      const guide = await getStyleGuideImpl({ tags: [style] });
      const t = guide.typography as { headingFont: string; weights: Record<string, string> };
      if (SINGLE_WEIGHT_400_FAMILIES.includes(t.headingFont)) {
        expect(t.weights.heading, `${style} / ${t.headingFont}`).toBe("400");
      }
    }
  });

  it("keeps emphasis distinguishable from body weight", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const style of tags.style) {
      const guide = await getStyleGuideImpl({ tags: [style] });
      const w = (guide.typography as { weights: Record<string, string> }).weights;
      // retro's display face is 400-only, so deriving emphasis from the
      // heading weight silently made bolded inline text identical to body.
      expect(Number(w.emphasis), `${style}`).toBeGreaterThan(Number(w.body));
    }
  });

  it("keeps the radius scale ordered, with `full` always the pill token", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const style of tags.style) {
      const guide = await getStyleGuideImpl({ tags: [style] });
      const r = guide.borderRadius as Record<string, number>;
      expect(r.sm, style).toBeLessThanOrEqual(r.md);
      expect(r.md, style).toBeLessThanOrEqual(r.lg);
      expect(r.lg, style).toBeLessThanOrEqual(r.xl);
      // `full` means pill/circle everywhere; a style that sets it below xl
      // leaves an agent no way to express "round" (brutalist set it to 0),
      // and one that sets xl to the pill value loses a step (retro set
      // xl === full === 9999).
      expect(r.full, style).toBeGreaterThan(r.xl);
    }
  });

  it("returns three distinguishable brand roles even with no hue to use", async () => {
    // `monochrome` is DEFAULT_COLOR, so this is the no-tags path. It used to
    // return #333333 / #262626 / #333230 — a direction with no CTA colour.
    for (const tagSet of [[], ["modern", "monochrome"], ["bold", "monochrome"]]) {
      const guide = await getStyleGuideImpl({ tags: tagSet });
      const c = guide.colors as Record<string, string>;
      const roles = [c.primary, c.secondary, c.accent];
      expect(new Set(roles).size, JSON.stringify(tagSet)).toBe(3);
      // Distinct hexes are not enough — they have to be visibly apart.
      expect(
        contrastRatio(c.primary, c.secondary),
        `${JSON.stringify(tagSet)} primary/secondary`,
      ).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("does not tint the ground for a monochrome family whatever the style", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const style of tags.style) {
      const guide = await getStyleGuideImpl({ tags: [style, "monochrome"] });
      const c = guide.colors as Record<string, string>;
      // bold/playful/brutalist add +15/+20/+25 saturation, so keying the
      // ground guard off the BOOSTED saturation left them with a pink page.
      expect(hueOf(c.background), `${style} background ${c.background}`).toBeNull();
      expect(hueOf(c.surface), `${style} surface ${c.surface}`).toBeNull();
    }
  });
});

describe("getStyleGuideImpl: tag-dependence", () => {
  it("produces different primary color and heading font for different tag sets", async () => {
    const a = await getStyleGuideImpl({ tags: ["minimal", "monochrome"] });
    const b = await getStyleGuideImpl({ tags: ["brutalist", "vibrant"] });

    expect((a.colors as { primary: string }).primary).not.toBe(
      (b.colors as { primary: string }).primary,
    );
    expect((a.typography as { headingFont: string }).headingFont).not.toBe(
      (b.typography as { headingFont: string }).headingFont,
    );
  });

  it("varies meaningfully across the full style axis (radius/spacing) and color axis (palette)", async () => {
    const { tags } = await getStyleGuideTagsImpl();

    const radii = await Promise.all(
      tags.style.map(async (styleTag) => {
        const guide = await getStyleGuideImpl({ tags: [styleTag] });
        return JSON.stringify(guide.borderRadius);
      }),
    );
    // Not every style should collapse onto the same radius scale.
    expect(new Set(radii).size).toBeGreaterThan(1);

    // brutalist must land at (or near) zero radius.
    const brutalist = await getStyleGuideImpl({ tags: ["brutalist"] });
    const brutalistRadius = brutalist.borderRadius as { sm: number; md: number; lg: number };
    expect(brutalistRadius.sm).toBeLessThanOrEqual(2);
    expect(brutalistRadius.md).toBeLessThanOrEqual(2);

    // playful should not land on a near-zero radius scale like brutalist.
    const playful = await getStyleGuideImpl({ tags: ["playful"] });
    const playfulRadius = playful.borderRadius as { md: number };
    expect(playfulRadius.md).toBeGreaterThan(brutalistRadius.md + 5);

    const primaries = await Promise.all(
      tags.color.map(async (colorTag) => {
        const guide = await getStyleGuideImpl({ tags: [colorTag] });
        return (guide.colors as { primary: string }).primary;
      }),
    );
    expect(new Set(primaries).size).toBeGreaterThan(1);

    // earth-tones and cool must not land on the same palette.
    const earthTones = await getStyleGuideImpl({ tags: ["earth-tones"] });
    const cool = await getStyleGuideImpl({ tags: ["cool"] });
    expect((earthTones.colors as { primary: string }).primary).not.toBe(
      (cool.colors as { primary: string }).primary,
    );
  });

  it("still returns a valid, usable guide with no tags at all", async () => {
    const guide = await getStyleGuideImpl({});
    expect(guide.basedOn).toEqual([]);
    expect(guide.typography).toBeDefined();
    expect(guide.colors).toBeDefined();
    expect(guide.spacing).toBeDefined();
    expect(guide.borderRadius).toBeDefined();
    const colors = guide.colors as Record<string, string>;
    expect(colors.primary).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("getStyleGuideImpl: banned generic-AI signature", () => {
  it("never emits a violet/indigo/purple hue for any color role, over every style x color tag combination", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    const colorRoles = ["primary", "secondary", "accent", "background", "surface", "text", "textMuted", "border"];

    for (const styleTag of tags.style) {
      for (const colorTag of tags.color) {
        const guide = await getStyleGuideImpl({ tags: [styleTag, colorTag] });
        const colors = guide.colors as Record<string, string>;
        for (const role of colorRoles) {
          const hex = colors[role];
          const hue = hueOf(hex);
          expect(
            isInVioletBand(hue),
            `style=${styleTag} color=${colorTag} role=${role} hex=${hex} hue=${hue} falls in the violet band`,
          ).toBe(false);
        }
      }
    }
  });

  it("never returns Inter as both the heading and body font, for any tag combination", async () => {
    const { tags } = await getStyleGuideTagsImpl();
    for (const styleTag of tags.style) {
      for (const colorTag of tags.color) {
        const guide = await getStyleGuideImpl({ tags: [styleTag, colorTag] });
        const typography = guide.typography as { headingFont: string; bodyFont: string };
        const bothInter = typography.headingFont === "Inter" && typography.bodyFont === "Inter";
        expect(bothInter, `style=${styleTag} color=${colorTag} used Inter for both faces`).toBe(false);
      }
    }
  });
});

describe("getStyleGuideImpl: note field", () => {
  it("includes a non-empty note in every response", async () => {
    const withTags = await getStyleGuideImpl({ tags: ["bold", "warm"] });
    const withoutTags = await getStyleGuideImpl({});
    expect(typeof withTags.note).toBe("string");
    expect(withTags.note.length).toBeGreaterThan(20);
    expect(typeof withoutTags.note).toBe("string");
    expect(withoutTags.note.length).toBeGreaterThan(20);
  });
});
