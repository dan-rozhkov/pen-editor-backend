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
import {
  removeBackground,
  vectorizeImage,
  findUnsafeSvgConstruct,
  assertSvgIsInert,
  FalTimeoutError,
  UnsafeSvgError,
} from "../src/services/fal.js";
import { buildApp } from "../src/app.js";

const FAL_CONFIG = { FAL_KEY: "test-fal-key" };
const SOURCE_URL = "https://example.test/source.png";
const RESULT_URL = "https://fal.media/result.png";
const SVG_RESULT_URL = "https://fal.media/result.svg";
const SVG_TEXT = '<svg><path d="M0 0"/></svg>';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// A ReadableStream whose `pull` throws if the reader ever tries to consume
// it — used to prove the Content-Length pre-check short-circuits before any
// body bytes are read, not just that the end result is rejected.
function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error("body should never have been read");
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(uploadImage).mockClear();
  vi.mocked(uploadObject).mockClear();
});

describe("removeBackground", () => {
  it("calls the fal endpoint with the right auth header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ image: { url: RESULT_URL } }))
      .mockResolvedValueOnce(new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig(FAL_CONFIG);
    await removeBackground(config, SOURCE_URL);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://fal.run/${config.FAL_BG_MODEL}`);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Key ${config.FAL_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ image_url: SOURCE_URL });
  });

  it("returns a self-contained data: URL when S3 is not configured, not fal's own (short-lived, CORS-less) URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: RESULT_URL } }))
        .mockResolvedValueOnce(new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })),
    );

    const result = await removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL);

    expect(result.url).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    expect(result.contentType).toBe("image/png");
  });

  it("re-uploads the sniffed image to S3 when configured, ignoring an untrustworthy declared content-type", async () => {
    vi.mocked(uploadImage).mockResolvedValue("https://cdn.example.test/pen-editor/x.png");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: RESULT_URL } }))
        // fal (or a misbehaving CDN in front of it) declares a generic type,
        // but the bytes are a real PNG — the real format must win.
        .mockResolvedValueOnce(
          new Response(PNG_BYTES, { headers: { "content-type": "application/octet-stream" } }),
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
    expect(result.contentType).toBe("image/png");
    expect(uploadImage).toHaveBeenCalledOnce();
    const [, buffer, mimeType, extra] = vi.mocked(uploadImage).mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mimeType).toBe("image/png");
    expect(extra?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("throws a clear error when the downloaded bytes aren't a recognized image format", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(Buffer.from("not an image"), { headers: { "content-type": "image/png" } }),
        ),
    );

    await expect(removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(
      /recognized image format/i,
    );
  });
});

