import { afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

// Mock the S3 module so the S3-upload branch is deterministic and the
// no-S3 branch returns null, same pattern as imageGen.test.ts.
vi.mock("../src/services/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/s3.js")>();
  return { ...actual, uploadImage: vi.fn(), uploadObject: vi.fn() };
});

import { uploadImage, uploadObject } from "../src/services/s3.js";
import { removeBackground, vectorizeImage, sanitizeSvg, FalTimeoutError } from "../src/services/fal.js";
import { buildApp } from "../src/app.js";

const FAL_CONFIG = { FAL_KEY: "test-fal-key" };
const SOURCE_URL = "https://example.test/source.png";
const RESULT_URL = "https://fal.media/result.png";
const SVG_RESULT_URL = "https://fal.media/result.svg";
const SVG_TEXT = "<svg><path d=\"M0 0\"/></svg>";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(uploadImage).mockClear();
  vi.mocked(uploadObject).mockClear();
});

describe("removeBackground", () => {
  it("calls the fal endpoint with the right auth header and returns the fal URL when S3 is not configured", async () => {
    const fetchMock = vi.fn(async () => okJson({ image: { url: RESULT_URL } }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig(FAL_CONFIG);
    const result = await removeBackground(config, SOURCE_URL);

    expect(result.url).toBe(RESULT_URL);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://fal.run/${config.FAL_BG_MODEL}`);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Key ${config.FAL_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ image_url: SOURCE_URL });
  });

  it("re-uploads the result to S3 when configured", async () => {
    vi.mocked(uploadImage).mockResolvedValue("https://cdn.example.test/pen-editor/x.png");
    const png = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
        ),
    );

    const config = makeConfig({
      ...FAL_CONFIG,
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
    });
    const result = await removeBackground(config, SOURCE_URL);

    expect(result.url).toBe("https://cdn.example.test/pen-editor/x.png");
    expect(uploadImage).toHaveBeenCalledOnce();
    const [, buffer, mimeType] = vi.mocked(uploadImage).mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mimeType).toBe("image/png");
  });
});

describe("vectorizeImage", () => {
  it("returns both the URL and the fetched SVG text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(SVG_TEXT, { status: 200, headers: { "content-type": "image/svg+xml" } }),
        ),
    );

    const config = makeConfig(FAL_CONFIG);
    const result = await vectorizeImage(config, SOURCE_URL);

    expect(result.url).toBe(SVG_RESULT_URL);
    expect(result.svg).toBe(SVG_TEXT);
  });

  it("re-uploads the SVG via uploadObject (not uploadImage) when S3 is configured", async () => {
    vi.mocked(uploadObject).mockResolvedValue("https://cdn.example.test/pen-editor/x.svg");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(SVG_TEXT, { status: 200, headers: { "content-type": "image/svg+xml" } }),
        ),
    );

    const config = makeConfig({
      ...FAL_CONFIG,
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
    });
    const result = await vectorizeImage(config, SOURCE_URL);

    expect(result.url).toBe("https://cdn.example.test/pen-editor/x.svg");
    expect(uploadObject).toHaveBeenCalledOnce();
    expect(uploadImage).not.toHaveBeenCalled();
    const [, key, buffer, contentType, extra] = vi.mocked(uploadObject).mock.calls[0];
    expect(key).toMatch(/\.svg$/);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(contentType).toBe("image/svg+xml");
    // Content-Disposition: attachment is the second defense layer — it
    // stops the bucket URL from rendering inline if opened directly, on top
    // of sanitizeSvg. <img src> ignores it, so it doesn't affect normal use.
    expect(extra).toEqual({ contentDisposition: "attachment" });
  });

  it("sanitizes malicious SVG before it reaches either the route response or the S3 upload", async () => {
    vi.mocked(uploadObject).mockResolvedValue("https://cdn.example.test/pen-editor/x.svg");
    const maliciousSvg =
      '<svg onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><path d="M0 0"/></a></svg>';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(maliciousSvg, { status: 200, headers: { "content-type": "image/svg+xml" } }),
        ),
    );

    const config = makeConfig({
      ...FAL_CONFIG,
      S3_ENDPOINT: "https://s3.example.test",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
    });
    const result = await vectorizeImage(config, SOURCE_URL);

    // The response handed back to the caller (and thus streamed to the
    // browser/model) is already sanitized.
    expect(result.svg).not.toMatch(/<script/i);
    expect(result.svg).not.toMatch(/onload/i);
    expect(result.svg).not.toMatch(/javascript:/i);
    expect(result.svg).toContain("<path");

    // So is whatever actually got uploaded to the bucket.
    const [, , uploadedBuffer] = vi.mocked(uploadObject).mock.calls[0];
    const uploadedText = Buffer.from(uploadedBuffer as Buffer).toString("utf8");
    expect(uploadedText).not.toMatch(/<script/i);
    expect(uploadedText).not.toMatch(/onload/i);
    expect(uploadedText).not.toMatch(/javascript:/i);
  });

  it("rejects an SVG result over the size limit", async () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(huge, { status: 200, headers: { "content-type": "image/svg+xml" } }),
        ),
    );

    await expect(vectorizeImage(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/byte limit/i);
  });
});

