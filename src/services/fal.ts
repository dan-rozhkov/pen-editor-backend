import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { resolveS3Target, uploadImage, uploadObject } from "./s3.js";
import { sniffImageType } from "./imageTypes.js";

const FAL_BASE_URL = "https://fal.run";

// fal.ai's SVG output has no fixed size in practice (a busy source image can
// trace into a very large document); cap what we'll pull into memory and
// hand back as text rather than silently reading an unbounded body.
const MAX_SVG_BYTES = 2 * 1024 * 1024;
// Same idea for the cut-out PNG from remove_background — mirrors the
// /api/image-proxy ceiling (routes/showcase.ts) since both exist to stop one
// stalled/oversized upstream response from blowing up this process.
const MAX_RASTER_BYTES = 15 * 1024 * 1024;

/** Thrown when a fal.ai request (or the follow-up result download/upload)
 * doesn't complete within the configured deadline. Routes should map this
 * to HTTP 504. */
export class FalTimeoutError extends Error {
  constructor(ms: number) {
    super(`fal.ai request timed out after ${ms}ms`);
    this.name = "FalTimeoutError";
  }
}

/** Thrown when vectorize_image's SVG result contains a construct that could
 * execute (script, event handler, javascript:/data: URI, ...). Routes should
 * map this to a 4xx, not a generic 500 — it's a rejection of untrusted
 * upstream content, not a server failure. */
export class UnsafeSvgError extends Error {
  constructor(reason: string) {
    super(`Refusing to use fal.ai's SVG result: ${reason}`);
    this.name = "UnsafeSvgError";
  }
}

interface FalImageResponse {
  image?: { url?: string };
  images?: Array<{ url?: string }>;
  image_url?: string;
  url?: string;
}

// Element names that can execute script or embed arbitrary foreign content.
// `set`/`animate`/`animateTransform`/`animateMotion` are SMIL animation
// elements — blacklisting them outright (rather than only checking their
// from/to/values attributes) closes the "<set attributeName="href"
// to="javascript:...">" class of attack regardless of which attribute it
// targets.
const DANGEROUS_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "embed",
  "object",
  "set",
  "animate",
  "animatetransform",
  "animatemotion",
  "handler",
]);

// Attributes whose value can carry a URI that executes when dereferenced.
// `from`/`to`/`values`/`attributeName` are included as defense in depth for
// the SMIL vector above, but the real protection against `<set>`/`<animate>`
// is DANGEROUS_TAGS blacklisting those elements outright — `attributeName`'s
// value is normally an attribute NAME (e.g. "href"), not a URI, so checking
// it for a javascript:/data: scheme is a harmless no-op in practice, not a
// meaningful extra guard.
const URI_ATTRS = new Set(["href", "xlink:href", "from", "to", "values", "attributename"]);

// data: URIs that are plain inline raster images and cannot execute.
// data:image/svg+xml is deliberately NOT here — an SVG can embed another
// SVG (with its own <script>) behind that MIME type.
const SAFE_DATA_IMAGE_PREFIXES = ["data:image/png", "data:image/jpeg", "data:image/gif", "data:image/webp"];

function normalizeAttrValue(raw: string): string {
  // Strip whitespace AND C0 control chars, then lowercase — browsers have
  // historically tolerated e.g. "java\tscript:" or embedded NULs as a filter
  // bypass for URI scheme checks.
  return Array.from(raw)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(code <= 0x1f || /\s/.test(ch));
    })
    .join("")
    .toLowerCase();
}

function isDangerousUri(value: string): boolean {
  const normalized = normalizeAttrValue(value);
  if (normalized.startsWith("javascript:")) return true;
  if (normalized.startsWith("data:")) {
    return !SAFE_DATA_IMAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }
  return false;
}