describe("vectorizeImage", () => {
  it("returns the fetched SVG text completely unchanged for valid output", async () => {
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
    expect(result.svg).toBe(SVG_TEXT); // byte-for-byte, not a rewritten copy
  });

  it("re-uploads the SVG via uploadObject (not uploadImage), hardcoding image/svg+xml, with Content-Disposition: attachment and the deadline signal", async () => {
    vi.mocked(uploadObject).mockResolvedValue("https://cdn.example.test/pen-editor/x.svg");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          // Declared type deliberately wrong/absent — the upload must still
          // hardcode image/svg+xml since the payload is known-SVG here.
          new Response(SVG_TEXT, { status: 200, headers: { "content-type": "text/plain" } }),
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
    expect(Buffer.from(buffer as Buffer).toString("utf8")).toBe(SVG_TEXT);
    expect(contentType).toBe("image/svg+xml");
    expect(extra?.contentDisposition).toBe("attachment");
    expect(extra?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a malicious SVG (UnsafeSvgError) instead of rewriting it, and never uploads it", async () => {
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

    await expect(vectorizeImage(config, SOURCE_URL)).rejects.toThrow(UnsafeSvgError);
    expect(uploadObject).not.toHaveBeenCalled();
  });

  it("rejects an SVG over the size limit BEFORE reading the body, via Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(unreadableBody(), {
            status: 200,
            headers: { "content-type": "image/svg+xml", "content-length": String(3 * 1024 * 1024) },
          }),
        ),
    );

    // If the pre-check didn't short-circuit, reading the body would throw
    // "body should never have been read" instead of this message.
    await expect(vectorizeImage(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/byte limit/i);
  });

  it("rejects an SVG that exceeds the limit while streaming, when Content-Length is absent", async () => {
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

describe("findUnsafeSvgConstruct / assertSvgIsInert", () => {
  it("rejects <script> elements", () => {
    expect(findUnsafeSvgConstruct('<svg><script>alert(1)</script><path d="M0 0"/></svg>')).toMatch(
      /script/i,
    );
  });

  it("rejects self-closing <script> elements", () => {
    expect(findUnsafeSvgConstruct('<svg><script src="evil.js"/><path d="M0 0"/></svg>')).toMatch(
      /script/i,
    );
  });

  it("rejects <foreignObject> elements", () => {
    expect(
      findUnsafeSvgConstruct(
        '<svg><foreignObject><body onload="alert(1)">hi</body></foreignObject><path d="M0 0"/></svg>',
      ),
    ).toMatch(/foreignobject/i);
  });

  it("rejects quoted on* event-handler attributes", () => {
    expect(findUnsafeSvgConstruct('<svg onload="alert(1)"><path d="M0 0"/></svg>')).toMatch(/onload/i);
  });

  it("rejects unquoted on* event-handler attributes", () => {
    expect(findUnsafeSvgConstruct("<svg><rect onclick=alert(1) width=\"1\"/></svg>")).toMatch(/onclick/i);
  });

  it("rejects an UNQUOTED javascript: href — the escape the old rewrite-based sanitizer missed", () => {
    expect(findUnsafeSvgConstruct('<a href=javascript:alert(1)><path d="M0 0"/></a>')).toMatch(/href/i);
  });

  it("rejects a quoted javascript: href", () => {
    expect(findUnsafeSvgConstruct('<a href="javascript:alert(1)"><path d="M0 0"/></a>')).toMatch(/href/i);
  });

  it("rejects a javascript: href using whitespace as a scheme-check bypass", () => {
    expect(findUnsafeSvgConstruct('<a href="jav\tascript:alert(1)"><path d="M0 0"/></a>')).toMatch(
      /href/i,
    );
  });

  it("rejects xlink:href javascript: URIs", () => {
    expect(findUnsafeSvgConstruct('<use xlink:href="javascript:alert(1)"/>')).toMatch(/href/i);
  });

  it("rejects data:image/svg+xml — the executable data: URI the old rewrite allowed through", () => {
    expect(
      findUnsafeSvgConstruct('<use href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg=="/>'),
    ).toMatch(/href/i);
  });

  it("allows plain raster data: URIs (data:image/png etc)", () => {
    expect(findUnsafeSvgConstruct('<image href="data:image/png;base64,AAAA"/>')).toBeNull();
  });

  it("rejects <set> retargeting an attribute to a javascript: URI via SMIL", () => {
    expect(
      findUnsafeSvgConstruct('<set attributeName="href" to="javascript:alert(1)"/>'),
    ).toMatch(/set/i);
  });

  it("rejects <animate>", () => {
    expect(findUnsafeSvgConstruct('<animate attributeName="href" values="javascript:alert(1)"/>')).toMatch(
      /animate/i,
    );
  });

  it("rejects <animateTransform>", () => {
    expect(findUnsafeSvgConstruct("<animateTransform attributeName=\"transform\"/>")).toMatch(
      /animatetransform/i,
    );
  });

  it("rejects a DOCTYPE declaration (XXE surface)", () => {
    expect(
      findUnsafeSvgConstruct(
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg/>',
      ),
    ).toMatch(/doctype/i);
  });

  it("does not false-positive on <script>/on*-looking text hidden in comments or CDATA", () => {
    expect(
      findUnsafeSvgConstruct(
        '<svg><!-- <script>alert(1)</script> --><path d="M0 0"/></svg>',
      ),
    ).toBeNull();
    expect(
      findUnsafeSvgConstruct("<svg><![CDATA[<script>alert(1)</script>]]><path d=\"M0 0\"/></svg>"),
    ).toBeNull();
  });

  it("REGRESSION: does not corrupt/reject plain text that merely looks like an attribute (old rewrite-based sanitizer mangled this)", () => {
    // sanitizeSvg('<svg><text>total once = 5</text></svg>') used to return
    // '<svg><text>total></svg>' — it matched "once = 5" as an on*-attribute
    // outside any tag and ate the rest of the document.
    const svg = "<svg><text>total once = 5</text></svg>";
    expect(findUnsafeSvgConstruct(svg)).toBeNull();
    expect(() => assertSvgIsInert(svg)).not.toThrow();
  });

  it("accepts valid Recraft-style vector output untouched", () => {
    const validSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<g fill="#ff0000"><path d="M10 10 L90 90 Z" fill-rule="evenodd"/></g>' +
      "</svg>";
    expect(findUnsafeSvgConstruct(validSvg)).toBeNull();
    expect(() => assertSvgIsInert(validSvg)).not.toThrow();
  });

  it("assertSvgIsInert throws UnsafeSvgError with a readable reason", () => {
    expect(() => assertSvgIsInert('<svg><script>alert(1)</script></svg>')).toThrow(UnsafeSvgError);
    expect(() => assertSvgIsInert('<svg><script>alert(1)</script></svg>')).toThrow(/script/i);
  });
});

describe("fal request/timeout errors", () => {
  it("includes the status code when fal returns a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 422 })));
    await expect(removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/422/);
  });

  it("throws a clear error when the response has no recognizable image URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ unexpected: "shape" })));
    await expect(removeBackground(makeConfig(FAL_CONFIG), SOURCE_URL)).rejects.toThrow(/no image url/i);
  });

  it("throws FalTimeoutError when the fal.run call itself exceeds the configured timeout", async () => {
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

  it("throws FalTimeoutError when the RESULT DOWNLOAD (not just the fal.run call) exceeds the deadline", async () => {
    const config = makeConfig({ ...FAL_CONFIG, FAL_TIMEOUT_MS: 20 });
    const falCallUrl = `https://fal.run/${config.FAL_BG_MODEL}`;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        if (url === falCallUrl) {
          return Promise.resolve(okJson({ image: { url: RESULT_URL } }));
        }
        // The download hangs — proves the same deadline signal was passed
        // into downloadBytes, not just callFal.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }),
    );

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

  it("POST /api/vectorize returns 422 (not 500) with a readable message when fal's SVG is unsafe", async () => {
    const maliciousSvg = '<svg><script>alert(1)</script></svg>';
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ image: { url: SVG_RESULT_URL } }))
        .mockResolvedValueOnce(
          new Response(maliciousSvg, { status: 200, headers: { "content-type": "image/svg+xml" } }),
        ),
    );

    app = await buildApp(makeConfig(FAL_CONFIG), { logger: false });
    const res = await app.inject({
      method: "POST",
      url: "/api/vectorize",
      payload: { image_url: SOURCE_URL },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringMatching(/script/i) });
  });
});
