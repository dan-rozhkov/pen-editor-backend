import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  coverIndexFrom,
  parseManifest,
  resolveCoverIndex,
  resolveScreens,
} from "../src/showcase/ingest.js";
import { publishScreens, type PublishDeps } from "../src/showcase/publish.js";
import { MAX_SHOWCASE_SCREENS } from "../src/showcase/runner.js";

// publishScreens now runs every screenshot through buildDerivatives (real
// sharp WebP encoding), so the fake `screenshot` dep must return genuine PNG
// bytes rather than an arbitrary string buffer. Dimensions are parameterized
// (default 390x844, the mocked "screenshot" size used throughout this file)
// so callers can build a PNG whose *real* pixel dimensions match whatever
// `width`/`height` they hand back from `screenshot()` — the stored row's
// width/height are read off the 2x WebP itself (publish.ts), not off this
// mocked return value, so the fixture PNG's actual size is what actually
// gets asserted on.
async function fakeScreenshotPng(width = 390, height = 844): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    theme: "заказ такси",
    screens: [{ name: "Главная", htmlContent: "<div>hi</div>" }],
    ...overrides,
  });
}

describe("parseManifest", () => {
  it("accepts a minimal manifest", () => {
    const manifest = parseManifest(manifestJson());
    expect(manifest.theme).toBe("заказ такси");
    expect(manifest.screens).toHaveLength(1);
    expect(manifest.prompt).toBeUndefined();
  });

  it("reports invalid JSON as such rather than throwing a SyntaxError", () => {
    expect(() => parseManifest("{ nope")).toThrow(/not valid JSON/);
  });

  it("rejects a screen carrying both htmlContent and file", () => {
    const raw = manifestJson({
      screens: [{ name: "Главная", htmlContent: "<div/>", file: "1.html" }],
    });
    expect(() => parseManifest(raw)).toThrow(/exactly one/);
  });

  it("rejects a screen carrying neither", () => {
    expect(() => parseManifest(manifestJson({ screens: [{ name: "Главная" }] }))).toThrow(
      /exactly one/,
    );
  });

  it("rejects more screens than the showcase keeps", () => {
    const screens = Array.from({ length: MAX_SHOWCASE_SCREENS + 1 }, (_, i) => ({
      name: `Экран ${i}`,
      htmlContent: "<div/>",
    }));
    expect(() => parseManifest(manifestJson({ screens }))).toThrow(/at most/);
  });

  it("parses a screen marked as cover", () => {
    const manifest = parseManifest(
      manifestJson({
        screens: [
          { name: "Главная", htmlContent: "<div>a</div>" },
          { name: "Профиль", htmlContent: "<div>b</div>", cover: true },
        ],
      }),
    );
    expect(coverIndexFrom(manifest)).toBe(2);
  });

  it("has no cover index when nothing is marked", () => {
    const manifest = parseManifest(manifestJson());
    expect(coverIndexFrom(manifest)).toBeUndefined();
  });

  it("rejects more than one screen marked as cover", () => {
    const raw = manifestJson({
      screens: [
        { name: "Главная", htmlContent: "<div>a</div>", cover: true },
        { name: "Профиль", htmlContent: "<div>b</div>", cover: true },
      ],
    });
    expect(() => parseManifest(raw)).toThrow(/at most one screen/);
  });
});

describe("resolveCoverIndex", () => {
  it("throws when --cover is present without a value", () => {
    expect(() => resolveCoverIndex({ raw: undefined, flagPresent: true })).toThrow(
      /requires a value/,
    );
  });

  it("throws on --cover=0", () => {
    expect(() => resolveCoverIndex({ raw: "0", flagPresent: true })).toThrow(
      /positive integer/,
    );
  });

  it("throws on a non-numeric value", () => {
    expect(() => resolveCoverIndex({ raw: "abc", flagPresent: true })).toThrow(
      /positive integer/,
    );
  });

  it("throws on a fractional value", () => {
    expect(() => resolveCoverIndex({ raw: "1.5", flagPresent: true })).toThrow(
      /positive integer/,
    );
  });

  it("throws when above the known screen count", () => {
    expect(() =>
      resolveCoverIndex({ raw: "3", flagPresent: true, screenCount: 2 }),
    ).toThrow(/between 1 and 2/);
  });

  it("does not bound-check when the screen count isn't known yet", () => {
    expect(resolveCoverIndex({ raw: "99", flagPresent: true })).toBe(99);
  });

  it("overrides the manifest default when the flag is given", () => {
    expect(
      resolveCoverIndex({ raw: "2", flagPresent: true, manifestDefault: 1, screenCount: 2 }),
    ).toBe(2);
  });

  it("falls back to the manifest default when the flag is absent", () => {
    expect(
      resolveCoverIndex({ raw: undefined, flagPresent: false, manifestDefault: 1, screenCount: 2 }),
    ).toBe(1);
  });

  it("is undefined when neither the flag nor a manifest default is present", () => {
    expect(resolveCoverIndex({ raw: undefined, flagPresent: false })).toBeUndefined();
  });
});

