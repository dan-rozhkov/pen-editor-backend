import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildDerivatives } from "../src/showcase/derivatives.js";

// A real small PNG, generated with sharp itself rather than checked in as a
// binary fixture — genuine encoded bytes either way, and this keeps the test
// self-contained. 200x400 is large enough to halve cleanly for the @1x check.
async function makeSourcePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 400,
      channels: 3,
      background: { r: 120, g: 180, b: 220 },
    },
  })
    .png()
    .toBuffer();
}

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  );
}

describe("buildDerivatives", () => {
  it("produces a 2x WebP at the source's native width", async () => {
    const png = await makeSourcePng();
    const { webp2x } = await buildDerivatives(png);

    expect(isWebp(webp2x.body)).toBe(true);
    expect(webp2x.width).toBe(200);
    expect(webp2x.height).toBe(400);
  });

  it("produces a 1x WebP at half the source's width", async () => {
    const png = await makeSourcePng();
    const { webp1x } = await buildDerivatives(png);

    expect(isWebp(webp1x.body)).toBe(true);
    expect(webp1x.width).toBe(100);
    expect(webp1x.height).toBe(200);
  });

  it("produces an inline blurred WebP placeholder under 1 KB", async () => {
    const png = await makeSourcePng();
    const { lqip } = await buildDerivatives(png);

    expect(lqip.startsWith("data:image/webp;base64,")).toBe(true);
    const base64 = lqip.slice("data:image/webp;base64,".length);
    const bytes = Buffer.from(base64, "base64");
    expect(isWebp(bytes)).toBe(true);
    expect(bytes.length).toBeLessThan(1024);
  });
});
