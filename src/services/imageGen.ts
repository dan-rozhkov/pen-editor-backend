import type { Config } from "../config.js";
import { resolveS3Target, uploadImage } from "./s3.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Thrown when the OpenRouter image request doesn't complete within the
 * configured deadline. Routes should map this to HTTP 504. */
export class ImageGenerationTimeoutError extends Error {
  constructor(ms: number) {
    super(`Image generation timed out after ${ms}ms`);
    this.name = "ImageGenerationTimeoutError";
  }
}

interface OpenRouterImageResponse {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>;
      content?: string;
    };
  }>;
}

function extractDataUrl(data: OpenRouterImageResponse): string | null {
  const message = data.choices?.[0]?.message;
  const fromImages = message?.images?.[0]?.image_url?.url;
  if (fromImages) return fromImages;
  // Fallback: some models inline the data URL in the text content.
  if (typeof message?.content === "string") {
    const match = message.content.match(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/);
    if (match) return match[0];
  }
  return null;
}

function decodeDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) throw new Error("Generated image is not a valid base64 data URL");
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

export async function generateImage(
  config: Config,
  prompt: string,
  // Optional signal (e.g. from a client-disconnect listener on the route)
  // combined with the timeout signal below via AbortSignal.any.
  externalSignal?: AbortSignal,
): Promise<{ url: string; mimeType: string }> {
  const timeoutMs = config.IMAGE_GENERATION_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

  // Wrap the whole network exchange — connect AND response-body read — so a
  // timeout that fires mid-stream (headers arrived, body stalls) still maps to
  // the 504 path, not a generic 500.
  let data: OpenRouterImageResponse;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.OPENROUTER_IMAGE_MODEL,
        messages: [{ role: "user", content: prompt }],
        modalities: ["image", "text"],
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter image request failed (${res.status}): ${text.slice(0, 200)}`);
    }

    data = (await res.json()) as OpenRouterImageResponse;
  } catch (err) {
    // Only the dedicated timeout signal firing means the deadline was hit;
    // an externalSignal abort (client disconnect) surfaces as a plain abort.
    if (timeoutSignal.aborted) {
      throw new ImageGenerationTimeoutError(timeoutMs);
    }
    throw err;
  }

  const dataUrl = extractDataUrl(data);
  if (!dataUrl) throw new Error("OpenRouter response contained no image");

  const { mimeType, buffer } = decodeDataUrl(dataUrl);

  const s3Target = resolveS3Target(config);
  if (s3Target) {
    const url = await uploadImage(s3Target, buffer, mimeType);
    return { url, mimeType };
  }

  return { url: dataUrl, mimeType };
}
