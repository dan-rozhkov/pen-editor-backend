import sharp from "sharp";

// Publish-time re-encode: PNG in, two WebPs (2x/1x) plus an inline blurred
// placeholder out. PNG was only ever chosen because it's what Playwright
// emits directly — for photographic mobile-app screens it's ~10x heavier
// than WebP q80 at the same pixels (see the spec's measured numbers), and
// nobody needs lossless fidelity for a gallery thumbnail.

export interface ScreenDerivatives {
  webp2x: { body: Buffer; width: number; height: number };
  webp1x: { body: Buffer; width: number; height: number };
  // data:image/webp;base64,... — small enough to ship inline in the feed
  // JSON so the client has something to paint before the real image (or
  // even the request for it) lands. Budget: under 1 KB.
  lqip: string;
}

// Width of the LQIP render. 16px is enough detail for a blurred placeholder
// and keeps the base64 payload comfortably under the 1 KB budget.
const LQIP_WIDTH = 16;

export async function buildDerivatives(png: Buffer): Promise<ScreenDerivatives> {
  const source = sharp(png);
  const metadata = await source.metadata();
  const nativeWidth = metadata.width;
  if (!nativeWidth) {
    throw new Error("buildDerivatives: source PNG has no readable width");
  }

  const [webp2xBody, webp1xBody, lqipBody] = await Promise.all([
    // Native width: this *is* the display size at @2x device-pixel-ratio
    // (the screenshot pipeline already renders at deviceScaleFactor: 2), so
    // no resize is needed for the 2x variant — only the format changes.
    sharp(png).webp({ quality: 80 }).toBuffer(),
    sharp(png)
      .resize({ width: Math.round(nativeWidth / 2) })
      .webp({ quality: 80 })
      .toBuffer(),
    sharp(png).resize({ width: LQIP_WIDTH }).blur().webp({ quality: 40 }).toBuffer(),
  ]);

  const webp2xMeta = await sharp(webp2xBody).metadata();
  const webp1xMeta = await sharp(webp1xBody).metadata();

  return {
    webp2x: {
      body: webp2xBody,
      width: webp2xMeta.width ?? nativeWidth,
      height: webp2xMeta.height ?? metadata.height ?? 0,
    },
    webp1x: {
      body: webp1xBody,
      width: webp1xMeta.width ?? Math.round(nativeWidth / 2),
      height: webp1xMeta.height ?? 0,
    },
    lqip: `data:image/webp;base64,${lqipBody.toString("base64")}`,
  };
}
