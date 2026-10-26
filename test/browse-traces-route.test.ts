import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDailyCap } from "../src/routes/browseTraces.js";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { Config } from "../src/config.js";

// S3 IO is mocked (see upload-route.test.ts): the route's own logic —
// validation, key layout, write order, URL rewriting — runs for real.
const putCalls: { key: string; body: Buffer; contentType: string; contentDisposition?: string }[] = [];
const stored = new Map<string, string>();
const deleted: string[][] = [];
let failKey: ((key: string) => boolean) | null = null;
const getObjectTextMock = vi.fn(async (_target: unknown, key: string) => stored.get(key) ?? null);

vi.mock("../src/services/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/s3.js")>();
  const { fakeS3Target } = await import("./s3Mocks.js");
  return {
    ...actual,
    resolveS3Target: vi.fn((config: Config) => fakeS3Target(config)),
    uploadObject: async (
      target: { publicBase: string },
      key: string,
      body: Buffer,
      contentType: string,
      extra?: { contentDisposition?: string },
    ) => {
      if (failKey?.(key)) throw new Error("boom");
      putCalls.push({ key, body, contentType, contentDisposition: extra?.contentDisposition });
      return `${target.publicBase}/${key}`;
    },
    deleteObjects: async (_t: unknown, keys: string[]) => {
      deleted.push(keys);
    },
    getObjectText: (...args: [unknown, string]) => getObjectTextMock(...args),
  };
});

const S3_CONFIG: Partial<Config> = {
  S3_ENDPOINT: "https://s3.example.test",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
};
const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngUri = (buf: Buffer = PNG) => `data:image/png;base64,${buf.toString("base64")}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const domUri = (type: string, text = "<html></html>", params = "") =>
  `data:${type}${params};base64,${Buffer.from(text).toString("base64")}`;

function manifest(frameSrcs: string[] = ["frames/0.png"], domSrcs: string[] = []) {
  return {
    format: "sideform.browse-trace",
    version: 1,
    id: "client-id",
    goal: "g",
    startedAt: 1,
    endedAt: 2,
    status: "completed",
    steps: [],
    frames: frameSrcs.map((src, id) => ({ id, at: 1, kind: "step", src })),
    console: [],
    network: [],
    ...(domSrcs.length
      ? {
          doms: domSrcs.map((src, id) => ({
            id,
            at: 1,
            stepIndex: 0,
            kind: src.endsWith(".txt") ? "ax" : "html",
            src,
            bytes: 10,
          })),
        }
      : {}),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  putCalls.length = 0;
  deleted.length = 0;
  failKey = null;
  stored.clear();
  getObjectTextMock.mockClear();
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function startServer(config: Config): Promise<string> {
  app = await buildApp(config, { logger: false });
  return app.listen({ port: 0, host: "127.0.0.1" });
}

function post(base: string, body: Record<string, unknown>) {
  return fetch(`${base}/api/browse/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: USER_ID, ...body }),
  });
}

async function expect400(res: Response, text: string) {
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain(text);
  expect(putCalls).toHaveLength(0);
}

