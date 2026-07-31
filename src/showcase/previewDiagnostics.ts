import sharp from "sharp";

// Pixel-level checks on a rendered screen, kept out of `screenshot.ts` so they
// can be unit-tested without a browser.
//
// They exist because the dimension check is not a completeness check: every
// defect that has actually shipped from a hand-authored run rendered at a
// perfectly correct 780×1688. A band of dead space at the foot of the screen
// and a row of content sliced by the bottom edge both pass every automated
// gate the pipeline had, and were caught — twice, at the cost of a whole
// rebuild each time — only by someone looking at the PNG.

export const DEVICE_SCALE_FACTOR = 2;

// A screen may legitimately end in some breathing room; 160 CSS px is roughly
// where a footer stops reading as spacing and starts reading as a hole. The
// brief-level rule the design skills state is "no screen ends in 200px of dead
// space", so this fires slightly before the rule is broken.
export const DEAD_SPACE_LIMIT_CSS_PX = 160;

const CHANNEL_TOLERANCE = 2;

/**
 * Height, in device pixels, of the band of bare *background* at the bottom of
 * the image — rows entirely the colour of the top-left pixel.
 *
 * The background is sampled from the corner rather than from the last row on
 * purpose. Taking the last row as the reference makes any full-bleed element
 * that ends at the bottom edge — a dark category band, a pinned bar — read as
 * emptiness, which is the opposite of the truth. Sampling the corner instead
 * costs one case (a screen whose ground colour changes partway down goes
 * unmeasured, reporting 0) and that is the right way to be wrong: a missed
 * warning beats one that fires on a design's boldest screen.
 *
 * A full-width footer rule or a single line of text stops the count, so this
 * measures dead space rather than "how much of the screen is background".
 */
export function bottomDeadSpaceRows(
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): number {
  if (width <= 0 || height <= 0) return 0;

  const rowBytes = width * channels;
  const baseline = raw.subarray(0, channels);

  let rows = 0;
  for (let y = height - 1; y >= 0; y -= 1) {
    let uniform = true;
    for (let x = 0; x < width && uniform; x += 1) {
      const at = y * rowBytes + x * channels;
      for (let c = 0; c < channels; c += 1) {
        if (Math.abs(raw[at + c] - baseline[c]) > CHANNEL_TOLERANCE) {
          uniform = false;
          break;
        }
      }
    }
    if (!uniform) break;
    rows += 1;
  }

  // An entirely uniform image is a blank mount, not a screen with a big
  // footer — report it as such rather than as `height` px of dead space.
  return rows === height ? height : rows;
}

export interface DeadSpaceReport {
  cssPx: number;
  blank: boolean;
}

export async function measureBottomDeadSpace(png: Buffer): Promise<DeadSpaceReport> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const rows = bottomDeadSpaceRows(data, info.width, info.height, info.channels);
  return {
    cssPx: Math.round(rows / DEVICE_SCALE_FACTOR),
    blank: rows === info.height,
  };
}

/**
 * Compose a labelled contact sheet from rendered screens — the one image an
 * art director looks at to judge a run as a whole. Lives here rather than in
 * an external script so the preview command can produce it in the same pass
 * that renders the PNGs.
 */
export async function buildContactSheet(
  files: { path: string; label: string }[],
  destination: string,
  cell = 700,
): Promise<void> {
  const labelHeight = Math.round(cell * 0.05);
  const thumbs = await Promise.all(
    files.map(async (file) => ({
      label: file.label,
      buffer: await sharp(file.path)
        .resize({ height: cell - labelHeight, fit: "inside" })
        .toBuffer({ resolveWithObject: true }),
    })),
  );

  const gap = 12;
  const widths = thumbs.map((t) => t.buffer.info.width);
  const sheetWidth = widths.reduce((sum, w) => sum + w + gap, gap);

  const composites = [];
  let x = gap;
  for (const [index, thumb] of thumbs.entries()) {
    composites.push({ input: thumb.buffer.data, left: x, top: labelHeight });
    const label = thumb.label.replace(/[<>&]/g, "");
    composites.push({
      input: Buffer.from(
        `<svg width="${widths[index]}" height="${labelHeight}">` +
          `<text x="0" y="${labelHeight - 4}" font-family="monospace" ` +
          `font-size="${labelHeight - 6}" fill="#ffd24a">${label}</text></svg>`,
      ),
      left: x,
      top: 0,
    });
    x += widths[index] + gap;
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: cell + gap,
      channels: 3,
      background: { r: 20, g: 20, b: 20 },
    },
  })
    .composite(composites)
    .png()
    .toFile(destination);
}
