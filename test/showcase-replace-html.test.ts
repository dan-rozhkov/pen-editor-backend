import { describe, expect, it } from "vitest";
import { replaceScreenHtml, type ReplaceHtmlDeps } from "../src/showcase/replaceHtml.js";
import type { ShowcaseScreenSource } from "../src/showcase/store.js";

function makeDeps(screen: ShowcaseScreenSource | null): ReplaceHtmlDeps & {
  uploads: Array<{ key: string; body: string }>;
  repoints: Array<{ id: string; htmlUrl: string }>;
} {
  const uploads: Array<{ key: string; body: string }> = [];
  const repoints: Array<{ id: string; htmlUrl: string }> = [];
  return {
    uploads,
    repoints,
    store: {
      getScreenSource: async (id) => (screen && screen.id === id ? screen : null),
      updateScreenHtmlUrl: async (id, htmlUrl) => {
        repoints.push({ id, htmlUrl });
      },
    },
    uploadHtml: async (key, body) => {
      uploads.push({ key, body: body.toString("utf8") });
      return `https://s3.example/${key}`;
    },
  };
}

const screen: ShowcaseScreenSource = {
  id: "screen-1",
  title: "04 · Active Workout",
  htmlUrl: "https://s3.example/showcase/run-1/4.html",
  width: 750,
  height: 1624,
};

describe("replaceScreenHtml", () => {
  it("uploads the new markup and repoints the row at it", async () => {
    const deps = makeDeps(screen);

    const result = await replaceScreenHtml(deps, {
      id: "screen-1",
      html: "<html>fixed</html>",
    });

    expect(deps.uploads).toHaveLength(1);
    expect(deps.uploads[0].body).toBe("<html>fixed</html>");
    expect(deps.repoints).toEqual([{ id: "screen-1", htmlUrl: result.htmlUrl }]);
    expect(result.htmlUrl).toBe(`https://s3.example/${deps.uploads[0].key}`);
    expect(result.previousHtmlUrl).toBe("https://s3.example/showcase/run-1/4.html");
  });

  it("writes to a fresh key instead of overwriting the old one", async () => {
    // Showcase objects are served `immutable` for a year, so an in-place
    // overwrite would leave caches — and rescreenshot's own fetch — reading
    // the broken markup.
    const deps = makeDeps(screen);

    const result = await replaceScreenHtml(deps, { id: "screen-1", html: "<html/>" });

    expect(deps.uploads[0].key).not.toBe("showcase/run-1/4.html");
    expect(deps.uploads[0].key).toMatch(/^showcase\/revision\/[0-9a-f-]{36}-[0-9a-f]{8}\.html$/);
    expect(result.htmlUrl).not.toBe(result.previousHtmlUrl);
  });

  it("fails loudly on an unknown screen id, touching nothing", async () => {
    const deps = makeDeps(screen);

    await expect(
      replaceScreenHtml(deps, { id: "nope", html: "<html/>" }),
    ).rejects.toThrow(/no showcase screen with id nope/);
    expect(deps.uploads).toEqual([]);
    expect(deps.repoints).toEqual([]);
  });
});