describe("resolveScreens", () => {
  it("reads file-backed screens and passes inline ones through", async () => {
    const readFile = vi.fn().mockResolvedValue("<main>from disk</main>");
    const manifest = parseManifest(
      manifestJson({
        screens: [
          { name: "Главная", file: "screens/1.html" },
          { name: "Профиль", htmlContent: "<div>inline</div>" },
        ],
      }),
    );

    const screens = await resolveScreens({ readFile }, manifest);

    expect(readFile).toHaveBeenCalledWith("screens/1.html");
    expect(screens).toEqual([
      { name: "Главная", htmlContent: "<main>from disk</main>" },
      { name: "Профиль", htmlContent: "<div>inline</div>" },
    ]);
  });

  it("fails loudly on an empty file rather than publishing a blank screen", async () => {
    const manifest = parseManifest(
      manifestJson({ screens: [{ name: "Главная", file: "1.html" }] }),
    );
    await expect(
      resolveScreens({ readFile: async () => "   \n" }, manifest),
    ).rejects.toThrow(/empty HTML/);
  });
});

describe("publishScreens", () => {
  function makeDeps(): {
    deps: PublishDeps;
    rows: Array<Record<string, unknown>>;
    pinnedIds: string[];
  } {
    const rows: Array<Record<string, unknown>> = [];
    const pinnedIds: string[] = [];
    let id = 0;
    return {
      rows,
      pinnedIds,
      deps: {
        screenshot: async () => ({
          buffer: await fakeScreenshotPng(),
          width: 390,
          height: 844,
        }),
        uploadWebp: async (key) => `https://cdn.example/${key}`,
        uploadHtml: async (key) => `https://cdn.example/${key}`,
        insertScreen: async (row) => {
          rows.push(row);
        },
        newId: () => `id-${++id}`,
        log: () => {},
        pinScreen: async (screenId) => {
          pinnedIds.push(screenId);
          return true;
        },
      },
    };
  }

  it("screenshots, uploads and stores every screen under one run id", async () => {
    const { deps, rows } = makeDeps();

    const published = await publishScreens(deps, {
      runId: "run-1",
      theme: "заказ такси",
      prompt: "prompt text",
      model: "hand-authored",
      screens: [
        { name: "Главная", htmlContent: "<div>a</div>" },
        { name: "Поездка", htmlContent: "<div>b</div>" },
      ],
    });

    expect(published).toHaveLength(2);
    expect(published[0].title).toBe("Главная");
    expect(published[0].imageUrl).toMatch(
      /^https:\/\/cdn\.example\/showcase\/run-1\/1-[0-9a-f]{8}\.webp$/,
    );
    expect(published[1].title).toBe("Поездка");
    expect(published[1].imageUrl).toMatch(
      /^https:\/\/cdn\.example\/showcase\/run-1\/2-[0-9a-f]{8}\.webp$/,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: "run-1",
      theme: "заказ такси",
      model: "hand-authored",
      htmlUrl: "https://cdn.example/showcase/run-1/1.html",
      width: 390,
      height: 844,
    });
    // No .png upload anywhere, and the 1x/lqip fields are populated — the
    // publish path stops touching PNG entirely.
    expect(rows[0].imageUrl).not.toMatch(/\.png$/);
    expect(rows[0].imageUrl1x).toMatch(/@1x\.webp$/);
    expect(rows[0].lqip).toMatch(/^data:image\/webp;base64,/);
    // Same hash used for both variants of one screen — that's what makes
    // both objects immutable content-addressed keys.
    const hash2x = (rows[0].imageUrl as string).match(/1-([0-9a-f]{8})\.webp$/)?.[1];
    const hash1x = (rows[0].imageUrl1x as string).match(/1-([0-9a-f]{8})@1x\.webp$/)?.[1];
    expect(hash1x).toBe(hash2x);
  });

  it("stores width/height matching the actual 2x WebP, not whatever screenshot() reports", async () => {
    // A deliberately mismatched screenshot(): it claims 390x844 but the real
    // PNG bytes are 300x600. If publishScreens ever went back to trusting
    // the mocked width/height instead of reading them off the encoded WebP,
    // this would catch it — the row must describe the bytes it actually
    // points at, since the frontend's srcset `w` descriptors are built
    // straight from these columns.
    const { deps, rows } = makeDeps();
    deps.screenshot = async () => ({
      buffer: await fakeScreenshotPng(300, 600),
      width: 390,
      height: 844,
    });

    await publishScreens(deps, {
      runId: "run-2",
      theme: "заказ такси",
      prompt: "prompt text",
      model: "hand-authored",
      screens: [{ name: "Главная", htmlContent: "<div>a</div>" }],
    });

    expect(rows[0]).toMatchObject({ width: 300, height: 600 });
  });

  it("falls back to a numbered title when a screen has no name", async () => {
    const { deps, rows } = makeDeps();

    await publishScreens(deps, {
      runId: "run-2",
      theme: "заказ такси",
      prompt: "p",
      model: "m",
      screens: [{ name: "", htmlContent: "<div/>" }],
    });

    expect(rows[0].title).toBe("заказ такси — экран 1");
  });

  it("pins the screen at coverIndex after it is inserted", async () => {
    const { deps, rows, pinnedIds } = makeDeps();

    await publishScreens(deps, {
      runId: "run-3",
      theme: "заказ такси",
      prompt: "p",
      model: "m",
      screens: [
        { name: "Главная", htmlContent: "<div>a</div>" },
        { name: "Профиль", htmlContent: "<div>b</div>" },
      ],
      coverIndex: 2,
    });

    expect(pinnedIds).toEqual([rows[1].id]);
  });

  it("pins nothing when coverIndex is not set", async () => {
    const { deps, pinnedIds } = makeDeps();

    await publishScreens(deps, {
      runId: "run-4",
      theme: "заказ такси",
      prompt: "p",
      model: "m",
      screens: [{ name: "Главная", htmlContent: "<div>a</div>" }],
    });

    expect(pinnedIds).toEqual([]);
  });
});
