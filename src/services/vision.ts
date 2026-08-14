import { createHash } from "node:crypto";
import { generateText } from "ai";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";

const NO_QUESTION_PROMPT =
  "Describe everything visible in this image in thorough detail. Include any text, layout structure, colors, typography, spacing, imagery, UI controls and any other notable visual information.";

function withQuestionPrompt(question: string): string {
  return `Fully describe and explain everything about this image, then answer the following question:\n\n${question}`;
}

// A data: URL bigger than this (decoded payload size) is rejected before it
// ever reaches the model — a giant inline image is either a mistake or a
// waste of the vision budget, and failing fast with a clear reason beats a
// slow/expensive round trip to the provider.
const MAX_DATA_URL_BYTES = 6 * 1024 * 1024;

// Cache is keyed by sha256(image + "\0" + question) so the SAME image asked
// the SAME question always resolves to the SAME description text. This is
// less about saving money than about correctness: a non-deterministic
// description would invalidate the provider's prompt cache on every turn
// that re-sends the same image (e.g. a canvas screenshot re-attached across
// steps of one turn).
const CACHE_MAX_ENTRIES = 64;
let cache = new Map<string, string>();

function cacheKey(image: string, question: string | undefined): string {
  return createHash("sha256")
    .update(image)
    .update("\0")
    .update(question ?? "")
    .digest("hex");
}

function cacheSet(key: string, text: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, text);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

/** Test hook: clears the module-level description cache between tests. */
export function __resetVisionCache(): void {
  cache = new Map<string, string>();
}

export function isVisionConfigured(config: Config): boolean {
  return config.VISION_MODEL.trim().length > 0;
}

function decodedDataUrlByteLength(dataUrl: string): number | null {
  const match = dataUrl.match(/^data:[^;,]*;base64,(.+)$/s);
  if (!match) return null;
  const base64 = match[1];
  // Decoded byte length from base64 length, accounting for padding, without
  // actually allocating a Buffer for a payload we may be about to reject.
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export async function describeImage(params: {
  image: string;
  question?: string;
  config: Config;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; text: string }> {
  const { image, question, config, signal } = params;

  if (!isVisionConfigured(config)) {
    return {
      ok: false,
      text: "Vision is not configured on this server (VISION_MODEL is empty).",
    };
  }

  if (image.startsWith("data:")) {
    const byteLength = decodedDataUrlByteLength(image);
    if (byteLength !== null && byteLength > MAX_DATA_URL_BYTES) {
      return {
        ok: false,
        text: `Image is too large to analyze (${(byteLength / (1024 * 1024)).toFixed(1)}MB, limit is ${MAX_DATA_URL_BYTES / (1024 * 1024)}MB).`,
      };
    }
  }

  const key = cacheKey(image, question);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return { ok: true, text: cached };
  }

  const prompt = question ? withQuestionPrompt(question) : NO_QUESTION_PROMPT;

  const timeoutSignal = AbortSignal.timeout(config.VISION_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([timeoutSignal, signal])
    : timeoutSignal;

  try {
    const model = createModel(config, config.VISION_MODEL);
    const result = await generateText({
      model,
      maxOutputTokens: config.VISION_MAX_TOKENS,
      abortSignal: combinedSignal,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image },
          ],
        },
      ],
    });

    const text = result.text.trim();
    if (!text) {
      return { ok: false, text: "Vision model returned an empty description." };
    }

    cacheSet(key, text);
    return { ok: true, text };
  } catch (err) {
    if (timeoutSignal.aborted) {
      return {
        ok: false,
        text: `Vision request timed out after ${config.VISION_TIMEOUT_MS}ms.`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `Vision request failed: ${message}` };
  }
}
