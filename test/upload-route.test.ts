import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeConfig } from "./helpers.js";
import type { Config } from "../src/config.js";

// S3 IO is mocked: createS3Client returns a truthy sentinel and uploadImage
// returns a fixed URL, so the route's own logic (data-URI parsing, magic-byte
// sniffing, size limit) is exercised without network or credentials.
const UPLOADED_URL = "https://cdn.example.test/pen-editor/uploaded.png";
const uploadImageMock = vi.fn(async () => UPLOADED_URL);

vi.mock("../src/services/s3.js", () => ({
  createS3Client: vi.fn(() => ({ sentinel: true })),
  uploadImage: (...args: unknown[]) => uploadImageMock(...(args as [])),
}));

const S3_CONFIG: Partial<Config> = {
  S3_ENDPOINT: "https://s3.example.test",
  S3_BUCKET: "bucket",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUri = `data:image/png;base64,${PNG.toString("base64")}`;

let app: FastifyInstance | undefined;

afterEach(async () => {
  uploadImageMock.mockClear();
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function startServer(config: Config): Promise<string> {
  app = await buildApp(config, { logger: false });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address;
}

function postJson(base: string, body: unknown) {
  return fetch(`${base}/api/upload-image`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/upload-image", () => {
  it("returns 503 when S3 is not configured", async () => {
    const base = await startServer(makeConfig());
    const res = await postJson(base, { image: pngDataUri });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "S3 storage is not configured" });
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it("uploads a valid PNG data URI and returns the stored URL", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await postJson(base, { image: pngDataUri });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: UPLOADED_URL });
    expect(uploadImageMock).toHaveBeenCalledTimes(1);
    // the buffer passed to S3 must be the decoded PNG, mime sniffed server-side
    const [, , , buffer, mime] = uploadImageMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      Buffer,
      string,
    ];
    expect(Buffer.from(buffer).equals(PNG)).toBe(true);
    expect(mime).toBe("image/png");
  });

  it("returns 400 when the JSON body has no image field", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await postJson(base, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing 'image' field" });
  });

  it("returns 400 for a malformed data URI", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const res = await postJson(base, { image: "not-a-data-uri" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid data URI");
  });

  it("returns 400 when the decoded data is not a supported image", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const notImage = `data:image/png;base64,${Buffer.from("hello", "utf8").toString("base64")}`;
    const res = await postJson(base, { image: notImage });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not a supported image");
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the image exceeds the 5 MB limit", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(big); // valid PNG magic so it passes sniffing first
    const res = await postJson(base, {
      image: `data:image/png;base64,${big.toString("base64")}`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("too large");
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a multipart request with no file", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const form = new FormData();
    form.append("notafile", "just text");
    const res = await fetch(`${base}/api/upload-image`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No file uploaded" });
  });

  it("uploads a valid PNG via multipart form-data", async () => {
    const base = await startServer(makeConfig(S3_CONFIG));
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "test.png");
    const res = await fetch(`${base}/api/upload-image`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: UPLOADED_URL });
    expect(uploadImageMock).toHaveBeenCalledTimes(1);
  });
});
