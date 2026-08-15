import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sharp from "sharp";
import {
  PUBLISH_STALE_MS,
  showcasePublishRoutes,
  type ShowcasePublishDeps,
} from "../src/routes/showcasePublish.js";
import { makeConfig } from "./helpers.js";
import type { ShowcaseStore } from "../src/showcase/store.js";

// Configured S3 so resolveS3Target(config) doesn't 503 — the real upload is
// always overridden via ShowcasePublishDeps.upload in these tests, so no
// network call ever happens.
const S3_CONFIG = makeConfig({
  S3_ENDPOINT: "https://s3.example.test",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  S3_PUBLIC_BASE_URL: "https://cdn.example.test",
});

const MOBILE_CSS = { width: 390, height: 844 };
const MOBILE_PX = { width: 780, height: 1688 };

// A realistic dashed-UUID client id — same shape `crypto.randomUUID()`
// produces in pen-editor/src/lib/userId.ts. Not tied to any real user; just
// needs to pass `isPlausibleUserId`.
const VALID_USER_ID = "8f14e45f-ceea-4b23-9e4a-1f7e3a2b9c0d";

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

async function pngDataUrl(width: number, height: number): Promise<string> {
  const buf = await pngBuffer(width, height);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function fakeStore(overrides: Partial<ShowcaseStore> = {}): ShowcaseStore {
  return {
    insertScreen: async () => {},
    listApps: async () => ({ apps: [], nextCursor: null }),
    recentThemes: async () => [],
    recentRunHtmlUrls: async () => [],
    listCategories: async () => [],
    listModels: async () => [],
    likeApp: async () => null,
    listScreenSources: async () => [],
    getScreenSource: async () => null,
    getAppScreens: async () => [],
    updateScreenHtmlUrl: async () => {},
    updateScreenDerivatives: async () => {},
    listScreenImages: async () => [],
    pinScreen: async () => true,
    clearPin: async () => {},
    deleteScreens: async () => [],
    close: async () => {},
    ...overrides,
  } as ShowcaseStore;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.restoreAllMocks();
});

async function build(
  store: ShowcaseStore | null,
  deps: ShowcasePublishDeps = {},
  config = S3_CONFIG,
) {
  app = Fastify();
  await showcasePublishRoutes(app, config, store, deps);
  await app.ready();
  return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    theme: "Habit tracker",
    prompt: "A minimal daily habit tracker.",
    userId: VALID_USER_ID,
    screens: [
      {
        name: "Onboarding",
        htmlContent: "<html><body><button>Go</button></body></html>",
        image: "", // filled per-test
        width: MOBILE_CSS.width,
        height: MOBILE_CSS.height,
      },
    ],
    ...overrides,
  };
}

