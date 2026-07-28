import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { reencodeScreens, type ReencodeDeps } from "../src/showcase/reencode.js";
import type { ShowcaseImageSource, ShowcaseDerivativesUpdate } from "../src/showcase/store.js";

async function fakePng(): Promise<Buffer> {
  return sharp({
    create: { width: 20, height: 40, channels: 3, background: { r: 5, g: 6, b: 7 } },
  })
    .png()
    .toBuffer();
}

function source(over: Partial<ShowcaseImageSource> = {}): ShowcaseImageSource {
  return {
    id: "id-1",
    title: "Home",
    imageUrl: "https://s3.example/showcase/run/1.png",
    imageUrl1x: undefined,
    ...over,
  };
}

function makeDeps(screens: ShowcaseImageSource[]): ReencodeDeps & {
  updates: ShowcaseDerivativesUpdate[];
  uploads: string[];
} {
  const updates: ShowcaseDerivativesUpdate[] = [];
  const uploads: string[] = [];
  return {
    updates,
    uploads,
    store: {
      listScreenImages: async () => screens,
      updateScreenDerivatives: async (update) => {
        updates.push(update);
      },
    },
    fetchPng: async () => fakePng(),
    uploadWebp: async (key) => {
      uploads.push(key);
      return `https://s3.example/${key}`;
    },
  };
}

describe("reencodeScreens", () => {
  it("backfills a row that has no image_url_1x yet", async () => {
    const deps = makeDeps([source()]);

    const summary = await reencodeScreens(deps);

    expect(summary).toEqual({ total: 1, updated: 1, skipped: 0, failed: 0 });
    expect(deps.updates).toHaveLength(1);
    expect(deps.updates[0].id).toBe("id-1");
    expect(deps.updates[0].imageUrl).toMatch(/^https:\/\/s3\.example\/showcase\/reencode\//);
    expect(deps.updates[0].imageUrl1x).toMatch(/@1x\.webp$/);
    expect(deps.updates[0].lqip).toMatch(/^data:image\/webp;base64,/);
    expect(deps.updates[0].width).toBeGreaterThan(0);
    expect(deps.updates[0].height).toBeGreaterThan(0);
    expect(deps.uploads).toHaveLength(2);
  });

  it("skips a row that already has image_url_1x", async () => {
    const deps = makeDeps([
      source({ imageUrl1x: "https://s3.example/showcase/run/1@1x.webp" }),
    ]);

    const summary = await reencodeScreens(deps);

    expect(summary).toEqual({ total: 1, updated: 0, skipped: 1, failed: 0 });
    expect(deps.updates).toEqual([]);
    expect(deps.uploads).toEqual([]);
  });

  it("reprocesses an already-backfilled row under --force", async () => {
    const deps = makeDeps([
      source({ imageUrl1x: "https://s3.example/showcase/run/1@1x.webp" }),
    ]);

    const summary = await reencodeScreens(deps, { force: true });

    expect(summary).toEqual({ total: 1, updated: 1, skipped: 0, failed: 0 });
    expect(deps.updates).toHaveLength(1);
  });

  it("touches neither S3 nor the store on a dry run", async () => {
    const deps = makeDeps([source()]);

    const summary = await reencodeScreens(deps, { dryRun: true });

    expect(summary.updated).toBe(1);
    expect(deps.uploads).toEqual([]);
    expect(deps.updates).toEqual([]);
  });

  it("keeps going when one screen fails", async () => {
    const deps = makeDeps([
      source({ id: "bad", imageUrl: "https://s3.example/missing.png" }),
      source({ id: "good" }),
    ]);
    deps.fetchPng = async (url: string) => {
      if (url.endsWith("missing.png")) throw new Error("GET 404");
      return fakePng();
    };

    const summary = await reencodeScreens(deps);

    expect(summary).toEqual({ total: 2, updated: 1, skipped: 0, failed: 1 });
    expect(deps.updates.map((u) => u.id)).toEqual(["good"]);
  });

  it("honours --limit", async () => {
    const deps = makeDeps([
      source({ id: "a" }),
      source({ id: "b" }),
      source({ id: "c" }),
    ]);

    const summary = await reencodeScreens(deps, { limit: 2 });

    expect(summary.total).toBe(2);
    expect(deps.updates.map((u) => u.id)).toEqual(["a", "b"]);
  });

  it("skips a row whose image_url is already WebP, even under --force", async () => {
    const deps = makeDeps([
      source({
        id: "already-webp",
        imageUrl: "https://s3.example/showcase/run/1-abcd1234.webp",
        imageUrl1x: "https://s3.example/showcase/run/1-abcd1234@1x.webp",
      }),
    ]);
    let fetchCalled = false;
    deps.fetchPng = async () => {
      fetchCalled = true;
      return fakePng();
    };

    const summary = await reencodeScreens(deps, { force: true });

    expect(summary).toEqual({ total: 1, updated: 0, skipped: 1, failed: 0 });
    expect(deps.updates).toEqual([]);
    expect(deps.uploads).toEqual([]);
    // Never even fetched — re-encoding a WebP into another WebP is a
    // generational quality loss, so --force must not reach it.
    expect(fetchCalled).toBe(false);
  });

  it("skips a WebP row that has no image_url_1x yet (not just already-backfilled ones)", async () => {
    // Shouldn't happen in practice (a WebP row is only ever produced already
    // carrying image_url_1x), but the PNG-only guard must not depend on that
    // — it keys off the imageUrl extension alone.
    const deps = makeDeps([
      source({
        id: "weird-webp",
        imageUrl: "https://s3.example/showcase/run/1-abcd1234.webp",
        imageUrl1x: undefined,
      }),
    ]);

    const summary = await reencodeScreens(deps);

    expect(summary).toEqual({ total: 1, updated: 0, skipped: 1, failed: 0 });
    expect(deps.updates).toEqual([]);
  });
});
