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
// A bottom-pinned tab bar covering the last row of content is the single most
// common flaw in the agent's screens: it pins a bar to `bottom: 0` and then
// lets the content run to the full screen height, so the last line sits under
// an opaque bar. The skill now forbids this, but a prompt can't guarantee it,
// and a half-covered row is glaring in a gallery of otherwise clean screens.
//
// The repair is deterministic and non-destructive: since the bar is pinned to
// the bottom, making the screen taller moves the BAR down and leaves the
// content where the designer put it. Nothing is deleted, moved or rescaled —
// the screen just gains the strip of room the design forgot to reserve.
// Returns how many pixels were added (0 when nothing overlapped).
async function clearBottomBarOverlap(page: Page): Promise<number> {
  // NOTE: no named inner functions inside page.evaluate — tsx/esbuild rewrites
  // them with a `__name` helper that only exists in the Node bundle, so the
  // browser throws "__name is not defined". Keep the body to inline
  // expressions.
  const needed = await page.evaluate(() => {
    // `bottom: 0` alone is not enough: a hero overlay pinned to the bottom of
    // its own container matches that too, and treating it as a screen-level bar
    // makes everything below it look covered. What identifies a real bottom bar
    // is that its bottom edge lands on the bottom edge of the screen.
    const screenBottom = document.body.getBoundingClientRect().bottom;
    const bars = [...document.body.querySelectorAll("*")].filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") return false;
      return el.getBoundingClientRect().bottom >= screenBottom - 1;
    });
    if (bars.length === 0) return 0;

    const barTop = Math.min(...bars.map((b) => b.getBoundingClientRect().top));
    const barHeight = Math.max(...bars.map((b) => b.getBoundingClientRect().height));
    if (barHeight < 1) return 0;

    // Only leaf nodes with visible content count — an ancestor box that merely
    // spans the whole screen isn't "covered" in any way a viewer would notice.
    const covered = [...document.body.querySelectorAll("*")].filter((el) => {
      if (el.children.length > 0) return false;
      if (bars.some((bar) => bar === el || bar.contains(el))) return false;
      const hasInk = (el.textContent ?? "").trim().length > 0 || el.tagName === "IMG";
      if (!hasInk) return false;
      return el.getBoundingClientRect().bottom > barTop;
    });
    if (covered.length === 0) return 0;

    const lowest = Math.max(...covered.map((el) => el.getBoundingClientRect().bottom));
    return Math.ceil(lowest - barTop);
  });

  if (needed <= 0) return 0;

  const viewport = page.viewportSize();
  if (!viewport) return 0;

  await page.setViewportSize({ width: viewport.width, height: viewport.height + needed });
  // The body has to grow with the viewport — its height is usually hard-coded
  // to the device preset, and it is the box that gets screenshotted.
  await page.evaluate((extra) => {
    const body = document.body;
    const current = body.getBoundingClientRect().height;
    body.style.height = `${current + extra}px`;
  }, needed);

  return needed;
}

// Screen-level bars hang off the VIEWPORT, not the <body> box: `fixed` always
// does, and `absolute` does too whenever no ancestor is positioned — which is
// the normal case, since the agent leaves <body> `static`. So a design whose
// body is shorter than SHOWCASE_VIEWPORT (375x812 is what the agent actually
// emits) leaves its tab bar sitting below the body box, and the body-element
// screenshot in `screenshotHtml` slices the bar's last rows off. That was
// visible on real gallery cards as a tab bar with its labels cut in half.
//
// Extend the body down to the lowest pinned element instead. Returns how many
// pixels were added (0 when nothing hangs below).
async function coverPinnedBars(page: Page): Promise<number> {
  // NOTE: no named inner functions inside page.evaluate — see the note in
  // clearBottomBarOverlap.
  return page.evaluate(() => {
    const body = document.body;
    const rect = body.getBoundingClientRect();
    let lowest = rect.bottom;
    for (const el of body.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.height >= 1 && r.bottom > lowest) lowest = r.bottom;
    }

    const extra = Math.ceil(lowest - rect.bottom);
    if (extra <= 0) return 0;
    body.style.height = `${rect.height + extra}px`;
    return extra;
  });
}