// Matches one HTML/XML-style attribute inside a tag's text: name="value",
// name='value', or name=unquoted-value (terminated by whitespace or '>').
const ATTR_RE = /([a-zA-Z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// Scans a single already-isolated tag's text (e.g. `<a href="javascript:x">`)
// for a dangerous element name or attribute. Returns a human-readable reason
// or null if the tag looks inert.
function inspectTag(tag: string): string | null {
  const nameMatch = /^<\s*([a-zA-Z][\w-]*(?::[\w-]+)?)/.exec(tag);
  if (!nameMatch) return null; // closing tag, `<?xml ...?>`, etc. — no attrs to carry an attack

  const rawName = nameMatch[1].toLowerCase();
  const localName = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;
  if (DANGEROUS_TAGS.has(localName) || DANGEROUS_TAGS.has(rawName)) {
    return `disallowed element <${nameMatch[1]}>`;
  }

  for (const match of tag.matchAll(ATTR_RE)) {
    const attrName = match[1].toLowerCase();
    const attrValue = unquote(match[2]);

    if (/^on[a-z]/.test(attrName)) {
      return `event-handler attribute "${match[1]}" on <${nameMatch[1]}>`;
    }
    if (URI_ATTRS.has(attrName) && isDangerousUri(attrValue)) {
      return `unsafe "${match[1]}" value on <${nameMatch[1]}>`;
    }
  }

  return null;
}

// Validates that `svg` is inert (no script execution surface), WITHOUT
// modifying it. Returns a reason string if something unsafe was found, null
// if the document looks safe. This scans only the content *inside* `<...>`
// tag delimiters — never free text between tags — which is what makes it
// safe to run on legitimate output: a prior regex-rewrite version of this
// check matched `on[a-z]+\s*=` against the whole document and corrupted
// plain text like "<text>total once = 5</text>" (see the regression test).
// A regex scanner over general SVG/XML is still bypassable in principle
// (this isn't a real XML parser), which is why this is a hard reject rather
// than an attempted rewrite: the goal is "never pass untrusted markup
// through," not "sanitize it," and fal.ai's tracer output is machine-
// generated <path>/<g> geometry that will essentially never trip this.
export function findUnsafeSvgConstruct(svg: string): string | null {
  // A bare DOCTYPE can declare external/internal ENTITYs (classic XXE); SVG
  // output never legitimately needs one, so reject it outright rather than
  // trying to parse its (structurally irregular) internal subset with the
  // tag scanner below.
  if (/<!doctype/i.test(svg)) {
    return "a <!DOCTYPE> declaration";
  }

  // Strip comments and CDATA sections before tag-scanning ONLY (the return
  // value/upload always uses the original `svg`, untouched) — a comment or
  // CDATA block containing literal text that happens to look like a tag
  // (e.g. an SVG generator that comments out `<!-- <script> -->`) is inert
  // and must not trip a false rejection.
  const scanText = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");

  for (const match of scanText.matchAll(/<[^>]*>/g)) {
    const reason = inspectTag(match[0]);
    if (reason) return reason;
  }

  return null;
}

/** Throws UnsafeSvgError if `svg` contains anything that could execute.
 * Never modifies its input — a valid document is used exactly as received. */
export function assertSvgIsInert(svg: string): void {
  const reason = findUnsafeSvgConstruct(svg);
  if (reason) {
    throw new UnsafeSvgError(reason);
  }
}

// fal's response shape varies per model, so pull the result URL out
// defensively rather than assuming one field name.
function extractFalUrl(data: FalImageResponse): string {
  const url = data.image?.url ?? data.images?.[0]?.url ?? data.image_url ?? data.url;
  if (!url) throw new Error("fal.ai response contained no image URL");
  return url;
}

// Builds one AbortSignal covering both the configured deadline and an
// optional caller signal (e.g. client disconnect), and runs `fn` against it.
// A single deadline spans the WHOLE operation — the fal call, downloading
// the result, and (where supported) the follow-up S3 upload — rather than
// resetting per network hop, so a slow result host can't add unbounded time
// on top of an already-honored fal.run deadline.
async function withFalDeadline<T>(
  config: Config,
  externalSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = config.FAL_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

  try {
    return await fn(signal);
  } catch (err) {
    // Only the dedicated timeout signal firing means the deadline was hit;
    // an externalSignal abort (client disconnect) surfaces as a plain abort.
    if (timeoutSignal.aborted) {
      throw new FalTimeoutError(timeoutMs);
    }
    throw err;
  }
}

// fal.run is the synchronous mode (as opposed to the queue.fal.run async
// API): these operations complete in 5-15s, well under a reasonable request
// timeout, so there's no need for the poll-a-queue dance.
async function callFal(
  config: Config,
  endpointId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<FalImageResponse> {
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
}

// Downloads `url`, refusing to buffer more than `maxBytes`. Checked twice:
// up front against Content-Length (cheap, catches the common case before any
// body is read) and again while streaming (Content-Length can be absent or
// wrong), aborting the read as soon as the cap is crossed instead of after
// `arrayBuffer()` has already pulled the whole thing into memory.
async function downloadBytes(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to download fal.ai result (${res.status})`);
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(
      `fal.ai result reported ${contentLength} bytes, over the ${maxBytes}-byte limit`,
    );
  }

  if (!res.body) {
    // No readable stream exposed (some fetch polyfills/mocks) — fall back to
    // a single read, still bounded by the check below.
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `fal.ai result was ${arrayBuffer.byteLength} bytes, over the ${maxBytes}-byte limit`,
      );
    }
    return { buffer: Buffer.from(arrayBuffer), contentType };
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`fal.ai result exceeded the ${maxBytes}-byte limit while streaming`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return { buffer: Buffer.concat(chunks), contentType };
}

export async function removeBackground(
  config: Config,
  imageUrl: string,
  externalSignal?: AbortSignal,
): Promise<{ url: string; contentType: string }> {
  return withFalDeadline(config, externalSignal, async (signal) => {
    const data = await callFal(config, config.FAL_BG_MODEL, { image_url: imageUrl }, signal);
    const resultUrl = extractFalUrl(data);

    const { buffer, contentType: declaredContentType } = await downloadBytes(
      resultUrl,
      signal,
      MAX_RASTER_BYTES,
    );

    // Never trust the upstream Content-Type header — sniff the real format
    // from magic bytes, same as the /api/upload route does for user
    // uploads. A wrong declared type would otherwise reach uploadImage,
    // which derives the S3 key's extension from the (trusted-but-wrong)
    // MIME type, and later 415 out of /api/image-proxy's own content-type
    // check — a silently broken cut-out.
    const mimeType = sniffImageType(buffer);
    if (!mimeType) {
      throw new Error(
        `fal.ai returned a result that isn't a recognized image format (declared content-type: ${declaredContentType})`,
      );
    }

    const s3Target = resolveS3Target(config);
    if (!s3Target) {
      // fal's own result URL is short-lived and CORS-less (see the note on
      // vectorizeImage below for the same host) — without S3 to re-host it,
      // a self-contained data: URL is the only thing guaranteed to still
      // render by the time this reaches the canvas, same fallback
      // generateImage uses when S3 isn't configured.
      return { url: `data:${mimeType};base64,${buffer.toString("base64")}`, contentType: mimeType };
    }

    const uploadedUrl = await uploadImage(s3Target, buffer, mimeType, { abortSignal: signal });
    return { url: uploadedUrl, contentType: mimeType };
  });
}

