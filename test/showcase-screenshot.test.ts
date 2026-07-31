import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import {
  screenshotHtml,
  SHOWCASE_VIEWPORTS,
  SHOWCASE_DEVICE_SCALE_FACTOR,
} from "../src/showcase/screenshot.js";

// These need a real browser: the whole point is layout geometry, which no DOM
// shim reports. CI doesn't install Playwright's browsers (`npx playwright
// install chromium` is a local, documented step), so skip rather than fail
// when the binary isn't there.
let browser: Browser | null = null;
let launchFailure: string | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (err) {
    launchFailure = (err as Error).message;
  }
});

afterAll(async () => {
  await browser?.close();
});

const S = SHOWCASE_DEVICE_SCALE_FACTOR;

// Assets that arrive LATE. Everything here is deliberately slower than the
// browser's `domcontentloaded`, because that is exactly the window in which the
// screenshot used to fire — snapping a page whose icon font and photos hadn't
// arrived yet.
// Long enough that a screenshot which merely takes a few hundred ms of DOM
// bookkeeping can't pass by luck: if the code doesn't explicitly wait, the
// asset is still in flight when the assertion runs.
const ASSET_DELAY_MS = 2_500;
let assetOrigin = "";
let assetServer: Server | null = null;

// A 1x1 transparent PNG — the smallest thing a `background-image` can point at.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  assetServer = createServer((req, res) => {
    setTimeout(() => {
      // Two hops, like Phosphor's: the page @imports a sheet that itself
      // @imports the one carrying @font-face.
      if (req.url === "/slow.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(`@import url('${assetOrigin}/slow-face.css');`);
        return;
      }
      if (req.url === "/slow-face.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(
          `@font-face { font-family: 'SlowIcons'; src: url('${assetOrigin}/slow.woff2') format('woff2') }`,
        );
        return;
      }
      // Like Phosphor's real sheet: the rule that NAMES the icon family and
      // its glyph lives in the imported file too, so nothing in the page's own
      // styles mentions the font until that sheet lands.
      if (req.url === "/slow-icons.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(
          `@font-face { font-family: 'SlowIcons'; src: url('${assetOrigin}/slow.woff2') format('woff2') }\n` +
            `.icon::before { font-family: 'SlowIcons'; content: "\\e001" }`,
        );
        return;
      }
      if (req.url === "/slow.woff2") {
        res.writeHead(200, { "content-type": "font/woff2" });
        res.end(ONE_PIXEL_PNG);
        return;
      }
      if (req.url === "/slow.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(ONE_PIXEL_PNG);
        return;
      }
      res.writeHead(404).end();
    }, ASSET_DELAY_MS);
  });
  await new Promise<void>((resolve) => assetServer!.listen(0, "127.0.0.1", resolve));
  assetOrigin = `http://127.0.0.1:${(assetServer!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => assetServer?.close(() => resolve()));
});

// Parameterized over both showcase viewports (see SHOWCASE_VIEWPORTS in
// src/showcase/screenshot.ts) — the geometry helpers in screenshot.ts
// (matchViewportToBody/clearBottomBarOverlap/coverPinnedBars) are generic
// over viewport size, and this suite exists to prove that: every existing
// mobile-portrait assertion below is re-run verbatim against the desktop
// (landscape) viewport too, none weakened, so a regression that only shows up
// at a wide/short aspect ratio can't hide behind mobile-only coverage.
// Playwright's browsers aren't installed in CI (`npx playwright install
// chromium` is a local, documented step), so the whole suite is skipped there.
// It must be `skipIf` rather than an early `return` inside the callback: a
// callback that registers no tests leaves an EMPTY suite, and vitest fails an
// empty suite with "No test found in suite" instead of skipping it — which is
// what made CI red on every commit from the desktop-viewport change onward.
describe.skipIf(Boolean(process.env.CI)).each([
  { label: "mobile", viewport: SHOWCASE_VIEWPORTS.mobile },
  { label: "desktop", viewport: SHOWCASE_VIEWPORTS.desktop },
])("screenshotHtml ($label)", ({ viewport }) => {
  const W = viewport.width;
  const H = viewport.height;

  function page(bodyStyle: string, inner: string): string {
    return `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative;${bodyStyle}">${inner}</body></html>`;
  }

  const TAB_BAR = `<div style="position:absolute;bottom:0;left:0;right:0;height:64px;background:#fff">nav</div>`;

  async function shoot(html: string) {
    if (!browser) throw new Error("no browser");
    const p = await browser.newPage({ viewport, deviceScaleFactor: S });
    try {
      return await screenshotHtml(p, html);
    } finally {
      await p.close();
    }
  }

  // Same, but reports which requests the browser had FINISHED by the time the
  // snapshot was taken. (Resource-timing entries can't be used for this: a
  // setContent document has an about:blank origin and Chrome records none.)
  async function shootTrackingRequests(html: string): Promise<string[]> {
    if (!browser) throw new Error("no browser");
    const p = await browser.newPage({ viewport, deviceScaleFactor: S });
    // Both events count: what is being asserted is that the browser had SETTLED
    // the fetch before the snapshot. A font whose bytes Chrome then rejects
    // settles as `requestfailed`, and that still proves we waited.
    const finished: string[] = [];
    p.on("requestfinished", (req) => finished.push(req.url()));
    p.on("requestfailed", (req) => finished.push(req.url()));
    try {
      await screenshotHtml(p, html);
      return finished;
    } finally {
      await p.close();
    }
  }

  it("leaves a screen alone when nothing is covered by the bottom bar", async () => {
    if (!browser) return expect(launchFailure).toBe("browser unavailable — run `npx playwright install chromium`");

    // Content stops well above the bar.
    const { width, height } = await shoot(
      page("", `<div style="height:400px">content</div>${TAB_BAR}`),
    );

    expect(width).toBe(W * S);
    expect(height).toBe(H * S);
  });

  it("grows the screen just enough when content runs under the bottom bar", async () => {
    if (!browser) return;

    // Content ends 20px past the bar's top edge (bar occupies H-64 .. H).
    const contentHeight = H - 64 + 20;
    const { height } = await shoot(
      page("", `<div style="height:${contentHeight}px">content</div>${TAB_BAR}`),
    );

    expect(height).toBe((H + 20) * S);
  });

  // Live regression, run 90b00068 screen 3: the last session card's text
  // cleared the bar, but the card's own padding and rounded bottom edge did
  // not — text-only measurement stopped 16px short and the card shipped
  // sliced. A drawn surface is ink too.
  it("counts a card's own surface, not just the text inside it", async () => {
    if (!browser) return;

    // Card box ends 24px past the bar's top edge; its text ends well above it.
    const cardTop = H - 64 - 40;
    const card =
      `<div style="position:absolute;top:${cardTop}px;left:0;width:200px;height:104px;` +
      `background:#1c1c1e;padding:12px"><span>22:00</span></div>`;
    const { height } = await shoot(page("", `${card}${TAB_BAR}`));

    expect(height).toBe((H + 24) * S);
  });

  // Live regression, run d60b7a4e screen 3: a scooter-sharing map screen was
  // published 1164px tall instead of 812. The full-bleed `<img>` at `inset: 0`
  // ends at the screen bottom like a tab bar does, so it was taken for one —
  // putting `barTop` at y=0 and marking every inked element on the screen as
  // "covered by the bar".
  it("ignores a full-bleed layer that merely reaches the bottom edge", async () => {
    if (!browser) return;

    const fullBleed = `<div style="position:absolute;inset:0;background:#eee"></div>`;
    const overlay = `<div style="position:absolute;top:300px;left:20px">14.2 km/h</div>`;
    const { height } = await shoot(page("", `${fullBleed}${overlay}`));

    expect(height).toBe(H * S);
  });

  // The other half of the same live regression (run d60b7a4e screen 1): with
  // the full-bleed layer no longer mistaken for a bar, it must not count as
  // *covered* either — a bottom sheet resting on a map hides nothing a viewer
  // expected to read, and treating the map as buried content grew the screen
  // by the sheet's own height.
  it("does not treat a backdrop as content buried under a bottom sheet", async () => {
    if (!browser) return;

    const map = `<div style="position:absolute;inset:0;background:#eee">map</div>`;
    const sheet =
      `<div style="position:absolute;left:0;right:0;bottom:0;height:300px;background:#fff">` +
      `<div>3 scooters nearby</div></div>`;
    const { height } = await shoot(page("", `${map}${sheet}`));

    expect(height).toBe(H * S);
  });

  // Live regression, run d60b7a4e screen 1: the design declares its own device
  // preset (e.g. 375x812 for mobile) while the browser viewport is the
  // showcase's own (390x844 for mobile, 1440x1024 for desktop). A bottom
  // sheet at `left:0;right:0` is laid out against the viewport, so it came out
  // wider than a narrower declared crop — its right padding fell outside the
  // picture and the "Reserve" buttons ended up glued to, and shaved by, the
  // right edge.
  it("lays a screen out at its own declared width, not the viewport's", async () => {
    if (!browser) return;

    const declaredW = W - 15;
    const declaredH = H - 32;
    const sheet =
      `<div id="sheet" style="position:absolute;left:0;right:0;bottom:0;padding:0 16px">` +
      `<button id="cta" style="float:right;width:84px;height:36px">Reserve</button></div>`;
    const html =
      `<!doctype html><html><body style="margin:0;width:${declaredW}px;height:${declaredH}px;overflow:hidden">` +
      `<div style="height:200px">content</div>${sheet}</body></html>`;

    const { width, height } = await shoot(html);

    // Cropped to the declared box, and not grown by repairs that only had work
    // to do because the overlay hung off a wider/taller viewport.
    expect(width).toBe(declaredW * S);
    expect(height).toBe(declaredH * S);
  });

  // The regression that shipped first: a hero overlay pinned to `bottom: 0` of
  // its own container matched a naive "bottom: 0" test, so everything below it
  // counted as covered and the screen was inflated by hundreds of pixels.
  it("ignores an element pinned to the bottom of an inner container", async () => {
    if (!browser) return;

    const hero = `<div style="position:relative;height:200px">
      <div style="position:absolute;bottom:0;left:0;right:0;height:40px">caption</div>
    </div>`;
    const { height } = await shoot(page("", `${hero}<div style="height:300px">rest</div>`));

    expect(height).toBe(H * S);
  });

  // What the agent actually emits: a body sized to its own device preset,
  // `position: static`, and a tab bar at `position: absolute; bottom: 0`.
  // Static body means the bar's containing block is the initial containing
  // block — the VIEWPORT — so the bar used to sit at the viewport's bottom
  // edge, below the shorter body box, and the screen was stretched to reach
  // it. Matching the viewport to the declared box removes the gap instead:
  // the bar lands where the design put it and the screen publishes at the
  // size it asked for.
  it("publishes a screen at its declared height rather than the viewport's", async () => {
    if (!browser) return;

    const declaredH = H - 32;
    const shortBody = `margin:0;width:${W}px;height:${declaredH}px;overflow:hidden`;
    const html = `<!doctype html><html><body style="${shortBody}"><div style="height:400px">content</div>${TAB_BAR}</body></html>`;
    const { height } = await shoot(html);

    expect(height).toBe(declaredH * S);
  });

  // The fallback still matters for a body whose height is a function of the
  // viewport: matching the viewport to it just moves the target, so the
  // viewport is put back and the bar genuinely does hang below the body box.
  it("still covers a bar hanging below a fluid body", async () => {
    if (!browser) return;

    const fluidBody = `margin:0;width:${W}px;height:50%`;
    const html = `<!doctype html><html style="height:100%"><body style="${fluidBody}">${TAB_BAR}</body></html>`;
    const { height } = await shoot(html);

    // Body is half the viewport; the bar sits at the viewport's bottom edge,
    // so the screen has to reach it rather than slice it off.
    expect(height).toBe(H * S);
  });

  // The showcase's icon set (Phosphor) is an icon FONT reached through
  // `@import`. `document.fonts.ready` alone loses the race: at the moment it
  // is called the imported sheet has only just landed, no layout has demanded
  // the family yet, so there is nothing pending and it resolves instantly —
  // and every icon in a whole run came out blank.
  it("waits for a font the page's own styles ask for", async () => {
    if (!browser) return;

    const fontUrl = `${assetOrigin}/slow.woff2`;
    const html = page(
      "",
      `<style>@import url('${assetOrigin}/slow.css');</style>` +
        `<style>.icon::before { font-family: 'SlowIcons'; content: '\\e001' }</style>` +
        `<i class="icon"></i>`,
    );

    expect(await shootTrackingRequests(html)).toContain(fontUrl);
  });

  // Pins the shape that shipped blank icons on real screens: the family and
  // the glyph are named ONLY inside the @import'ed sheet, so nothing in the
  // page's own styles mentions the font until that sheet lands.
  // Caveat, so nobody reads more into a green run than is there: a same-origin
  // sheet blocks "domcontentloaded", so this case passes with or without the
  // explicit import wait in screenshotHtml. It guards the end-to-end path, not
  // that wait — which earns its keep against remote, non-blocking imports
  // (unpkg, Google Fonts) that this harness cannot reproduce.
  it("waits for a font named only by an @import'ed stylesheet", async () => {
    if (!browser) return;

    const fontUrl = `${assetOrigin}/slow.woff2`;
    const html = page(
      "",
      `<style>@import url('${assetOrigin}/slow-icons.css');</style><i class="icon"></i>`,
    );

    expect(await shootTrackingRequests(html)).toContain(fontUrl);
  });

  it("waits for a CSS background-image", async () => {
    if (!browser) return;

    const url = `${assetOrigin}/slow.png`;
    const html = page("", `<div style="height:200px;background-image:url('${url}')">hero</div>`);

    expect(await shootTrackingRequests(html)).toContain(url);
  });

  it("covers the bar after growing the screen to clear overlapping content", async () => {
    if (!browser) return;

    const bodyHeight = H - 32;
    // Content runs 20px under the bar (which occupies viewport H-64 .. H).
    const contentHeight = H - 64 + 20;
    const shortBody = `margin:0;width:${W}px;height:${bodyHeight}px;overflow:hidden`;
    const html = `<!doctype html><html><body style="${shortBody}"><div style="height:${contentHeight}px">content</div>${TAB_BAR}</body></html>`;
    const { height } = await shoot(html);

    // Viewport grew by 20 to uncover the content, taking the bar with it, so
    // the bar's bottom — and the screen — now sit at H + 20.
    expect(height).toBe((H + 20) * S);
  });
});
