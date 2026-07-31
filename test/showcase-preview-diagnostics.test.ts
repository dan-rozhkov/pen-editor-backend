import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bottomDeadSpaceRows,
  buildContactSheet,
  measureBottomDeadSpace,
} from "../src/showcase/previewDiagnostics.js";

// Build a raw RGB buffer: `height` rows of `width` px, painted by `rowColor`.
function image(
  width: number,
  height: number,
  rowColor: (y: number) => [number, number, number],
): Buffer {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const [r, g, b] = rowColor(y);
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      buffer[at] = r;
      buffer[at + 1] = g;
      buffer[at + 2] = b;
    }
  }
  return buffer;
}

const WHITE: [number, number, number] = [250, 250, 250];
const INK: [number, number, number] = [24, 24, 27];

describe("bottomDeadSpaceRows", () => {
  it("counts the uniform band at the foot of the screen", () => {
    // Ground at the top (where the background colour is sampled), content
    // from y=20 to y=59, then 40 rows of empty ground.
    const raw = image(10, 100, (y) => (y >= 20 && y < 60 ? INK : WHITE));
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(40);
  });

  it("does not count a full-bleed band that ends at the bottom edge", () => {
    // The Categories screen: a dark band running to the very bottom is
    // content, not emptiness — the case that made sampling the last row wrong.
    const raw = image(10, 100, (y) => (y >= 70 ? INK : WHITE));
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(0);
  });

  it("reports nothing when content reaches the bottom edge", () => {
    const raw = image(10, 100, (y) => (y === 99 ? INK : WHITE));
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(0);
  });

  it("stops at a single line of content inside the band", () => {
    // A footer rule 20px up: the dead space is what lies below it, not the
    // whole background-coloured tail.
    const raw = image(10, 100, (y) => (y === 80 ? INK : WHITE));
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(19);
  });

  it("treats an entirely uniform image as a blank mount", () => {
    const raw = image(10, 100, () => WHITE);
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(100);
  });

  it("tolerates imperceptible per-channel noise", () => {
    // Anti-aliasing and PNG round-tripping shift a channel by a point or two;
    // that must not read as content.
    const raw = image(10, 100, (y) =>
      y >= 20 && y < 60 ? INK : y % 2 === 0 ? WHITE : [249, 251, 250],
    );
    expect(bottomDeadSpaceRows(raw, 10, 100, 3)).toBe(40);
  });

  it("handles an alpha channel", () => {
    const width = 4;
    const height = 10;
    const raw = Buffer.alloc(width * height * 4, 255);
    for (let x = 0; x < width; x += 1) raw[(3 * width + x) * 4] = 0; // one dark row at y=3
    expect(bottomDeadSpaceRows(raw, width, height, 4)).toBe(6);
  });
});

describe("measureBottomDeadSpace", () => {
  it("reports the band in CSS pixels, halving the device scale factor", async () => {
    // 40 device px of ground below the content → 20 CSS px.
    const png = await sharp({
      create: { width: 8, height: 100, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .composite([
        {
          input: {
            create: { width: 8, height: 60, channels: 3, background: { r: 24, g: 24, b: 27 } },
          },
          top: 20,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    expect(await measureBottomDeadSpace(png)).toEqual({ cssPx: 10, blank: false });
  });

  it("flags a screen that rendered as nothing at all", async () => {
    const png = await sharp({
      create: { width: 8, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    expect(await measureBottomDeadSpace(png)).toEqual({ cssPx: 20, blank: true });
  });
});

describe("buildContactSheet", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sheet-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lays every screen out in one row, labelled", async () => {
    const files = [];
    for (const [index, colour] of [
      { r: 200, g: 30, b: 30 },
      { r: 30, g: 200, b: 30 },
    ].entries()) {
      const path = join(dir, `${index + 1}-screen.png`);
      await sharp({ create: { width: 390, height: 844, channels: 3, background: colour } })
        .png()
        .toFile(path);
      files.push({ path, label: `${index + 1}-screen` });
    }

    const destination = join(dir, "_sheet.png");
    await buildContactSheet(files, destination, 200);

    const meta = await sharp(destination).metadata();
    expect(meta.height).toBe(212); // cell + gap
    // Two thumbnails side by side, each 190px tall at the screen's 390:844
    // aspect, plus the gaps around and between them.
    expect(meta.width).toBeGreaterThan(2 * Math.round((190 * 390) / 844));
    expect(meta.width).toBeLessThan(2 * Math.round((190 * 390) / 844) + 40);
  });
});
