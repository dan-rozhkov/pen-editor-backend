// The one place that decides "is this an image, and of what type" for AI SDK
// message parts. Shared by the vision pass (vision-messages.ts), the OpenCode
// tool-result repair (opencode.ts) and the vision service (services/vision.ts).
//
// Why it is more than a prefix check: AI SDK 7 re-labels file parts itself
// (convertPartToLanguageModelPart / mapToolResultOutput):
//  - inline bytes (a base64 string or Uint8Array) are SNIFFED, and when they
//    match an image signature the mediaType becomes image/* whatever was
//    declared (even application/octet-stream);
//  - a data: URL's own mime type wins over the declared one;
//  - a legacy `file-url`/`image-url` tool-result part without a mediaType is
//    guessed from the URL's file extension.
// A part the SDK will hand to the provider as an image must therefore count as
// an image here, or the vision-less path leaks it (the INVARIANT on
// applyVisionPreprocessing). @ai-sdk/provider-utils' detectMediaType does the
// sniffing but is not a direct dependency, so the signatures are inlined.

/** `image`, `image/*` and `image/<sub>` all denote an image. */
export function isImageMediaType(mediaType: unknown): boolean {
  return typeof mediaType === "string" && (mediaType === "image" || mediaType.startsWith("image/"));
}

/** A full image/<subtype> for building a data URL; "image" and "image/*" carry no subtype, so they fall back to png (the SDK re-detects it from the bytes anyway). */
export function fullImageMediaType(mediaType: string | undefined): string {
  return typeof mediaType === "string" && /^image\/[^*]/.test(mediaType) ? mediaType : "image/png";
}

export const IMAGE_EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  svg: "image/svg+xml",
};

/** The image type implied by a URL's file extension (query and fragment ignored), or undefined. */
export function imageMediaTypeFromUrl(url: string | URL): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = String(url).split(/[?#]/)[0];
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(IMAGE_EXTENSION_MEDIA_TYPES, ext) ? IMAGE_EXTENSION_MEDIA_TYPES[ext] : undefined;
}

/** The mediaType describeImage declares for `image` (data: URL mime, else extension, else jpeg — only the `image/` prefix matters downstream). */
export function imageMediaTypeFor(image: string): string {
  const dataUrl = image.match(/^data:(image\/[a-zA-Z0-9.+-]+)[;,]/);
  if (dataUrl) return dataUrl[1];
  return imageMediaTypeFromUrl(image) ?? "image/jpeg";
}

function bytesAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function sniffBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytesAt(bytes, 0, "GIF8")) return "image/gif";
  if (bytesAt(bytes, 0, "RIFF") && bytesAt(bytes, 8, "WEBP")) return "image/webp";
  if (bytesAt(bytes, 0, "BM")) return "image/bmp";
  if (bytesAt(bytes, 0, "II*\0") || bytesAt(bytes, 0, "MM\0*")) return "image/tiff";
  if (bytesAt(bytes, 4, "ftypavif") || bytesAt(bytes, 4, "ftypavis")) return "image/avif";
  if (bytesAt(bytes, 4, "ftypheic") || bytesAt(bytes, 4, "ftypheix") || bytesAt(bytes, 4, "ftypmif1")) return "image/heic";
  return undefined;
}

/** Image type of raw bytes or a base64 string by magic number, or undefined. Decodes only a short prefix. */
export function sniffImageMediaType(data: string | Uint8Array | ArrayBuffer): string | undefined {
  if (typeof data === "string") {
    try {
      return sniffBytes(new Uint8Array(Buffer.from(data.slice(0, 64), "base64")));
    } catch {
      return undefined;
    }
  }
  return sniffBytes(data instanceof Uint8Array ? data : new Uint8Array(data));
}

/**
 * The image media type AI SDK 7 will resolve for a file part's `data`
 * regardless of the declared mediaType, or undefined when the data does not
 * identify itself as an image: sniffed inline bytes (bare or tagged
 * `{type:"data"}`), or the mime of a data: URL (bare, URL, or tagged
 * `{type:"url"}`). An http(s) URL carries no type of its own.
 */
export function imageMediaTypeOfFileData(data: unknown): string | undefined {
  if (data instanceof URL) return dataUrlImageType(data.toString());
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return sniffImageMediaType(data);
  if (typeof data === "string") {
    if (data.startsWith("data:")) return dataUrlImageType(data);
    if (/^[a-z][a-z0-9+.-]*:/i.test(data)) return undefined; // some other URL
    return sniffImageMediaType(data);
  }
  if (data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string") {
    const tagged = data as { type: string; data?: unknown; url?: unknown };
    if (tagged.type === "data") {
      return typeof tagged.data === "string" && tagged.data.startsWith("data:")
        ? undefined // the SDK rejects a data: URL in inline data
        : imageMediaTypeOfFileData(tagged.data as string | Uint8Array | ArrayBuffer);
    }
    if (tagged.type === "url") {
      const url = tagged.url instanceof URL ? tagged.url.toString() : tagged.url;
      return typeof url === "string" && url.startsWith("data:") ? dataUrlImageType(url) : undefined;
    }
  }
  return undefined;
}

function dataUrlImageType(url: string): string | undefined {
  const mime = url.match(/^data:([^;,]*)/)?.[1];
  return mime && isImageMediaType(mime) ? mime : undefined;
}
