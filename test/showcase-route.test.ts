import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { ShowcaseApp, ShowcaseScreen, ShowcaseStore } from "../src/showcase/store.js";

const SCREEN: ShowcaseScreen = {
  id: "11111111-1111-1111-1111-111111111111",
  runId: "22222222-2222-2222-2222-222222222222",
  theme: "fitness",
  title: "Workout tracker",
  prompt: "a fitness app onboarding screen",
  model: "google/gemini-2.5-flash",
  imageUrl: "https://cdn.example.test/showcase/1-abcd1234.webp",
  imageUrl1x: "https://cdn.example.test/showcase/1-abcd1234@1x.webp",
  lqip: "data:image/webp;base64,AAAA",
  htmlUrl: "https://cdn.example.test/showcase/1.html",
  width: 390,
  height: 844,
  createdAt: "2026-07-27T10:00:00.000Z",
};

const APP: ShowcaseApp = {
  runId: SCREEN.runId,
  theme: SCREEN.theme,
  model: SCREEN.model,
  platform: "mobile",
  createdAt: SCREEN.createdAt,
  likes: 4,
  screens: [SCREEN],
};

function fakeStore(overrides: Partial<ShowcaseStore> = {}): ShowcaseStore {
  return {
    insertScreen: async () => {},
    listApps: async () => ({ apps: [APP], nextCursor: null }),
    recentThemes: async () => [],
    listCategories: async () => [],
    listModels: async () => [],
    likeApp: async () => null,
    getAppScreens: async () => [],
    close: async () => {},
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function build(showcaseStore: ShowcaseStore | null) {
  app = await buildApp(makeConfig(), { logger: false, showcaseStore });
  return app;
}

describe("GET /api/showcase", () => {
  it("returns 200 with apps and nextCursor, omitting prompt and pin state", async () => {
    const nextCursor = "abc123";
    const store = fakeStore({
      listApps: async () => ({ apps: [APP], nextCursor }),
    });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBe(nextCursor);
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]).toEqual({
      runId: APP.runId,
      theme: APP.theme,
      model: APP.model,
      platform: APP.platform,
      createdAt: APP.createdAt,
      likes: APP.likes,
      screens: [
        {
          id: SCREEN.id,
          title: SCREEN.title,
          imageUrl: SCREEN.imageUrl,
          imageUrl1x: SCREEN.imageUrl1x,
          lqip: SCREEN.lqip,
          htmlUrl: SCREEN.htmlUrl,
          width: SCREEN.width,
          height: SCREEN.height,
          createdAt: SCREEN.createdAt,
        },
      ],
    });
    // The full generation prompt and pin state stay server-side; the cover
    // being first in `screens` is the whole pin contract.
    expect(body.apps[0].screens[0].prompt).toBeUndefined();
    expect(body.apps[0].screens[0].pinned).toBeUndefined();
    // The flat screen list the masonry-era client grouped itself is gone.
    expect(body.screens).toBeUndefined();
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: "Showcase storage is not configured",
    });
  });

  it("returns 400 for limit=0", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?limit=0",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a limit over the 24-app ceiling", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?limit=999",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an undecodable cursor", async () => {
    const store = fakeStore({
      listApps: async () => {
        throw Object.assign(new Error("Invalid cursor"), { statusCode: 400 });
      },
    });
    const instance = await build(store);
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?cursor=not-a-valid-cursor",
    });
    expect(res.statusCode).toBe(400);
  });

  it("defaults limit to 12 apps when omitted", async () => {
    let receivedLimit: number | undefined;
    const store = fakeStore({
      listApps: async (opts) => {
        receivedLimit = opts.limit;
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(receivedLimit).toBe(12);
  });

  it("defaults sort to popular, category to undefined, and platform to mobile", async () => {
    let received: { sort?: string; category?: string; platform?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { sort: opts.sort, category: opts.category, platform: opts.platform };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(received).toEqual({ sort: "popular", category: undefined, platform: "mobile" });
  });

  it("passes sort=latest and category through to the store", async () => {
    let received: { sort?: string; category?: string; platform?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { sort: opts.sort, category: opts.category, platform: opts.platform };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({
      method: "GET",
      url: "/api/showcase?sort=latest&category=fitness%20tracker",
    });
    expect(received).toEqual({
      sort: "latest",
      category: "fitness tracker",
      platform: "mobile",
    });
  });

  it("passes platform=desktop through to the store", async () => {
    let received: { platform?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { platform: opts.platform };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase?platform=desktop" });
    expect(received).toEqual({ platform: "desktop" });
  });

  it("defaults model to undefined", async () => {
    let received: { model?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { model: opts.model };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(received).toEqual({ model: undefined });
  });

  it("passes model through to the store", async () => {
    let received: { model?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { model: opts.model };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({
      method: "GET",
      url: "/api/showcase?model=deepseek%2Fdeepseek-v4-pro",
    });
    expect(received).toEqual({ model: "deepseek/deepseek-v4-pro" });
  });

  it("returns 400 for an empty model", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?model=",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an invalid platform value", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?platform=tablet",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an invalid sort value", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?sort=trending",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an empty category", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase?category=",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/showcase/categories", () => {
  it("returns categories from the store", async () => {
    const store = fakeStore({
      listCategories: async () => [
        { theme: "fitness", apps: 3 },
        { theme: "finance", apps: 1 },
      ],
    });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: "/api/showcase/categories" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      categories: [
        { theme: "fitness", apps: 3 },
        { theme: "finance", apps: 1 },
      ],
    });
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({ method: "GET", url: "/api/showcase/categories" });
    expect(res.statusCode).toBe(503);
  });

  it("defaults platform to mobile and passes it to the store", async () => {
    let received: string | undefined;
    const store = fakeStore({
      listCategories: async (platform) => {
        received = platform;
        return [];
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase/categories" });
    expect(received).toBe("mobile");
  });

  it("passes platform=desktop through to the store", async () => {
    let received: string | undefined;
    const store = fakeStore({
      listCategories: async (platform) => {
        received = platform;
        return [];
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase/categories?platform=desktop" });
    expect(received).toBe("desktop");
  });

  it("returns 400 for an invalid platform value", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase/categories?platform=tablet",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/showcase/models", () => {
  it("returns models from the store", async () => {
    const store = fakeStore({
      listModels: async () => [
        { model: "deepseek/deepseek-v4-pro", apps: 3 },
        { model: "google/gemini-2.5-flash", apps: 1 },
      ],
    });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: "/api/showcase/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      models: [
        { model: "deepseek/deepseek-v4-pro", apps: 3 },
        { model: "google/gemini-2.5-flash", apps: 1 },
      ],
    });
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({ method: "GET", url: "/api/showcase/models" });
    expect(res.statusCode).toBe(503);
  });

  it("defaults platform to mobile and passes it to the store", async () => {
    let received: string | undefined;
    const store = fakeStore({
      listModels: async (platform) => {
        received = platform;
        return [];
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase/models" });
    expect(received).toBe("mobile");
  });

  it("passes platform=desktop through to the store", async () => {
    let received: string | undefined;
    const store = fakeStore({
      listModels: async (platform) => {
        received = platform;
        return [];
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase/models?platform=desktop" });
    expect(received).toBe("desktop");
  });

  it("returns 400 for an invalid platform value", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "GET",
      url: "/api/showcase/models?platform=tablet",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/showcase/:runId/html", () => {
  const runId = APP.runId;
  // Stored dimensions describe the 2x WebP, not the document's CSS box: a
  // mobile screen is 780px wide there, and its height is the *full-page*
  // height, so it overshoots 2x844 whenever the content scrolls.
  const SOURCE = {
    id: SCREEN.id,
    title: SCREEN.title,
    htmlUrl: SCREEN.htmlUrl,
    width: 780,
    height: 1900,
    platform: "mobile" as const,
  };
  const SOURCE_2 = {
    ...SOURCE,
    id: "33333333-3333-3333-3333-333333333333",
    title: "Second screen",
    htmlUrl: "https://cdn.example.test/showcase/2.html",
  };

  function okResponse(url: string) {
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => `<html data-url="${url}"></html>`,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches each screen's HTML server-side (with a timeout signal) and returns it inline", async () => {
    const fetchMock = vi.fn(async (url: string) => okResponse(url));
    vi.stubGlobal("fetch", fetchMock);

    const store = fakeStore({ getAppScreens: async () => [SOURCE] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(SOURCE.htmlUrl);
    // #1: every server-side fetch of an S3 object carries an abort signal —
    // no timeout meant a single stuck object could hang this request (and,
    // with the old `Promise.all`, the whole app) forever.
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    expect(res.json()).toEqual({
      screens: [
        {
          id: SOURCE.id,
          title: SOURCE.title,
          // CSS pixels, not the stored 2x image's: the editor lays the HTML
          // out in this box, so handing it 780x1900 rendered a mobile design
          // at tablet width — visibly out of proportion.
          width: 390,
          height: 950,
          htmlContent: `<html data-url="${SOURCE.htmlUrl}"></html>`,
        },
      ],
    });
  });

  it("returns a desktop screen in its own authoring viewport width", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => okResponse(url)));
    const store = fakeStore({
      getAppScreens: async () => [
        { ...SOURCE, width: 2880, height: 2048, platform: "desktop" as const },
      ],
    });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    expect(res.json().screens[0]).toMatchObject({ width: 1440, height: 1024 });
  });

  it("falls back to the platform viewport when the stored dimensions are unusable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => okResponse(url)));
    const store = fakeStore({
      getAppScreens: async () => [{ ...SOURCE, width: 0, height: 0 }],
    });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    expect(res.json().screens[0]).toMatchObject({ width: 390, height: 844 });
  });

  it("sets a long-lived Cache-Control on a successful response, matching the S3 objects' own immutable caching", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => okResponse(url)));
    const store = fakeStore({ getAppScreens: async () => [SOURCE] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("returns 404 when the app has no published screens", async () => {
    const store = fakeStore({ getAppScreens: async () => [] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a runId that isn't a UUID", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({ method: "GET", url: `/api/showcase/not-a-uuid/html` });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });
    expect(res.statusCode).toBe(503);
  });

  it("returns 502 when fetching THE ONLY screen's HTML fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" })),
    );
    const store = fakeStore({ getAppScreens: async () => [SOURCE] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });
    expect(res.statusCode).toBe(502);
  });

  // #3: a Promise.all made this all-or-nothing — one broken screen 502'd the
  // whole app forever. Now a broken screen is skipped (and logged) as long as
  // at least one other screen of the app came back successfully.
  it("skips a broken screen and still returns 200 with the rest, when at least one screen succeeds", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === SOURCE.htmlUrl) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => "" };
      }
      return okResponse(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = fakeStore({ getAppScreens: async () => [SOURCE, SOURCE_2] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.screens).toHaveLength(1);
    expect(body.screens[0].id).toBe(SOURCE_2.id);
  });

  it("logs the failure (not silently) when a screen's HTML fails to fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" })),
    );
    const store = fakeStore({ getAppScreens: async () => [SOURCE] });
    const instance = await build(store);
    const logSpy = vi.spyOn(instance.log, "error");
    await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(logSpy).toHaveBeenCalled();
    const [loggedArg] = logSpy.mock.calls[0];
    expect(JSON.stringify(loggedArg)).toContain(SOURCE.htmlUrl);
  });

  it("skips a screen whose HTML exceeds the size cap via Content-Length, without hanging or crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        headers: { get: (name: string) => (name === "content-length" ? String(10 * 1024 * 1024) : null) },
        text: async () => `<html data-url="${url}"></html>`,
      })),
    );
    const store = fakeStore({ getAppScreens: async () => [SOURCE] });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });
    // The only screen was oversized, so nothing came back.
    expect(res.statusCode).toBe(502);
  });

  it("limits fetch concurrency rather than firing every screen's request at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const manySources = Array.from({ length: 8 }, (_, i) => ({
      ...SOURCE,
      id: `44444444-4444-4444-4444-44444444444${i}`,
      htmlUrl: `https://cdn.example.test/showcase/${i}.html`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return okResponse(url);
      }),
    );

    const store = fakeStore({ getAppScreens: async () => manySources });
    const instance = await build(store);
    const res = await instance.inject({ method: "GET", url: `/api/showcase/${runId}/html` });

    expect(res.statusCode).toBe(200);
    expect(res.json().screens).toHaveLength(8);
    // The bound isn't load-bearing at any particular number, just that it's
    // capped well below firing all 8 at once.
    expect(maxInFlight).toBeLessThan(8);
  });
});

