import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  rescreenshotScreens,
  type RescreenshotDeps,
} from "../src/showcase/rescreenshot.js";
import type { ShowcaseScreenSource, ShowcaseDerivativesUpdate } from "../src/showcase/store.js";
import { normalizeShowcaseHtml } from "../src/showcase/normalizeHtml.js";

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
  htmlUploads: Array<{ key: string; body: string }>;
  htmlRepoints: Array<{ id: string; htmlUrl: string }>;
  listArgs: Array<{ appOf?: string } | undefined>;
} {
  const updates: ShowcaseDerivativesUpdate[] = [];
  const uploads: string[] = [];
  const htmlUploads: Array<{ key: string; body: string }> = [];
  const htmlRepoints: Array<{ id: string; htmlUrl: string }> = [];
  const listArgs: Array<{ appOf?: string } | undefined> = [];
  return {
    updates,
    uploads,
    htmlUploads,
    htmlRepoints,
    listArgs,
    store: {
      listScreenSources: async (options) => {
        listArgs.push(options);
        return screens;
      },
      updateScreenDerivatives: async (update) => {
        updates.push(update);
      },
      updateScreenHtmlUrl: async (id, htmlUrl) => {
        htmlRepoints.push({ id, htmlUrl });
      },
    },
    // Already-normalized by default, so the size-driven tests below stay about
    // size alone — a screen still carrying raw markup is its own test.
    fetchHtml: async (url) => normalizeShowcaseHtml(`<html data-src="${url}">`),
    uploadHtml: async (key, body) => {
      htmlUploads.push({ key, body: body.toString("utf8") });
      return `https://s3.example/${key}`;
    },
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
      return normalizeShowcaseHtml(`<html data-src="${url}">`);
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

  it("normalizes and repoints HTML published before the UA reset existed", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 1960 }));
    deps.fetchHtml = async () => "<html><head></head><body><button>Go</button></body></html>";

    // Same size, no --force: the un-normalized HTML alone must be enough to
    // make this screen a repair candidate, or the sweep can't fix the gallery.
    const summary = await rescreenshotScreens(deps);

    expect(summary.updated).toBe(1);
    expect(deps.htmlUploads).toHaveLength(1);
    expect(deps.htmlUploads[0].key).toMatch(
      /^showcase\/revision\/[0-9a-f-]+-[0-9a-f]{8}\.html$/,
    );
    expect(deps.htmlUploads[0].body).toContain("data-showcase-ua-reset");
    expect(deps.htmlRepoints).toEqual([
      { id: "id-1", htmlUrl: `https://s3.example/${deps.htmlUploads[0].key}` },
    ]);
    // The image is re-rendered from the SAME normalized markup that was stored.
    expect(deps.updates).toHaveLength(1);
  });

  it("leaves already-normalized HTML where it is", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 2024 }));

    await rescreenshotScreens(deps);

    expect(deps.htmlUploads).toEqual([]);
    expect(deps.htmlRepoints).toEqual([]);
  });

  it("passes --app straight through to the store's own filter", async () => {
    const deps = makeDeps([source()], () => ({ width: 750, height: 2024 }));

    await rescreenshotScreens(deps, { appOf: "screen-4" });

    // Narrowing must happen in SQL, not by fetching every row and filtering
    // in JS — the sweep re-renders each screen it lists.
    expect(deps.listArgs).toEqual([{ appOf: "screen-4" }]);
  });
});
