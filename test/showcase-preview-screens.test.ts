import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  describeReport,
  renderAndDiagnose,
  screenFileStem,
  type RenderDeps,
} from "../src/showcase/previewScreens.js";

// A solid-colour PNG of the given device-pixel size. 780x1688 is a correct
// mobile screen (390x844 CSS at deviceScaleFactor 2).
async function png(width: number, height: number, grey: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: grey, g: grey, b: grey } },
  })
    .png()
    .toBuffer();
}

// A screen that is background at the top and content at the bottom, so the
// dead-space measurement (which samples the top-left corner as the ground
// colour) reports zero.
async function pngWithContent(width: number, height: number): Promise<Buffer> {
  const top = { create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } };
  const stripe = await sharp({
    create: { width, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
  return sharp(top)
    .composite([{ input: stripe, left: 0, top: height - 40 }])
    .png()
    .toBuffer();
}

function deps(buffer: Buffer, clipped: string[] = []): RenderDeps & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    async screenshot(html: string) {
      // The module must hand normalized HTML to the browser, never the raw
      // input — that difference is exactly what a preview exists to catch.
      expect(html).toContain("<html");
      const meta = await sharp(buffer).metadata();
      return { buffer, width: meta.width!, height: meta.height!, clipped };
    },
    async writeFile(path: string) {
      written.push(path);
    },
  };
}

describe("renderAndDiagnose", () => {
  it("reports a correct screen with no notes and writes its PNG", async () => {
    const d = deps(await pngWithContent(780, 1688));
    const reports = await renderAndDiagnose(
      d,
      [{ label: "01-home", html: "<html><body>hi</body></html>", pngPath: "/tmp/01-home.png" }],
      "mobile",
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].notes).toEqual([]);
    expect(reports[0].width).toBe(780);
    expect(d.written).toEqual(["/tmp/01-home.png"]);
  });

  it("flags a screen whose content overflowed the box", async () => {
    const d = deps(await pngWithContent(780, 2000));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes[0]).toContain("expected 780x1688");
  });

  it("flags content sliced by the bottom edge", async () => {
    const d = deps(await pngWithContent(780, 1688), ["span.label cut 14px"]);
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes).toContain("sliced by the bottom edge: span.label cut 14px");
  });

  it("calls a uniform image a blank mount rather than dead space", async () => {
    const d = deps(await png(780, 1688, 255));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "mobile",
    );

    expect(report.notes).toEqual([
      "blank mount — nothing rendered, the asset wait probably timed out",
    ]);
  });

  it("judges desktop screens against the desktop box", async () => {
    const d = deps(await pngWithContent(2880, 2048));
    const [report] = await renderAndDiagnose(
      d,
      [{ label: "01", html: "<html><body>x</body></html>", pngPath: "/tmp/01.png" }],
      "desktop",
    );

    expect(report.notes).toEqual([]);
  });
});

describe("describeReport", () => {
  it("marks a clean screen ok on one line", () => {
    expect(
      describeReport({ label: "01", pngPath: "/tmp/01.png", width: 780, height: 1688, notes: [] }),
    ).toEqual(["/tmp/01.png — 780x1688  ok"]);
  });

  it("lists each note under the heading", () => {
    expect(
      describeReport({
        label: "01",
        pngPath: "/tmp/01.png",
        width: 780,
        height: 1688,
        notes: ["a", "b"],
      }),
    ).toEqual(["/tmp/01.png — 780x1688", "  ! a", "  ! b"]);
  });
});

describe("screenFileStem", () => {
  it("numbers from one and slugifies the name", () => {
    expect(screenFileStem("Home feed", 0)).toBe("01-home-feed");
  });

  it("falls back to `screen` when the name has no latin characters", () => {
    expect(screenFileStem("Лента", 4)).toBe("05-screen");
  });

  it("collapses punctuation runs and trims the edges", () => {
    expect(screenFileStem("  Cart / Checkout!  ", 9)).toBe("10-cart-checkout");
  });
});
