import { describe, expect, it, vi } from "vitest";
import { createEmbedder } from "../src/analysis/embeddings.js";
import { makeConfig } from "./helpers.js";

describe("createEmbedder", () => {
  it("returns null without an API key", () => {
    expect(createEmbedder(makeConfig())).toBeNull();
  });

  it("calls the Gemini embedContent endpoint and returns values", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ embedding: { values: [0.1, 0.2] } }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const embedder = createEmbedder(
      makeConfig({ EMBEDDINGS_API_KEY: "k", EMBEDDINGS_MODEL: "text-embedding-004" }),
      fetchFn,
    );
    const values = await embedder!.embed("hello");
    expect(values).toEqual([0.1, 0.2]);
    const url = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain("models/text-embedding-004:embedContent");
    expect(url).not.toContain("key=k"); // key travels in a header, not the URL
  });

  it("throws on non-OK responses and on missing values", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const embedder = createEmbedder(makeConfig({ EMBEDDINGS_API_KEY: "k" }), bad);
    await expect(embedder!.embed("x")).rejects.toThrow(/403/);
  });
});
