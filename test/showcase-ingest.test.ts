import { describe, expect, it, vi } from "vitest";
import { parseManifest, resolveScreens } from "../src/showcase/ingest.js";
import { publishScreens, type PublishDeps } from "../src/showcase/publish.js";
import { MAX_SHOWCASE_SCREENS } from "../src/showcase/runner.js";

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
  function makeDeps(): { deps: PublishDeps; rows: Array<Record<string, unknown>> } {
    const rows: Array<Record<string, unknown>> = [];
    let id = 0;
    return {
      rows,
      deps: {
        screenshot: async (html) => ({
          buffer: Buffer.from(`png:${html}`),
          width: 390,
          height: 844,
        }),
        uploadPng: async (key) => `https://cdn.example/${key}`,
        uploadHtml: async (key) => `https://cdn.example/${key}`,
        insertScreen: async (row) => {
          rows.push(row);
        },
        newId: () => `id-${++id}`,
        log: () => {},
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

    expect(published).toEqual([
      { title: "Главная", imageUrl: "https://cdn.example/showcase/run-1/1.png" },
      { title: "Поездка", imageUrl: "https://cdn.example/showcase/run-1/2.png" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: "run-1",
      theme: "заказ такси",
      model: "hand-authored",
      htmlUrl: "https://cdn.example/showcase/run-1/1.html",
      width: 390,
      height: 844,
    });
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
});
