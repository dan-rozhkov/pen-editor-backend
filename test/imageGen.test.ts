import { afterEach, describe, it, expect, vi } from "vitest";
import { makeConfig } from "./helpers.js";

// Mock the S3 module so the S3 branch is deterministic and the no-S3 branch returns null.
vi.mock("../src/services/s3.js", () => ({
  createS3Client: vi.fn(),
  uploadImage: vi.fn(),
}));

import { createS3Client, uploadImage } from "../src/services/s3.js";
import { generateImage, ImageGenerationTimeoutError } from "../src/services/imageGen.js";

const DATA_URL = "data:image/png;base64,aGVsbG8="; // "hello"

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("generateImage", () => {
  it("sends an OpenRouter image request and returns the data URL when S3 is not configured", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    const fetchMock = vi.fn(async () =>
      okResponse({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = makeConfig();
    const result = await generateImage(config, "a red apple");

    expect(result.url).toBe(DATA_URL);
    expect(result.mimeType).toBe("image/png");

    // request shape
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    });
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.model).toBe(config.OPENROUTER_IMAGE_MODEL);
    expect(sent.modalities).toEqual(["image", "text"]);
    expect(sent.messages[0].content).toBe("a red apple");
  });

  it("uploads to S3 and returns the https URL when S3 is configured", async () => {
    vi.mocked(createS3Client).mockReturnValue({} as never);
    vi.mocked(uploadImage).mockResolvedValue("https://cdn.example.com/pen-editor/x.png");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] }),
      ),
    );

    const config = {
      ...makeConfig(),
      S3_ENDPOINT: "https://s3.example.com",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "ak",
      S3_SECRET_ACCESS_KEY: "sk",
    };
    const result = await generateImage(config, "a cat");

    expect(result.url).toBe("https://cdn.example.com/pen-editor/x.png");
    expect(uploadImage).toHaveBeenCalledOnce();
    const [, bucket, endpoint, buffer, mimeType] = vi.mocked(uploadImage).mock.calls[0];
    expect(bucket).toBe("bucket");
    expect(endpoint).toBe("https://s3.example.com");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mimeType).toBe("image/png");
  });

  it("throws when the response contains no image", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ choices: [{ message: { content: "no image here" } }] })));
    await expect(generateImage(makeConfig(), "x")).rejects.toThrow(/no image/i);
  });

  it("throws when OpenRouter returns a non-2xx status", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(generateImage(makeConfig(), "x")).rejects.toThrow(/failed/i);
  });

  it("throws when the data URL mime type is not an image type", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    const NON_IMAGE_DATA_URL = "data:text/html;base64,aGVsbG8=";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          choices: [{ message: { images: [{ image_url: { url: NON_IMAGE_DATA_URL } }] } }],
        }),
      ),
    );
    await expect(generateImage(makeConfig(), "x")).rejects.toThrow(/not a valid base64 data url/i);
  });

  it("extracts a data URL from message content when images is absent", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          choices: [{ message: { content: "Here you go: data:image/png;base64,aGVsbG8=" } }],
        }),
      ),
    );

    const result = await generateImage(makeConfig(), "x");

    expect(result.url).toBe("data:image/png;base64,aGVsbG8=");
    expect(result.mimeType).toBe("image/png");
  });

  it("throws ImageGenerationTimeoutError when the OpenRouter request exceeds the configured timeout", async () => {
    vi.mocked(createS3Client).mockReturnValue(null);
    // Mimic real fetch's behavior of rejecting with the abort signal's reason
    // once the signal fires, instead of ever resolving.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const config = makeConfig({ IMAGE_GENERATION_TIMEOUT_MS: 20 });
    await expect(generateImage(config, "x")).rejects.toThrow(ImageGenerationTimeoutError);
  });
});
