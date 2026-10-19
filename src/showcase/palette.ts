// Palette rotation for `npm run showcase:generate`.
//
// `themes.ts` already keeps a run from repeating one of the last 10 themes.
// Nothing did the same for *color*, and it showed: six consecutive
// deepseek-v4-pro runs shipped a warm ground with a terracotta/amber accent,
// because that is the model's prior for "calm, caring, human" and nothing in
// the turn knew what the previous runs had looked like. The prototype skill's
// Calibration section now names that axis, but a skill rule can only make one
// design self-aware — it cannot see the gallery. This module can: it reads the
// accent back out of the HTML of recent runs (S3 objects, already the source
// of truth for re-screenshotting) and hands the generator a list of hue
// families to steer away from.
//
// Reading the published HTML beats storing the accent at publish time: no
// migration, no column that can drift from the file, and it works retroactively
// on every run already in the gallery.

/** The one family the prototype skill bans outright ("AI Purple"). Rotation
 * must never hand it to a run as the free slot: narrowing the palette space
 * without saying this out loud is exactly how the first rotated run traded a
 * terracotta default for an electric-violet one. Filtered out of the avoid
 * list too — the ban already covers it, and listing it as merely "recently
 * used" reads as a family that comes back into play once it ages out. */
export const BANNED_ACCENT_FAMILY = "violet/purple";

/** Hue families, coarse enough that "two degrees over" is not an escape hatch.
 * The first band is deliberately wide — terracotta (h≈15) and amber (h≈40) are
 * the same AI-cluster look, and splitting them would let a run "rotate" from
 * one to the other and land in the same place. */
const FAMILIES: Array<{ name: string; from: number; to: number }> = [
  { name: "red/crimson", from: 340, to: 8 },
  { name: "terracotta/amber", from: 8, to: 55 },
  { name: "lime/yellow", from: 55, to: 95 },
  { name: "green/emerald", from: 95, to: 165 },
  { name: "teal/cyan", from: 165, to: 200 },
  { name: "blue", from: 200, to: 255 },
  { name: "violet/purple", from: 255, to: 295 },
  { name: "pink/magenta", from: 295, to: 340 },
];

// Below this a color reads as a neutral (a warm off-white still has a hue, but
// it is a ground, not an accent). The ground's warmth is the skill's problem;
// this module rotates accents.
const ACCENT_MIN_SATURATION = 0.35;

// ...and a near-black is not one either, however "saturated" it computes as.
// `#0d0a08` — the sleep-tracker run's page ground — is 38% saturated by the
// HSV formula while reading as black; without this floor the darkest ground in
// a dark design outranks the accent it is a backdrop for.
const ACCENT_MIN_VALUE = 0.3;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hsv(hex: string): { h: number; s: number; v: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** The hue family of a color, or null when it is a neutral. */
export function hueFamily(hex: string): string | null {
  const c = hsv(hex);
  if (!c || c.s < ACCENT_MIN_SATURATION || c.v < ACCENT_MIN_VALUE) return null;
  for (const band of FAMILIES) {
    // `red/crimson` wraps past 360, so it is the one band tested as a union.
    const inside =
      band.from > band.to
        ? c.h >= band.from || c.h < band.to
        : c.h >= band.from && c.h < band.to;
    if (inside) return band.name;
  }
  return null;
}

/** The most-used saturated color in a screen's HTML — the accent, in practice,
 * since a design's accent is repeated across every control that uses it.
 * Hex literals only: the skill tells the agent to write hex, and every
 * published screen so far does. */
export function extractAccentHex(html: string): string | null {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    const rgb = parseHex(match[1]);
    if (!rgb) continue;
    const key = `#${((rgb.r << 16) | (rgb.g << 8) | rgb.b).toString(16).padStart(6, "0")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { hex: string; count: number } | null = null;
  for (const [hex, count] of counts) {
    if (hueFamily(hex) === null) continue;
    if (!best || count > best.count) best = { hex, count };
  }
  return best?.hex ?? null;
}

/** Distinct hue families used by the given screens, freshest first. Never
 * rejects: a run must still happen when S3 is unreachable — it just loses the
 * rotation hint. */
export async function recentAccentFamilies(
  htmlUrls: string[],
  fetchHtml: (url: string) => Promise<string>,
): Promise<string[]> {
  const families: string[] = [];
  for (const url of htmlUrls) {
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }
    const accent = extractAccentHex(html);
    if (!accent) continue;
    const family = hueFamily(accent);
    if (family && family !== BANNED_ACCENT_FAMILY && !families.includes(family)) {
      families.push(family);
    }
  }
  return families;
}