describe("POST /api/showcase/publish", () => {
  it("publishes screens: 200, one insertScreen per screen, normalized HTML, WebP upload, cover pinned", async () => {
    const inserted: Array<{ id: string; runId: string; title: string }> = [];
    const uploaded: Array<{ key: string; contentType: string; body: Buffer }> = [];
    const pinned: string[] = [];

    const store = fakeStore({
      insertScreen: async (row) => {
        inserted.push({ id: row.id, runId: row.runId, title: row.title });
      },
      pinScreen: async (id) => {
        pinned.push(id);
        return true;
      },
    });

    const upload: ShowcasePublishDeps["upload"] = async (key, body, contentType) => {
      uploaded.push({ key, body, contentType });
      return `https://cdn.example.test/${key}`;
    };

    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(store, { upload });

    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [
          { name: "Onboarding", htmlContent: "<html><body><button>Go</button></body></html>", image, ...MOBILE_CSS },
          { name: "Today", htmlContent: "<html><body><input></body></html>", image, ...MOBILE_CSS },
        ],
        coverIndex: 2,
      }),
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.runId).toBeTypeOf("string");
    expect(body.platform).toBe("mobile");
    expect(body.screens).toEqual([
      { title: "Onboarding", imageUrl: expect.any(String) },
      { title: "Today", imageUrl: expect.any(String) },
    ]);

    expect(inserted).toHaveLength(2);
    expect(new Set(inserted.map((r) => r.runId)).size).toBe(1);

    // Cover pinned: the second screen's id was pinned.
    expect(pinned).toEqual([inserted[1].id]);

    // The stored HTML went through normalizeShowcaseHtml (UA-reset layer
    // injected) — publishScreens really ran, not a passthrough.
    const htmlUploads = uploaded.filter((u) => u.contentType.startsWith("text/html"));
    expect(htmlUploads).toHaveLength(2);
    for (const u of htmlUploads) {
      expect(u.body.toString("utf8")).toContain("data-showcase-ua-reset");
    }

    // The uploaded image is WebP (buildDerivatives re-encodes the PNG).
    const webpUploads = uploaded.filter((u) => u.contentType === "image/webp");
    expect(webpUploads.length).toBeGreaterThan(0);
    for (const u of webpUploads) {
      expect(u.body.subarray(8, 12).toString("latin1")).toBe("WEBP");
    }
  });

  it("returns 400 when the image is not a PNG", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [
          {
            name: "Onboarding",
            htmlContent: "<html></html>",
            image: jpeg.toString("base64"),
            ...MOBILE_CSS,
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a PNG/i);
  });

  it("returns 400 when the screen's CSS size doesn't match the platform viewport", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [
          { name: "Onboarding", htmlContent: "<html></html>", image, width: 400, height: 900 },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/CSS size/i);
  });

  it("returns 400 when the decoded PNG's pixel size doesn't match 2x the viewport", async () => {
    const image = await pngDataUrl(780, 1000);
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/780x1000/);
  });

  it("returns 400 when a screen's HTML exceeds the size cap", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const hugeHtml = "<div>" + "x".repeat(500_001) + "</div>";
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: hugeHtml, image, ...MOBILE_CSS }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/HTML is \d+ bytes/);
  });

  it("returns 400 when userId is missing", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore());
    const body = validBody({
      screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
    }) as Record<string, unknown>;
    delete body.userId;
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when userId is shape-invalid", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        userId: "test",
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/userId/i);
  });

  it("accepts the 32-char no-dash hex fallback userId form", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore(), {
      upload: async (key) => `https://cdn.example.test/${key}`,
    });
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        userId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 when coverIndex is out of range", async () => {
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
        coverIndex: 5,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/coverIndex/);
  });

  it("returns 503 when showcase storage is not configured", async () => {
    const instance = await build(null);
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({ screens: [] }),
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 503 when S3 is not configured", async () => {
    const instance = await build(fakeStore(), {}, makeConfig());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({ screens: [] }),
    });
    expect(res.statusCode).toBe(503);
  });

  it("returns 409 when a publish is already in flight, and clears the busy flag on success", async () => {
    const gate = deferred<void>();
    let uploadCalls = 0;
    const upload: ShowcasePublishDeps["upload"] = async (key) => {
      uploadCalls++;
      if (uploadCalls === 1) {
        await gate.promise;
      }
      return `https://cdn.example.test/${key}`;
    };
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore(), { upload });

    const firstReq = instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });

    // Give the first request a tick to reach the upload/gate.
    await new Promise((r) => setTimeout(r, 20));

    const secondRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(secondRes.statusCode).toBe(409);

    gate.resolve();
    const firstRes = await firstReq;
    expect(firstRes.statusCode).toBe(200);

    // Busy flag cleared after completion: a third request now succeeds.
    const thirdRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(thirdRes.statusCode).toBe(200);
  });

  it("clears the busy flag after a failure (publishScreens throwing), returns a generic 502 carrying the runId", async () => {
    const store = fakeStore({
      insertScreen: async () => {
        throw new Error("db is down: constraint showcase_screens_pkey violated");
      },
    });
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const upload: ShowcasePublishDeps["upload"] = async (key) => `https://cdn.example.test/${key}`;
    const instance = await build(store, { upload });

    const failRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(failRes.statusCode).toBe(502);
    const body = failRes.json();
    // The raw pg/AWS error text must never reach the caller (finding #5) —
    // only a generic message plus the runId an operator needs for
    // `npm run showcase:delete --app <runId>`.
    expect(body.error).not.toMatch(/db is down/);
    expect(body.error).not.toMatch(/constraint/);
    expect(body.runId).toBeTypeOf("string");
    expect(body.publishedCount).toBe(0);

    // Retry on the SAME instance (same route, same closed-over `busy` flag)
    // — proves the flag was actually cleared after the failure, not just
    // that a fresh instance works.
    store.insertScreen = async () => {};
    const okRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(okRes.statusCode).toBe(200);
  });

  it("returns 400 for malformed base64 image data", async () => {
    const instance = await build(fakeStore());
    const res = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [
          {
            name: "Onboarding",
            htmlContent: "<html></html>",
            image: "not-valid-base64!!!",
            ...MOBILE_CSS,
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/base64/i);
  });

  it("reclaims a stale busy flag after PUBLISH_STALE_MS instead of 409ing forever", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    let uploadCalls = 0;
    const gate = deferred<void>();
    const upload: ShowcasePublishDeps["upload"] = async (key) => {
      uploadCalls++;
      if (uploadCalls === 1) {
        // Simulates a hung PUT: never resolves within this test, so the
        // first request never reaches `finally` and never clears `busy`.
        await gate.promise;
      }
      return `https://cdn.example.test/${key}`;
    };
    const image = await pngDataUrl(MOBILE_PX.width, MOBILE_PX.height);
    const instance = await build(fakeStore(), { upload });

    const hungReq = instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));

    // Still within the window: busy, 409.
    const stillBusyRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(stillBusyRes.statusCode).toBe(409);

    // Advance the clock past the staleness window.
    now += PUBLISH_STALE_MS + 1;

    const reclaimedRes = await instance.inject({
      method: "POST",
      url: "/api/showcase/publish",
      payload: validBody({
        screens: [{ name: "Onboarding", htmlContent: "<html></html>", image, ...MOBILE_CSS }],
      }),
    });
    expect(reclaimedRes.statusCode).toBe(200);

    gate.resolve();
    await hungReq; // let the hung request settle in the background
    nowSpy.mockRestore();
  });
});
