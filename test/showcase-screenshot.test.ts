import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { screenshotHtml, SHOWCASE_VIEWPORT, SHOWCASE_DEVICE_SCALE_FACTOR } from "../src/showcase/screenshot.js";

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

const { width: W, height: H } = SHOWCASE_VIEWPORT;
const S = SHOWCASE_DEVICE_SCALE_FACTOR;

function page(bodyStyle: string, inner: string): string {
  return `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative;${bodyStyle}">${inner}</body></html>`;
}

const TAB_BAR = `<div style="position:absolute;bottom:0;left:0;right:0;height:64px;background:#fff">nav</div>`;

async function shoot(html: string) {
  if (!browser) throw new Error("no browser");
  const p = await browser.newPage({ viewport: SHOWCASE_VIEWPORT, deviceScaleFactor: S });
  try {
    return await screenshotHtml(p, html);
  } finally {
    await p.close();
  }
}

describe.skipIf(!!process.env.CI)("screenshotHtml", () => {
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

  // What the agent actually emits: a body sized to its own device preset
  // (375x812), `position: static`, and a tab bar at `position: absolute;
  // bottom: 0`. Static body means the bar's containing block is the initial
  // containing block — the VIEWPORT — so the bar sits at the viewport's bottom
  // edge, below the shorter body box, and the body-element screenshot sliced
  // its last rows off.
  it("covers a bottom bar pinned below a body shorter than the viewport", async () => {
    if (!browser) return;

    const shortBody = `margin:0;width:${W}px;height:${H - 32}px;overflow:hidden`;
    const html = `<!doctype html><html><body style="${shortBody}"><div style="height:400px">content</div>${TAB_BAR}</body></html>`;
    const { height } = await shoot(html);

    // The bar's bottom edge is the viewport bottom, so the screen has to reach
    // it — not stop at the body's own 812px.
    expect(height).toBe(H * S);
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
