import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

// iPhone-ish mobile viewport, matching the showcase's mobile-app subject
// matter. deviceScaleFactor: 2 means the actual PNG comes out at 2x these
// CSS pixels — callers must read real pixel dimensions off the rendered
// image/page rather than assuming width*2/height*2 themselves (see
// `screenshotHtml` below, which does exactly that).
export const SHOWCASE_VIEWPORT = { width: 390, height: 844 } as const;
export const SHOWCASE_DEVICE_SCALE_FACTOR = 2;

// How long to wait for fonts/images before snapping anyway. A hung remote
// font or a picsum.photos hiccup must not hang the whole run.
const RENDER_READY_TIMEOUT_MS = 8_000;

export interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
}

// Renders one HTML document to a full-page PNG. Fonts and <img> decoding are
// awaited (with a bounded timeout) before the snapshot — without this, text
// reliably renders in a fallback font and images show as blank boxes,
// because Playwright's `load` event fires before either finishes.
export async function screenshotHtml(
  page: Page,
  html: string,
): Promise<ScreenshotResult> {
  await page.setContent(html, { waitUntil: "load" });

  // page.evaluate() has no built-in timeout (unlike waitForX/click), so a
  // hung remote font or a stuck image decode would otherwise hang this
  // forever. Race it against a plain Node timer instead.
  const renderReady = page.evaluate(async () => {
    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    const imagesDecoded = Promise.all(
      [...document.images].map((img) => img.decode().catch(() => {})),
    );
    await Promise.all([fontsReady, imagesDecoded]);
  });
  await Promise.race([
    renderReady,
    new Promise((resolve) => setTimeout(resolve, RENDER_READY_TIMEOUT_MS)),
  ]).catch(() => {
    // Timed out or errored waiting for fonts/images — still take the
    // screenshot rather than failing the whole run over a slow asset.
  });

  // Screenshot the <body> box rather than the page. The agent lays its screens
  // out at a fixed device width of its own choosing (375x812 is what it
  // actually emits), which rarely equals SHOWCASE_VIEWPORT — a full-page shot
  // then bakes a strip of empty background down the right edge and along the
  // bottom of every card in the gallery. An element screenshot crops to what
  // the design actually occupies, and degrades to the same result as fullPage
  // for a fluid layout that fills the viewport.
  const body = page.locator("body");
  const box = await body.boundingBox();
  const buffer =
    box && box.width >= 1 && box.height >= 1
      ? await body.screenshot({ type: "png" })
      : await page.screenshot({ type: "png", fullPage: true });

  // Read the ACTUAL rendered pixel size back from the PNG rather than
  // assuming SHOWCASE_VIEWPORT * deviceScaleFactor: fullPage screenshots can
  // exceed the viewport height when content overflows.
  const { width, height } = readPngDimensions(buffer);

  return { buffer, width, height };
}

// Minimal PNG IHDR reader — width/height live in the first chunk after the
// 8-byte signature, as big-endian uint32s at fixed offsets. Avoids pulling
// in an image-parsing dependency for two integers.
function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

export interface ShowcaseBrowserSession {
  browser: Browser;
  screenshot(html: string): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

// One Chromium instance for the whole run; pages are created and closed one
// at a time so screens are rendered sequentially, never sharing a page's
// mutable state (fonts/cookies/etc. don't leak between screens).
export async function openShowcaseBrowser(): Promise<ShowcaseBrowserSession> {
  const browser = await chromium.launch();

  return {
    browser,
    async screenshot(html: string): Promise<ScreenshotResult> {
      const page = await browser.newPage({
        viewport: SHOWCASE_VIEWPORT,
        deviceScaleFactor: SHOWCASE_DEVICE_SCALE_FACTOR,
      });
      try {
        page.setDefaultTimeout(RENDER_READY_TIMEOUT_MS);
        return await screenshotHtml(page, html);
      } finally {
        await page.close();
      }
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
}
