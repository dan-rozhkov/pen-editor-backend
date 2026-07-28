import { afterEach, describe, expect, it } from "vitest";
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
    likeApp: async () => null,
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

  it("defaults sort to popular and category to undefined", async () => {
    let received: { sort?: string; category?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { sort: opts.sort, category: opts.category };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({ method: "GET", url: "/api/showcase" });
    expect(received).toEqual({ sort: "popular", category: undefined });
  });

  it("passes sort=latest and category through to the store", async () => {
    let received: { sort?: string; category?: string } = {};
    const store = fakeStore({
      listApps: async (opts) => {
        received = { sort: opts.sort, category: opts.category };
        return { apps: [], nextCursor: null };
      },
    });
    const instance = await build(store);
    await instance.inject({
      method: "GET",
      url: "/api/showcase?sort=latest&category=fitness%20tracker",
    });
    expect(received).toEqual({ sort: "latest", category: "fitness tracker" });
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
