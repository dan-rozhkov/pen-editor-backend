import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { resolveS3Target, uploadImage, uploadObject } from "./s3.js";

const FAL_BASE_URL = "https://fal.run";

// fal.ai's SVG output has no fixed size in practice (a busy source image can
// trace into a very large document); cap what we'll pull into memory and
// hand back as text rather than silently truncating it.
const MAX_SVG_BYTES = 2 * 1024 * 1024;

/** Thrown when a fal.ai request doesn't complete within the configured
 * deadline. Routes should map this to HTTP 504. */
export class FalTimeoutError extends Error {
  constructor(ms: number) {
    super(`fal.ai request timed out after ${ms}ms`);
    this.name = "FalTimeoutError";
  }
}

interface FalImageResponse {
  image?: { url?: string };
  images?: Array<{ url?: string }>;
  image_url?: string;
  url?: string;
}

// Defence-in-depth SVG sanitizer for fal.ai's vectorize output. SVG is an
// XML dialect that can carry <script>, <foreignObject> (arbitrary embedded
// HTML), event-handler attributes, and javascript:/data: URIs behind
// href/xlink:href — and this text both gets stored in our own public bucket
// AND is parsed client-side into scene nodes (not just linked to), so the
// attack surface is wider than "don't open this URL directly". A regex
// sanitizer over general SVG/XML is famously bypassable (CDATA tricks,
// malformed markup a lenient parser still executes, etc.) — this is a second
// layer alongside the Content-Disposition: attachment header set on upload
// below, not the only defense. A real DOM/XML parser would be more robust;
// swap this for one (e.g. a sanitizer package) if a bypass is ever found.
export function sanitizeSvg(svg: string): string {
  let out = svg;

  // Drop <script> and <foreignObject> elements entirely — paired and
  // self-closing forms. foreignObject can embed arbitrary (X)HTML, which is
  // just as dangerous as a <script> tag once this SVG is placed in a page.
  for (const tag of ["script", "foreignObject"]) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, "gi"), "");
  }

  // Strip on* event-handler attributes (onload, onclick, onerror, ...),
  // quoted or unquoted. The leading \s+ anchors this to an actual attribute
  // boundary so it can't match the tail of an unrelated attribute/word.
  out = out.replace(/\s+on[a-z][a-z0-9]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  // Neutralize href/xlink:href attributes whose value is a javascript: URI,
  // or a data: URI that isn't a plain inline image (data:text/html,
  // data:image/svg+xml;base64,... with embedded script, etc. can all
  // execute). Whitespace/control chars are stripped before the scheme check
  // since browsers tolerate e.g. "java\tscript:" as a bypass.
  out = out.replace(
    /((?:xlink:)?href\s*=\s*)("[^"]*"|'[^']*')/gi,
    (full: string, prefix: string, quoted: string) => {
      const raw = quoted.slice(1, -1);
      // Strip whitespace AND C0 control chars (tab/newline/etc. count as
      // whitespace already, but this also catches other control bytes some
      // browsers still tolerate inside a URI scheme as a filter bypass).
      const normalized = Array.from(raw)
        .filter((ch) => {
          const code = ch.charCodeAt(0);
          return !(code <= 0x1f || /\s/.test(ch));
        })
        .join("")
        .toLowerCase();
      const quote = quoted[0];
      if (normalized.startsWith("javascript:")) return `${prefix}${quote}#${quote}`;
      if (normalized.startsWith("data:") && !normalized.startsWith("data:image/")) {
        return `${prefix}${quote}#${quote}`;
      }
      return full;
    },
  );

  return out;
}

// fal's response shape varies per model, so pull the result URL out
// defensively rather than assuming one field name.
function extractFalUrl(data: FalImageResponse): string {
  const url = data.image?.url ?? data.images?.[0]?.url ?? data.image_url ?? data.url;
  if (!url) throw new Error("fal.ai response contained no image URL");
  return url;
}