describe("POST /api/browse/traces", () => {
  it("stores assets first, then trace.json with server id, public URLs and owner", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, {
      manifest: { ...manifest(["frames/0.png", "frames/1.png"]), owner: "attacker" },
      assets: [
        { path: "frames/0.png", dataUrl: pngUri() },
        { path: "frames/1.png", dataUrl: pngUri() },
      ],
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(UUID_RE);

    const keys = putCalls.map((c) => c.key);
    expect(keys.slice(0, 2).sort()).toEqual([`browse-traces/${id}/frames/0.png`, `browse-traces/${id}/frames/1.png`]);
    expect(keys[2]).toBe(`browse-traces/${id}/trace.json`);
    expect(putCalls[0]?.contentType).toBe("image/png");
    expect(putCalls[2]?.contentType).toBe("application/json");

    const trace = JSON.parse(putCalls[2]!.body.toString("utf8"));
    expect(trace.id).toBe(id);
    expect(trace).not.toHaveProperty("owner");
    expect(trace.ownerHash).toBe(createHash("sha256").update(USER_ID).digest("hex"));
    expect(JSON.stringify(trace)).not.toContain(USER_ID);
    expect(trace.frames.map((f: { src: string }) => f.src)).toEqual([
      `https://s3.example.test/bucket/browse-traces/${id}/frames/0.png`,
      `https://s3.example.test/bucket/browse-traces/${id}/frames/1.png`,
    ]);
  });

  it("returns 503 without an S3 target", async () => {
    const base = await startServer(makeConfig());
    const res = await post(base, { manifest: manifest(), assets: [] });
    expect(res.status).toBe(503);
    expect(putCalls).toHaveLength(0);
  });

  it("returns 400 without a plausible userId", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, { userId: "x", manifest: manifest([]), assets: [] });
    expect(res.status).toBe(400);
    expect(putCalls).toHaveLength(0);
  });

  it("returns 400 for a bad manifest", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(await post(base, { manifest: { format: "nope" }, assets: [] }), "format");
    await expect400(await post(base, { assets: [] }), "trace");
  });

  it("returns 400 for a frame src that is not an asset path", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, { manifest: manifest(["https://evil.test/x.png"]), assets: [] });
    await expect400(res, "asset path");
  });

  it("returns 400 for a bad asset path", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, {
      manifest: manifest(["frames/0.png"]),
      assets: [{ path: "../frames/0.png", dataUrl: pngUri() }],
    });
    await expect400(res, "invalid path");
  });

  it("returns 400 for an unreferenced asset", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, {
      manifest: manifest(["frames/0.png"]),
      assets: [
        { path: "frames/0.png", dataUrl: pngUri() },
        { path: "frames/7.png", dataUrl: pngUri() },
      ],
    });
    await expect400(res, "not referenced");
  });

  it("returns 400 for a missing asset and a duplicate asset", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(await post(base, { manifest: manifest(["frames/0.png"]), assets: [] }), "missing");
    const dup = { path: "frames/0.png", dataUrl: pngUri() };
    await expect400(await post(base, { manifest: manifest(["frames/0.png"]), assets: [dup, dup] }), "duplicate");
  });

  it("returns 400 for more than 160 assets", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const paths = Array.from({ length: 161 }, (_, i) => `frames/${i}.png`);
    const res = await post(base, {
      manifest: manifest(paths),
      assets: paths.map((path) => ({ path, dataUrl: pngUri() })),
    });
    await expect400(res, "at most 160");
  });

  it("returns 400 for bytes that are not an image, or not a data URI", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const notImage = pngUri(Buffer.from("hello"));
    await expect400(
      await post(base, { manifest: manifest(), assets: [{ path: "frames/0.png", dataUrl: notImage }] }),
      "not a supported image",
    );
    await expect400(
      await post(base, { manifest: manifest(), assets: [{ path: "frames/0.png", dataUrl: "nope" }] }),
      "invalid data URI",
    );
  });

  it("returns 400 for an asset over 3 MB", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const big = Buffer.alloc(3 * 1024 * 1024 + 1);
    PNG.copy(big);
    const res = await post(base, {
      manifest: manifest(),
      assets: [{ path: "frames/0.png", dataUrl: pngUri(big) }],
    });
    await expect400(res, "larger than");
  });
});

describe("POST /api/browse/traces DOM assets", () => {
  const withDoms = (dom: unknown[], extra: Record<string, unknown>[] = []) => ({
    manifest: manifest(["frames/0.png"], ["dom/0.html", "dom/1.txt"].slice(0, dom.length)),
    assets: [{ path: "frames/0.png", dataUrl: pngUri() }, ...extra],
  });

  it("stores html and txt DOM assets with content types and attachment disposition, and rewrites doms src", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(
      base,
      withDoms(
        [1, 2],
        [
          { path: "dom/0.html", dataUrl: domUri("text/html", "<p>hi</p>", ";charset=utf-8") },
          { path: "dom/1.txt", dataUrl: domUri("text/plain", "button \"Go\"") },
        ],
      ),
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const html = putCalls.find((c) => c.key.endsWith("dom/0.html"))!;
    const txt = putCalls.find((c) => c.key.endsWith("dom/1.txt"))!;
    expect(html.contentType).toBe("text/plain; charset=utf-8");
    expect(html.contentDisposition).toBe("attachment");
    expect(html.body.toString("utf8")).toBe("<p>hi</p>");
    expect(txt.contentType).toBe("text/plain; charset=utf-8");
    expect(txt.contentDisposition).toBe("attachment");
    const png = putCalls.find((c) => c.key.endsWith("frames/0.png"))!;
    expect(png.contentDisposition).toBeUndefined();
    const last = putCalls.at(-1)!;
    expect(last.key).toBe(`browse-traces/${id}/trace.json`);
    const trace = JSON.parse(last.body.toString("utf8"));
    expect(trace.doms.map((d: { src: string }) => d.src)).toEqual([
      `https://s3.example.test/bucket/browse-traces/${id}/dom/0.html`,
      `https://s3.example.test/bucket/browse-traces/${id}/dom/1.txt`,
    ]);
    expect(trace).not.toHaveProperty("owner");
  });

  it("returns 400 when the data URL type does not match the extension", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(
      await post(base, withDoms([1], [{ path: "dom/0.html", dataUrl: domUri("text/plain") }])),
      "does not match",
    );
    await expect400(
      await post(base, withDoms([1], [{ path: "dom/0.html", dataUrl: pngUri() }])),
      "invalid data URI",
    );
  });

  it("returns 400 for bad base64", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(
      await post(base, withDoms([1], [{ path: "dom/0.html", dataUrl: "data:text/html;base64,abc" }])),
      "invalid data URI",
    );
  });

  it("returns 400 for a DOM asset over 2 MB", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const big = domUri("text/html", "x".repeat(2 * 1024 * 1024 + 3));
    await expect400(await post(base, withDoms([1], [{ path: "dom/0.html", dataUrl: big }])), "larger than");
  });

  it("accepts a DOM asset of exactly 2 MB", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const ok = domUri("text/html", "x".repeat(2 * 1024 * 1024));
    const res = await post(base, withDoms([1], [{ path: "dom/0.html", dataUrl: ok }]));
    expect(res.status).toBe(200);
  });

  it("returns 400 when a doms src is not uploaded, or is not an asset path", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(await post(base, withDoms([1])), "dom/0.html is missing");
    const m = manifest(["frames/0.png"], ["https://evil.test/x.html"]);
    await expect400(
      await post(base, { manifest: m, assets: [{ path: "frames/0.png", dataUrl: pngUri() }] }),
      "asset path",
    );
  });

  it("returns 400 for a DOM asset no dom references", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await expect400(
      await post(base, {
        manifest: manifest(),
        assets: [
          { path: "frames/0.png", dataUrl: pngUri() },
          { path: "dom/0.html", dataUrl: domUri("text/html") },
        ],
      }),
      "not referenced",
    );
  });
});