export async function vectorizeImage(
  config: Config,
  imageUrl: string,
  externalSignal?: AbortSignal,
): Promise<{ url: string; svg: string }> {
  return withFalDeadline(config, externalSignal, async (signal) => {
    const data = await callFal(config, config.FAL_VECTORIZE_MODEL, { image_url: imageUrl }, signal);
    const resultUrl = extractFalUrl(data);

    // The browser can't fetch this itself (fal's result host has no CORS),
    // and the SVG text is what a client-executed tool needs to place
    // editable vector layers on the canvas — so fetch it here and hand back
    // the markup, not just a URL.
    const { buffer } = await downloadBytes(resultUrl, signal, MAX_SVG_BYTES);
    const svg = buffer.toString("utf8");

    // Validate BEFORE this goes anywhere else: this same text is both
    // stored publicly and parsed client-side into scene nodes, so both the
    // response and the upload below must never see anything past this
    // check. This throws rather than rewriting — see findUnsafeSvgConstruct
    // for why a "fix it up" sanitizer was the wrong shape for this.
    assertSvgIsInert(svg);

    const s3Target = resolveS3Target(config);
    if (!s3Target) {
      return { url: resultUrl, svg };
    }

    // uploadImage's extension/type table (imageTypes.ts) only recognizes
    // raster formats, so re-upload through the lower-level uploadObject
    // instead, with an explicit .svg key. The content type is hardcoded
    // (not the upstream header) because the payload is known-SVG at this
    // point — it already passed assertSvgIsInert as such.
    // Content-Disposition: attachment is a second, independent layer on top
    // of assertSvgIsInert above — it stops the bucket URL from being
    // rendered inline if opened directly. It has no effect on the normal
    // `<img src>` use of the URL, which ignores Content-Disposition. Note
    // this only covers a direct hit on the bucket URL — /api/image-proxy
    // re-serves the same bytes under its own headers and carries the
    // matching guard itself (see routes/showcase.ts).
    const key = `pen-editor/${randomUUID()}.svg`;
    const uploadedUrl = await uploadObject(s3Target, key, buffer, "image/svg+xml", {
      contentDisposition: "attachment",
      abortSignal: signal,
    });
    return { url: uploadedUrl, svg };
  });
}
