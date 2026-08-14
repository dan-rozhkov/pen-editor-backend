// Shared understanding of what get_screenshot's frontend handler returns, used
// by two places that must agree: the tool's `toModelOutput` (which promotes the
// payload to a real image part) and applyVisionPreprocessing (which swaps that
// part back out for a text description when the model can't read images).
//
// The handler always returns JSON.stringify({ imageData: "<data url>" }) on
// success or JSON.stringify({ error: "..." }) on failure — see
// pen-editor/src/lib/tools/getScreenshot.ts.

export interface ScreenshotImage {
  /** Base64 payload with no `data:` prefix — what an image part wants. */
  base64: string;
  mediaType: string;
  /** The full data: URL — what the vision service wants. */
  dataUrl: string;
}

const DATA_URL_RE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/;

function fromDataUrl(value: string): ScreenshotImage | null {
  const match = value.match(DATA_URL_RE);
  if (!match) return null;
  return { mediaType: match[1], base64: match[2], dataUrl: match[0] };
}

/**
 * Pulls the screenshot out of whatever shape a get_screenshot tool output
 * landed in: the raw JSON string, an already-parsed object, or a bare data
 * URL. Returns null when the output carries no image (e.g. an error result),
 * which callers treat as "leave this alone".
 */
export function parseScreenshotDataUrl(output: unknown): ScreenshotImage | null {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (typeof parsed.imageData === "string") return fromDataUrl(parsed.imageData);
      return null; // parsed fine but carries no image — an error result
    } catch {
      return fromDataUrl(output); // not JSON; maybe a bare data URL
    }
  }
  if (output && typeof output === "object") {
    const imageData = (output as Record<string, unknown>).imageData;
    if (typeof imageData === "string") return fromDataUrl(imageData);
  }
  return null;
}