describe("POST /api/browse/traces hardening", () => {
  const body = (n = 1) => ({
    manifest: manifest(Array.from({ length: n }, (_, i) => `frames/${i}.png`)),
    assets: Array.from({ length: n }, (_, i) => ({ path: `frames/${i}.png`, dataUrl: pngUri() })),
  });

  it("returns 400 when the image type does not match the path extension", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, { manifest: manifest(["frames/0.jpg"]), assets: [{ path: "frames/0.jpg", dataUrl: pngUri() }] });
    await expect400(res, "does not match");
  });

  it("returns 413 for a manifest over 4 MB, before uploading", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const m = { ...body().manifest, answer: "x".repeat(4 * 1024 * 1024) };
    const res = await post(base, { manifest: m, assets: body().assets });
    expect(res.status).toBe(413);
    expect(putCalls).toHaveLength(0);
  });

  it("returns 502, deletes written objects and never writes trace.json when an asset fails", async () => {
    failKey = (k) => k.endsWith("frames/1.png");
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await post(base, body(2));
    expect(res.status).toBe(502);
    expect(putCalls.some((c) => c.key.endsWith("trace.json"))).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.some((k) => k.endsWith("frames/0.png") || k.endsWith("frames/1.png"))).toBe(true);
  });
});

describe("GET /api/browse/traces/:id", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174001";

  it("returns the stored manifest without owner", async () => {
    stored.set(`browse-traces/${ID}/trace.json`, JSON.stringify({ ...manifest([]), id: ID, owner: USER_ID }));
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await fetch(`${base}/api/browse/traces/${ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(ID);
    expect(body.goal).toBe("g");
    expect(body).not.toHaveProperty("owner");
  });

  it("serves doms src as stored (public URLs)", async () => {
    const m = { ...manifest([], ["dom/0.html"]), id: ID };
    m.doms![0]!.src = `https://s3.example.test/bucket/browse-traces/${ID}/dom/0.html`;
    stored.set(`browse-traces/${ID}/trace.json`, JSON.stringify(m));
    const base = await startServer(makeConfig(S3_CONFIG));
    const body = (await (await fetch(`${base}/api/browse/traces/${ID}`)).json()) as { doms: { src: string }[] };
    expect(body.doms[0]!.src).toBe(`https://s3.example.test/bucket/browse-traces/${ID}/dom/0.html`);
  });

  it("returns 400 for a non-UUID id without touching S3", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await fetch(`${base}/api/browse/traces/..%2Fetc`);
    expect(res.status).toBe(400);
    expect((await fetch(`${base}/api/browse/traces/abc`)).status).toBe(400);
    expect(getObjectTextMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the trace is missing or not JSON", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    expect((await fetch(`${base}/api/browse/traces/${ID}`)).status).toBe(404);
    stored.set(`browse-traces/${ID}/trace.json`, "not json");
    expect((await fetch(`${base}/api/browse/traces/${ID}`)).status).toBe(404);
    stored.set(`browse-traces/${ID}/trace.json`, "[1]");
    expect((await fetch(`${base}/api/browse/traces/${ID}`)).status).toBe(404);
  });

  it("lowercases the id and returns 502 when storage fails", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    await fetch(`${base}/api/browse/traces/${ID.toUpperCase()}`);
    expect(getObjectTextMock).toHaveBeenCalledWith(expect.anything(), `browse-traces/${ID}/trace.json`);
    getObjectTextMock.mockRejectedValueOnce(new Error("denied"));
    expect((await fetch(`${base}/api/browse/traces/${ID}`)).status).toBe(502);
  });

  it("returns 503 without an S3 target", async () => {
    const base = await startServer(makeConfig());
    expect((await fetch(`${base}/api/browse/traces/${ID}`)).status).toBe(503);
  });
});

