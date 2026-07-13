import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeConfig } from "./helpers.js";

vi.mock("../src/services/imageGen.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/imageGen.js")>();
  return { ...actual, generateImage: vi.fn() };
});
import { generateImage, ImageGenerationTimeoutError } from "../src/services/imageGen.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await buildApp(makeConfig(), { logger: false });
  url = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

function post(body: unknown): Promise<Response> {
  return fetch(`${url}/api/generate-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generate-image", () => {
  it("returns the generated image url", async () => {
    vi.mocked(generateImage).mockResolvedValue({ url: "data:image/png;base64,AAAA", mimeType: "image/png" });
    const res = await post({ prompt: "a sunset" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "data:image/png;base64,AAAA" });
    expect(generateImage).toHaveBeenCalledWith(expect.anything(), "a sunset", expect.any(AbortSignal));
  });

  it("does not abort generation after a normal request completes", async () => {
    vi.mocked(generateImage).mockImplementation(async (_config, _prompt, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal?.aborted) throw signal.reason;
      return { url: "data:image/png;base64,AAAA", mimeType: "image/png" };
    });

    const res = await post({ prompt: "a sunset" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "data:image/png;base64,AAAA" });
  });

  it("rejects a missing prompt with 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it("returns 500 with an error when generation fails", async () => {
    vi.mocked(generateImage).mockRejectedValue(new Error("openrouter down"));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("openrouter down") });
  });

  it("returns 504 when image generation times out", async () => {
    vi.mocked(generateImage).mockRejectedValue(new ImageGenerationTimeoutError(90_000));
    const res = await post({ prompt: "x" });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("timed out") });
  });
});