// fal.run is the synchronous mode (as opposed to the queue.fal.run async
// API): these operations complete in 5-15s, well under a reasonable request
// timeout, so there's no need for the poll-a-queue dance.
async function callFal(
  config: Config,
  endpointId: string,
  input: Record<string, unknown>,
  // Optional signal (e.g. from a client-disconnect listener on the route)
  // combined with the timeout signal below via AbortSignal.any.
  externalSignal?: AbortSignal,
): Promise<FalImageResponse> {
  const timeoutMs = config.FAL_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

  // Wrap the whole network exchange — connect AND response-body read — so a
  // timeout that fires mid-stream (headers arrived, body stalls) still maps
  // to the 504 path, not a generic 500.
  try {
    const res = await fetch(`${FAL_BASE_URL}/${endpointId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${config.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`fal request failed (${res.status}): ${text.slice(0, 200)}`);
    }

    return (await res.json()) as FalImageResponse;
  } catch (err) {
    // Only the dedicated timeout signal firing means the deadline was hit;
    // an externalSignal abort (client disconnect) surfaces as a plain abort.
    if (timeoutSignal.aborted) {
      throw new FalTimeoutError(timeoutMs);
    }
    throw err;
  }
}

async function downloadBytes(
  url: string,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download fal.ai result (${res.status})`);
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const arrayBuffer = await res.arrayBuffer();
  if (maxBytes && arrayBuffer.byteLength > maxBytes) {
    throw new Error(
      `fal.ai result was ${arrayBuffer.byteLength} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

export async function removeBackground(
  config: Config,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<{ url: string; contentType: string }> {
  const data = await callFal(config, config.FAL_BG_MODEL, { image_url: imageUrl }, signal);
  const resultUrl = extractFalUrl(data);

  const s3Target = resolveS3Target(config);
  if (!s3Target) {
    return { url: resultUrl, contentType: "image/png" };
  }

  const { buffer, contentType } = await downloadBytes(resultUrl);
  const uploadedUrl = await uploadImage(s3Target, buffer, contentType);
  return { url: uploadedUrl, contentType };
}

export async function vectorizeImage(
  config: Config,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<{ url: string; svg: string }> {
  const data = await callFal(config, config.FAL_VECTORIZE_MODEL, { image_url: imageUrl }, signal);
  const resultUrl = extractFalUrl(data);

  // The browser can't fetch this itself (fal's result host has no CORS), and
  // the SVG text is what a client-executed tool needs to place editable
  // vector layers on the canvas — so fetch it here and hand back the markup,
  // not just a URL. Sanitize BEFORE it goes anywhere else: this same text is
  // both stored publicly and parsed client-side into scene nodes, so both
  // the response and the upload below must see the sanitized version, never
  // the raw fal output.
  const { buffer, contentType } = await downloadBytes(resultUrl, MAX_SVG_BYTES);
  const svg = sanitizeSvg(buffer.toString("utf8"));
  const sanitizedBuffer = Buffer.from(svg, "utf8");

  const s3Target = resolveS3Target(config);
  if (!s3Target) {
    return { url: resultUrl, svg };
  }

  // uploadImage's extension/type table (imageTypes.ts) only recognizes
  // raster formats, so re-upload through the lower-level uploadObject
  // instead, with an explicit .svg key and the real content type.
  // Content-Disposition: attachment is a second, independent layer on top of
  // sanitizeSvg above — it stops the bucket URL from being rendered inline
  // if opened directly in a browser tab. It has no effect on the normal
  // `<img src>` use of the URL, which ignores Content-Disposition.
  const key = `pen-editor/${randomUUID()}.svg`;
  const uploadedUrl = await uploadObject(s3Target, key, sanitizedBuffer, contentType || "image/svg+xml", {
    contentDisposition: "attachment",
  });
  return { url: uploadedUrl, svg };
}