describe("GET /api/browse/traces/:id/dom/:file", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174001";
  const url = (id: string, file: string) => `/api/browse/traces/${id}/dom/${file}`;
  const seed = (src = `https://s3.example.test/bucket/browse-traces/${ID}/dom/0.html`) => {
    const m = { ...manifest([], ["dom/0.html"]), id: ID };
    m.doms![0]!.src = src;
    stored.set(`browse-traces/${ID}/trace.json`, JSON.stringify(m));
    stored.set(`browse-traces/${ID}/dom/0.html`, "<p>hi</p>");
  };

  it("returns the text with safe headers", async () => {
    seed();
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await fetch(`${base}${url(ID, "0.html")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<p>hi</p>");
    expect(getObjectTextMock).toHaveBeenLastCalledWith(
      expect.anything(),
      `browse-traces/${ID}/dom/0.html`,
      expect.objectContaining({ maxBytes: 2 * 1024 * 1024 }),
    );
  });

  it("accepts a bare asset path as the stored src", async () => {
    seed("dom/0.html");
    const base = await startServer(makeConfig(S3_CONFIG));
    expect((await fetch(`${base}${url(ID, "0.html")}`)).status).toBe(200);
  });

  it("returns 404 for a missing object", async () => {
    seed();
    const base = await startServer(makeConfig(S3_CONFIG));
    expect((await fetch(`${base}${url(ID, "1.txt")}`)).status).toBe(404);
    expect(getObjectTextMock).toHaveBeenCalledTimes(1);
  });

  it("does not read the manifest", async () => {
    seed();
    const base = await startServer(makeConfig(S3_CONFIG));
    expect((await fetch(`${base}${url(ID, "0.html")}`)).status).toBe(200);
    expect(getObjectTextMock).toHaveBeenCalledTimes(1);
    expect(getObjectTextMock.mock.calls[0]![1]).toBe(`browse-traces/${ID}/dom/0.html`);
  });

  it("returns 400 for a bad file name or id", async () => {
    seed();
    const base = await startServer(makeConfig(S3_CONFIG));
    for (const f of ["0.png", "x.html", "12345.html", "..%2Ftrace.json", "0.html.txt"]) {
      expect((await fetch(`${base}${url(ID, f)}`)).status).toBe(400);
    }
    expect((await fetch(`${base}${url("a.b", "0.html")}`)).status).toBe(400);
    expect((await fetch(`${base}${url("..%2Fx", "0.html")}`)).status).toBe(400);
    expect(getObjectTextMock).not.toHaveBeenCalled();
  });

  it("returns 502 when storage fails", async () => {
    seed();
    const base = await startServer(makeConfig(S3_CONFIG));
    getObjectTextMock.mockRejectedValueOnce(new Error("larger than 2097152 bytes"));
    expect((await fetch(`${base}${url(ID, "0.html")}`)).status).toBe(502);
  });
});

describe("createDailyCap", () => {
  it("trips at the cap per key and resets on a new day", () => {
    let day = "2026-10-20T10:00:00Z";
    const cap = createDailyCap(2, () => new Date(day));
    expect(cap.over(["u|a", "ip|1"])).toBe(false);
    cap.bump(["u|a", "ip|1"]);
    cap.bump(["u|a", "ip|1"]);
    expect(cap.over(["u|a"])).toBe(true);
    expect(cap.over(["u|b", "ip|1"])).toBe(true);
    expect(cap.over(["u|b", "ip|2"])).toBe(false);
    day = "2026-10-21T00:00:01Z";
    expect(cap.over(["u|a", "ip|1"])).toBe(false);
  });
});