describe("GET /api/image-proxy", () => {
  const config = makeConfig({
    S3_ENDPOINT: "https://s3.timeweb.cloud",
    S3_BUCKET: "bucket",
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a configured pen-editor image with immutable caching", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn(async () =>
      new Response(bytes, { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = await buildApp(config, {
      logger: false,
      showcaseStore: fakeStore(),
    });
    // Older published objects use .com while the current SDK endpoint is
    // configured as .cloud; both names address the same Timeweb bucket.
    const source = "https://s3.timeweb.com/bucket/pen-editor/photo.png";
    const res = await instance.inject({
      method: "GET",
      url: `/api/image-proxy?url=${encodeURIComponent(source)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(source),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await instance.close();
  });

  it("rejects URLs outside the configured bucket prefix without fetching them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = await buildApp(config, {
      logger: false,
      showcaseStore: fakeStore(),
    });
    const res = await instance.inject({
      method: "GET",
      url: `/api/image-proxy?url=${encodeURIComponent("https://attacker.test/image.png")}`,
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.close();
  });

  // After a provider migration the bucket we upload to changes, but every
  // already-published screen's HTML still points at the old one. Without the
  // legacy list those screens lose their images the moment S3_ENDPOINT moves.
  describe("after a provider migration", () => {
    const migrated = makeConfig({
      S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
      S3_BUCKET: "pen-editor",
      S3_PUBLIC_BASE_URL: "https://pub-abc.r2.dev",
      S3_LEGACY_PUBLIC_BASE_URLS:
        " https://s3.timeweb.com/old-bucket/ , not a url ",
    });

    it.each([
      ["the new public base", "https://pub-abc.r2.dev/pen-editor/photo.png"],
      ["a legacy base", "https://s3.timeweb.com/old-bucket/pen-editor/photo.png"],
    ])("proxies %s", async (_label, source) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(new Uint8Array([0x89, 0x50]), {
            headers: { "content-type": "image/png" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const instance = await buildApp(migrated, {
        logger: false,
        showcaseStore: fakeStore(),
      });
      const res = await instance.inject({
        method: "GET",
        url: `/api/image-proxy?url=${encodeURIComponent(source)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL(source),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await instance.close();
    });

    it("does not widen the allowlist to another bucket or key prefix", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const instance = await buildApp(migrated, {
        logger: false,
        showcaseStore: fakeStore(),
      });
      for (const source of [
        "https://s3.timeweb.com/other-bucket/pen-editor/photo.png",
        "https://s3.timeweb.com/old-bucket/generated/photo.png",
        "https://pub-abc.r2.dev/showcase/photo.png",
      ]) {
        const res = await instance.inject({
          method: "GET",
          url: `/api/image-proxy?url=${encodeURIComponent(source)}`,
        });
        expect(res.statusCode).toBe(403);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      await instance.close();
    });
  });
});

describe("POST /api/showcase/:runId/like", () => {
  const runId = APP.runId;

  it("increments and returns the new total", async () => {
    const store = fakeStore({
      likeApp: async (id, count) => {
        expect(id).toBe(runId);
        expect(count).toBe(3);
        return 7;
      },
    });
    const instance = await build(store);
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ likes: 7 });
  });

  it("returns 404 when the store reports no such app", async () => {
    const store = fakeStore({ likeApp: async () => null });
    const instance = await build(store);
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for a runId that isn't a UUID", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/not-a-uuid/like`,
      payload: { count: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for count=0 (below the 1..25 bound)", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for count=26 (above the 1..25 bound)", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 26 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts count=25 (the upper bound)", async () => {
    const store = fakeStore({ likeApp: async () => 25 });
    const instance = await build(store);
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 25 },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 for a non-integer count", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({
      method: "POST",
      url: `/api/showcase/${runId}/like`,
      payload: { count: 1 },
    });
    expect(res.statusCode).toBe(503);
  });
});
