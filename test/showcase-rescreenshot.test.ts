import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  rescreenshotScreens,
  type RescreenshotDeps,
} from "../src/showcase/rescreenshot.js";
import type { ShowcaseScreenSource, ShowcaseDerivativesUpdate } from "../src/showcase/store.js";

function source(over: Partial<ShowcaseScreenSource> = {}): ShowcaseScreenSource {
  return {
    id: "id-1",
    title: "Home",
    htmlUrl: "https://s3.example/showcase/run/1.html",
    width: 750,
    height: 1960,
    ...over,
  };
}

// rescreenshotScreens now runs every re-render through buildDerivatives (real
// sharp WebP encoding), so the fake `screenshot` dep must return genuine PNG
// bytes at the dimensions it reports — buildDerivatives reads its own width
// off the actual pixels, not off this function's return value.
async function fakePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 9, g: 8, b: 7 } },
  })
    .png()
    .toBuffer();
}

function makeDeps(
  screens: ShowcaseScreenSource[],
  render: (html: string) => { width: number; height: number },
): RescreenshotDeps & {
  updates: ShowcaseDerivativesUpdate[];
  uploads: string[];
} {
  const updates: ShowcaseDerivativesUpdate[] = [];
  const uploads: string[] = [];
  return {
    updates,
    uploads,
    store: {
      listScreenSources: async () => screens,
      updateScreenDerivatives: async (update) => {
        updates.push(update);
      },
    },
    fetchHtml: async (url) => `<html data-src="${url}">`,
    screenshot: async (html) => {
      const { width, height } = render(html);
      return { buffer: await fakePng(width, height), width, height };
    },
    uploadWebp: async (key) => {
      uploads.push(key);
      return `https://s3.example/${key}`;
    },
  };
}

describe("rescreenshotScreens", () => {
  it("re-uploads and repoints screens whose re-render changed size", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 2024 }));

    const summary = await rescreenshotScreens(deps);

    expect(summary).toEqual({ total: 1, updated: 1, unchanged: 0, failed: 0 });
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0]).toMatchObject({
      id: "id-1",
      width: 750,
      height: 2024,
    });
    expect(deps.updates[0].imageUrl).toMatch(/^https:\/\/s3\.example\/showcase\/rerender\//);
    expect(deps.updates[0].imageUrl1x).toMatch(/@1x\.webp$/);
    expect(deps.updates[0].lqip).toMatch(/^data:image\/webp;base64,/);
    // Both derivative objects for this screen, content-hashed, .webp — never
    // the old naive `${index}.png`-style key, and deterministic regardless
    // of what the random upload id happens to end in.
    expect(deps.uploads).toHaveLength(2);
    expect(deps.uploads[0]).toMatch(
      /^showcase\/rerender\/[0-9a-f-]+-[0-9a-f]{8}\.webp$/,
    );
    expect(deps.uploads[1]).toMatch(
      /^showcase\/rerender\/[0-9a-f-]+-[0-9a-f]{8}@1x\.webp$/,
    );
  });

  it("leaves a screen alone when the re-render comes out identical", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 1960 }));

    const summary = await rescreenshotScreens(deps);

    expect(summary).toEqual({ total: 1, updated: 0, unchanged: 1, failed: 0 });
    expect(deps.uploads).toEqual([]);
    expect(deps.updates).toEqual([]);
  });

  it("re-uploads unchanged screens under --force", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 1960 }));

    const summary = await rescreenshotScreens(deps, { force: true });

    expect(summary.updated).toBe(1);
    expect(deps.updates).toHaveLength(1);
  });

  it("touches nothing on a dry run", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 2024 }));

    const summary = await rescreenshotScreens(deps, { dryRun: true });

    expect(summary.updated).toBe(1);
    expect(deps.uploads).toEqual([]);
    expect(deps.updates).toEqual([]);
  });

  it("keeps going when one screen fails", async () => {
    const deps = makeDeps(
      [
        source({ id: "bad", htmlUrl: "https://s3.example/missing.html" }),
        source({ id: "good" }),
      ],
      () => ({ width: 750, height: 2024 }),
    );
    deps.fetchHtml = async (url: string) => {
      if (url.endsWith("missing.html")) throw new Error("GET 404");
      return `<html data-src="${url}">`;
    };

    const summary = await rescreenshotScreens(deps);

    expect(summary).toEqual({ total: 2, updated: 1, unchanged: 0, failed: 1 });
    expect(deps.updates.map((u) => u.id)).toEqual(["good"]);
  });

  it("honours --limit", async () => {
    const deps = makeDeps(
      [source({ id: "a" }), source({ id: "b" }), source({ id: "c" })],
      () => ({ width: 750, height: 2024 }),
    );

    const summary = await rescreenshotScreens(deps, { limit: 2 });

    expect(summary.total).toBe(2);
    expect(deps.updates.map((u) => u.id)).toEqual(["a", "b"]);
  });
});