export async function screenshotHtml(
  page: Page,
  html: string,
): Promise<ScreenshotResult> {
  // "domcontentloaded", not "load": `load` waits for every remote image, and
  // it THROWS on the page's default timeout — so a single slow asset (an
  // agent-generated photo still warming up in S3) took down the whole run.
  // Asset readiness is handled just below, where overrunning it degrades to
  // "screenshot anyway" instead of an exception.
  await page.setContent(html, { waitUntil: "domcontentloaded" });

  // page.evaluate() has no built-in timeout (unlike waitForX/click), so a
  // hung remote font or a stuck image decode would otherwise hang this
  // forever. Race it against a plain Node timer instead.
  //
  // `decode()` alone resolves for an image that hasn't started loading, so
  // wait on the load event too — otherwise the race can fall through
  // instantly and snap a picture of empty boxes.
  //
  // Three things beyond <img> have to be waited on explicitly, and every one
  // of them cost a whole showcase run before it was handled here:
  //
  //   - CSS `background-image`. The agent puts its generated photos there, not
  //     in <img>, so they never show up in `document.images` and the old check
  //     sailed straight past them. Re-requesting the same URL through `new
  //     Image()` is free (same HTTP cache entry) and gives us a load event.
  //   - Fonts the page's own styles ask for, Phosphor's icon font above all.
  //     `document.fonts.ready` is not enough on its own: when it is called the
  //     @import'ed sheet has only just arrived and nothing has demanded the
  //     family yet, so there is nothing pending and it resolves instantly.
  //     Asking for each used family by hand makes the load pending FIRST.
  //   - `loading="lazy"` images below the fold. A showcase screen is taller
  //     than the viewport, so a lazy image never enters the viewport and never
  //     loads at all.
  const renderReady = page.evaluate(async () => {
    // NOTE: no named inner functions inside page.evaluate — see the note on
    // clearBottomBarOverlap.
    for (const img of document.images) img.loading = "eager";

    const elements = [document.documentElement, ...document.body.querySelectorAll("*")];
    const styles = elements.flatMap((el) => [
      getComputedStyle(el),
      getComputedStyle(el, "::before"),
      getComputedStyle(el, "::after"),
    ]);

    const backgroundUrls = new Set<string>();
    for (const cs of styles) {
      for (const layer of [cs.backgroundImage, cs.maskImage, cs.borderImageSource]) {
        if (!layer || layer === "none") continue;
        for (const match of layer.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
          if (!match[2].startsWith("data:")) backgroundUrls.add(match[2]);
        }
      }
    }

    // Kick every font the page actually uses, so the loads are pending before
    // `fonts.ready` is consulted. `content` matters for icon fonts: the glyph
    // lives in a private-use codepoint, and passing it makes the browser fetch
    // the subset that contains it.
    if (document.fonts) {
      for (const cs of styles) {
        const family = cs.fontFamily;
        if (!family) continue;
        const text = (cs.content ?? "").replace(/^["']|["']$/g, "");
        try {
          void document.fonts.load(
            `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${family}`,
            text && text !== "normal" && text !== "none" ? text : undefined,
          );
        } catch {
          // A computed shorthand the Font Loading API rejects (an unquoted
          // family with spaces, say) is not worth failing the screenshot over.
        }
      }
    }

    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    const imagesDecoded = Promise.all(
      [...document.images].map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete) {
              img.decode().then(() => resolve(), () => resolve());
              return;
            }
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    );
    const backgroundsLoaded = Promise.all(
      [...backgroundUrls].map(
        (url) =>
          new Promise<void>((resolve) => {
            const probe = new Image();
            probe.addEventListener("load", () => resolve(), { once: true });
            probe.addEventListener("error", () => resolve(), { once: true });
            probe.src = url;
          }),
      ),
    );
    await Promise.all([fontsReady, imagesDecoded, backgroundsLoaded]);
  });
  await Promise.race([
    renderReady,
    new Promise((resolve) => setTimeout(resolve, RENDER_READY_TIMEOUT_MS)),
  ]).catch(() => {
    // Timed out or errored waiting for fonts/images — still take the
    // screenshot rather than failing the whole run over a slow asset.
  });

  const grewBy = await clearBottomBarOverlap(page);
  if (grewBy > 0) {
    console.log(`[showcase] grew the screen by ${grewBy}px so the bottom bar stopped covering content`);
  }

  const coveredBy = await coverPinnedBars(page);
  if (coveredBy > 0) {
    console.log(`[showcase] extended the screen by ${coveredBy}px so the bottom bar wasn't cut off`);
  }

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
