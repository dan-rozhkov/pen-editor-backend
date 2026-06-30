import type { Config } from "../config.js";
import { createS3Client, uploadImage } from "./s3.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Generated image is not a valid base64 data URL");
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

export async function generateImage(
  config: Config,
  prompt: string,
): Promise<{ url: string; mimeType: string }> {
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter image request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenRouterImageResponse;
  const dataUrl = extractDataUrl(data);
  if (!dataUrl) throw new Error("OpenRouter response contained no image");

  const { mimeType, buffer } = decodeDataUrl(dataUrl);

  const s3 = createS3Client(config);
  if (s3 && config.S3_BUCKET && config.S3_ENDPOINT) {
    const url = await uploadImage(s3, config.S3_BUCKET, config.S3_ENDPOINT, buffer, mimeType);
    return { url, mimeType };
  }

  return { url: dataUrl, mimeType };
}
