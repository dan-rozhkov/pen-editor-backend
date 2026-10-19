import { BANNED_ACCENT_FAMILY, hsv, hueFamily } from "./palette.js";
import { PALETTES, TYPE_SYSTEMS, type DirectionPalette, type TypeSystem } from "./directionLibrary.js";

// Dealt art direction: the run's type system and palette are picked by code
// from a researched library (directionLibrary.ts) instead of by the model.
//
// Why: asked to choose, deepseek-v4.1-flash picked Archivo for all three runs
// of the 2026-10-19 A/B, two of them on dark teal — the model's prior, not a
// decision. Rules in the skill can ban a habit but cannot pick something else;
// a dealt direction can. In that A/B, dealing alone removed the monoculture
// but kept the tracked-caps tics, the skill's house rules alone removed the
// tics but kept Archivo, and the two together beat both (arm C3).
//
// The deal respects the same rotation the palette clause enforces: no accent
// from a family the last runs used, no face the last runs used, never the
// banned violet family, and never the warm-ground + naturals-accent cluster the
// prototype skill's Calibration check forbids. Each filter falls back to the
// unfiltered pool rather than dealing nothing.

export interface Direction {
  type: TypeSystem;
  palette: DirectionPalette;
}

export interface DealOptions {
  avoidHueFamilies?: string[];
  avoidFontFamilies?: string[];
  random?: () => number;
}

const GOOGLE_FONTS_CSS = /fonts\.googleapis\.com\/css2?\?([^'")\s]+)/g;

/** Font families a screen loads from Google Fonts, as written in its
 * `@import`/`<link>` URLs (`family=Bodoni+Moda:wght@500` -> "Bodoni Moda"). */
export function extractFontFamilies(html: string): string[] {
  const families: string[] = [];
  for (const match of html.matchAll(GOOGLE_FONTS_CSS)) {
    for (const part of match[1].split("&")) {
      if (!part.startsWith("family=")) continue;
      const name = part.slice("family=".length).split(":")[0];
      let decoded: string;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, " ")).trim();
      } catch {
        continue;
      }
      if (decoded && !families.includes(decoded)) families.push(decoded);
    }
  }
  return families;
}

/** Distinct font families across the given screens' HTML. */
export function fontFamiliesFromHtml(htmls: string[]): string[] {
  const families: string[] = [];
  for (const html of htmls) {
    for (const family of extractFontFamilies(html)) {
      if (!families.includes(family)) families.push(family);
    }
  }
  return families;
}

/** The prototype skill's reassuring-naturals axis (its pre-flight check 4a):
 * a warm ground (hue 10-60 with perceptible saturation) under an accent in the
 * terracotta/amber band (8-55) or the sage/olive/forest band (75-160). */
export function isNaturalsPalette(palette: DirectionPalette): boolean {
  const ground = hsv(palette.bg);
  const accent = hsv(palette.accent);
  if (!ground || !accent) return false;
  const warmGround = ground.h >= 10 && ground.h <= 60 && ground.s >= 0.03;
  const naturalAccent =
    accent.s >= 0.2 && ((accent.h >= 8 && accent.h < 55) || (accent.h >= 75 && accent.h <= 160));
  return warmGround && naturalAccent;
}

function pick<T>(items: T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function preferNonEmpty<T>(filtered: T[], fallback: T[]): T[] {
  return filtered.length > 0 ? filtered : fallback;
}

export function dealDirection(options: DealOptions = {}): Direction {
  const random = options.random ?? Math.random;
  const avoidHues = new Set(options.avoidHueFamilies ?? []);
  const avoidFonts = new Set((options.avoidFontFamilies ?? []).map((f) => f.toLowerCase()));

  const allowedPalettes = PALETTES.filter(
    (p) =>
      hueFamily(p.accent) !== BANNED_ACCENT_FAMILY &&
      hueFamily(p.bg) !== BANNED_ACCENT_FAMILY &&
      !isNaturalsPalette(p),
  );
  // A field palette paints the whole ground in a saturated colour (cobalt,
  // carmine) and uses a contrasting accent on top: its ground is what the
  // gallery sees, so both colours count against the avoid list.
  const palettes = preferNonEmpty(
    allowedPalettes.filter((p) =>
      [p.accent, p.bg].every((hex) => {
        const family = hueFamily(hex);
        return family === null || !avoidHues.has(family);
      }),
    ),
    allowedPalettes,
  );
  const types = preferNonEmpty(
    TYPE_SYSTEMS.filter(
      (t) =>
        !avoidFonts.has(t.display.family.toLowerCase()) && !avoidFonts.has(t.text.family.toLowerCase()),
    ),
    TYPE_SYSTEMS,
  );
  return { type: pick(types, random), palette: pick(palettes, random) };
}

/** The Google Fonts css2 URL that loads both faces of a type system, plus the
 * 400/500/600 a UI needs from the text face. */
export function directionFontUrl(type: TypeSystem): string {
  const weights = new Map<string, Set<number>>();
  for (const face of [type.display, type.text]) {
    const set = weights.get(face.family) ?? new Set<number>();
    face.weights.forEach((w) => set.add(w));
    weights.set(face.family, set);
  }
  [400, 500, 600].forEach((w) => weights.get(type.text.family)?.add(w));
  const families = [...weights]
    .map(([family, set]) => {
      const list = [...set].sort((a, b) => a - b).join(";");
      return `family=${family.replace(/ /g, "+")}:wght@${list}`;
    })
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** The request clause that hands the dealt direction to the agent. Phrased as
 * the requester's constraint, like the palette clause it replaces. */
export function renderDirectionClause(direction: Direction): string {
  const { type, palette } = direction;
  const twoFaces = type.display.family !== type.text.family;
  const fields = palette.fields.map((f) => `\n- Extra field: ground ${f.bg} with ink ${f.ink}.`).join("");
  return (
    `Art direction: this run's typeface and palette were dealt by code, not chosen by you. ` +
    `This is a hard requirement of this request. Adopt them whole: do not blend them with the look ` +
    `you would have made anyway, and do not swap them for a face or palette you like better. ` +
    `They replace only your choice of typeface and palette (including the skill's font candidates, ` +
    `its serif rule and its zinc/slate default); every other rule in the skill still applies.\n\n` +
    `Type system "${type.name}":\n` +
    `- Display (titles, large figures, wordmark): ${type.display.family}. ${type.display.settings}.\n` +
    `- Text (labels, body, meta, buttons): ${type.text.family}. ${type.text.settings}.\n` +
    `- Load exactly: @import url('${directionFontUrl(type)}');\n` +
    (twoFaces ? `- Two families split by role (display vs reading); declare that split in OWN-WORLD.\n` : "") +
    `- Why it works: ${type.note}\n\n` +
    `Palette "${palette.name}":\n` +
    `- Ground ${palette.bg}, surface ${palette.surface}, ink ${palette.ink}, muted ${palette.muted}, ` +
    `accent ${palette.accent} (text on accent ${palette.accentInk}).${fields}\n` +
    `- How to use it: ${palette.note}\n` +
    `- Map these onto your :root tokens as given (one extra tone step between ground and surface is fine). ` +
    `The accent goes on the primary action and at most one other thing. It already avoids the accent ` +
    `families the last apps in this gallery used.`
  );
}
