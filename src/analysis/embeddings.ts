import type { Config } from "../config.js";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

// Gemini embeddings REST API (OpenRouter has no stable embeddings endpoint).
// text-embedding-004 returns 768 dims — matches vector(768) in the schema.
export function createEmbedder(
  config: Config,
  fetchFn: typeof fetch = fetch,
): Embedder | null {
  const apiKey = config.EMBEDDINGS_API_KEY;
  if (!apiKey) return null;
  const model = config.EMBEDDINGS_MODEL;
  return {
    async embed(text) {
      const res = await fetchFn(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        },
      );
      if (!res.ok) {
        throw new Error(`Embeddings API error: ${res.status}`);
      }
      const json = (await res.json()) as { embedding?: { values?: number[] } };
      const values = json.embedding?.values;
      if (!Array.isArray(values)) {
        throw new Error("Embeddings API returned no values");
      }
      return values;
    },
  };
}