describe("sanitizeSvg", () => {
  it("removes <script> elements", () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("removes self-closing <script> elements", () => {
    const out = sanitizeSvg('<svg><script src="evil.js"/><path d="M0 0"/></svg>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("removes <foreignObject> elements", () => {
    const out = sanitizeSvg(
      '<svg><foreignObject><body onload="alert(1)">hi</body></foreignObject><path d="M0 0"/></svg>',
    );
    expect(out).not.toMatch(/foreignObject/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain('<path d="M0 0"/>');
  });

  it("strips on* event-handler attributes", () => {
    const out = sanitizeSvg('<svg onload="alert(1)"><rect onclick=\'alert(2)\' width="1"/></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('width="1"');
  });

  it("neutralizes javascript: hrefs", () => {
    const out = sanitizeSvg('<a href="javascript:alert(1)"><path d="M0 0"/></a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain('href="#"');
  });

  it("neutralizes javascript: hrefs with bypass whitespace", () => {
    const out = sanitizeSvg('<a href="jav\tascript:alert(1)"><path d="M0 0"/></a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it("neutralizes xlink:href javascript: URIs", () => {
    const out = sanitizeSvg('<use xlink:href="javascript:alert(1)"/>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it("neutralizes non-image data: URIs but keeps data:image/*", () => {
    const out = sanitizeSvg(
      '<a href="data:text/html,<script>alert(1)</script>"></a><image href="data:image/png;base64,AAAA"/>',
    );
    expect(out).toContain('href="#"');
    expect(out).toContain('href="data:image/png;base64,AAAA"');
  });

  it("leaves valid Recraft-style vector output untouched", () => {
    const validSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<g fill="#ff0000"><path d="M10 10 L90 90 Z" fill-rule="evenodd"/></g>' +
      "</svg>";
    expect(sanitizeSvg(validSvg)).toBe(validSvg);
  });
});

describe("fal request errors", () => {
  it("includes the status code when fal returns a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 422 })));
    await expect(removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/422/);
  });

  it("throws a clear error when the response has no recognizable image URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ unexpected: "shape" })));
    await expect(removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/no image url/i);
  });

  it("throws FalTimeoutError when the request exceeds the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const config = makeConfig({ ...FAL_CONFIG, FAL_TIMEOUT_MS: 20 });
    await expect(removeBackground(config, SOURCE_URL)).rejects.toThrow(FalTimeoutError);
  });
});

describe("fal routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("POST /api/remove-background returns 503 without FAL_KEY", async () => {
    app = await buildApp(makeConfig({ FAL_KEY: undefined }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/remove-background",
      payload: { image_url: SOURCE_URL },
    });
    expect(res.statusCode).toBe(503);
  });

  it("POST /api/vectorize returns 503 without FAL_KEY", async () => {
    app = await buildApp(makeConfig({ FAL_KEY: undefined }), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/vectorize",
      payload: { image_url: SOURCE_URL },
    });
    expect(res.statusCode).toBe(503);
  });

  it("POST /api/remove-background rejects an invalid body with 400", async () => {
    app = await buildApp(makeConfig(FAL_CONFIG), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/remove-background",
      payload: { image_url: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });
});
