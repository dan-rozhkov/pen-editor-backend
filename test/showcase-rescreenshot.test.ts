import { describe, expect, it } from "vitest";
import {
  rescreenshotScreens,
  type RescreenshotDeps,
} from "../src/showcase/rescreenshot.js";
import type { ShowcaseScreenSource } from "../src/showcase/store.js";

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

function makeDeps(
  screens: ShowcaseScreenSource[],
  render: (html: string) => { width: number; height: number },
): RescreenshotDeps & {
  updates: Array<{ id: string; imageUrl: string; width: number; height: number }>;
  uploads: string[];
} {
  const updates: Array<{ id: string; imageUrl: string; width: number; height: number }> = [];
  const uploads: string[] = [];
  return {
    updates,
    uploads,
    store: {
      listScreenSources: async () => screens,
      updateScreenImage: async (update) => {
        updates.push(update);
      },
    },
    fetchHtml: async (url) => `<html data-src="${url}">`,
    screenshot: async (html) => ({ buffer: Buffer.from("png"), ...render(html) }),
    uploadPng: async (key) => {
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
    expect(deps.updates).toEqual([
      { id: "id-1", imageUrl: expect.stringContaining("showcase/rerender/"), width: 750, height: 2024 },
    ]);
    // A fresh key, never the URL already in the gallery — the old PNG may be
    // cached under it.
    expect(deps.uploads[0]).not.toContain("1.png");
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
