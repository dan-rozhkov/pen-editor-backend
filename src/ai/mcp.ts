import { createMCPClient } from "@ai-sdk/mcp";
import type { Config } from "../config.js";
import { isVisionConfigured } from "../services/vision.js";

type StringKeys<T> = {
  [K in keyof T]: T[K] extends string | undefined ? K : never;
}[keyof T] &
  string;

interface MCPServerEntry {
  name: string;
  url: string;
  apiKeyEnvField: StringKeys<Config>;
}

const MCP_SERVERS: MCPServerEntry[] = [
  {
    name: "refero",
    url: "https://api.refero.design/mcp/",
    apiKeyEnvField: "REFERO_API_KEY",
  },
];

/** Hard deadline for connecting to an MCP server and listing its tools. A hung
 * upstream must not pin the shared in-flight cache entry forever — rejection
 * evicts it (see pending.catch below) so the next request retries. */
const MCP_CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[mcp] ${label}: connect/tools timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface CachedEntry {
  client: MCPClient;
  tools: Record<string, unknown>;
}

const cache = new Map<string, Promise<CachedEntry>>();

export function removeBase64Fields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeBase64Fields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (key === "base64") continue;
    out[key] = removeBase64Fields(val);
  }
  return out;
}

// removeBase64Fields only catches a field literally named "base64" — which
// covers Refero's occasional ad hoc embedding of one, but NOT the MCP
// standard image content shape ({type:"image", data, mimeType}, or the rarer
// {type:"file", data, mimeType} file-content variant some servers emit for an
// image attachment). That field is named "data", not "base64", so it sailed
// straight through removeBase64Fields untouched — confirmed against
// @ai-sdk/mcp's own mcpToModelOutput (node_modules/@ai-sdk/mcp/dist/index.js),
// which promotes exactly this shape into a real image part for every MCP tool
// (not just the two hand-wrapped ones below), via a `toModelOutput` it wires
// onto every tool unconditionally. A production session burned ~95k tokens on
// two `refero_get_screen_image` calls this way — 57% of that request's whole
// payload, re-sent on every subsequent step of the tool loop.
//
// Dropping EVERY image regardless of size (the original fix) overcorrected:
// it also ate a 2KB thumbnail that a vision-capable model on OpenRouter could
// have read natively, and any smaller-than-huge non-image binary (a small
// PDF, a short audio clip) was never touched at all, which is its own gap —
// see MAX_INLINE_BINARY_CHARS below and oversizedBinaryField, which replace
// the old type-based isImageContentPart gate with a SIZE-based one that
// applies uniformly to any binary payload, image or not.
//
// ~24,000 characters ≈ 6,000 tokens: base64 has no whitespace for a
// tokenizer to split on, so treating the raw character count 1:1 with token
// count is a safe (if pessimistic) upper bound, and a common rule of thumb
// puts ~4 characters per token — 24,000 / 4 = 6,000. A typical Refero
// thumbnail comes in well under this; the production incident's two
// full-size screenshots (~95k tokens total) are roughly 8x over it per call
// and still get dropped, same as before.
export const MAX_INLINE_BINARY_CHARS = 24_000;

// Finds an oversized base64 payload wherever it might be hiding in one
// content part, regardless of `type`/mimeType: the standard MCP image shape
// ({type:"image"|"file", data}), the rarer {type:"audio", data} variant, AND
// an MCP embedded resource ({type:"resource", resource:{blob, mimeType}}) —
// which carries its payload under a DIFFERENT key (`resource.blob`, not
// `data` or `base64`) and previously passed through both removeBase64Fields
// and isImageContentPart untouched. Returning null for anything at or under
// the threshold is what lets a small payload of ANY shape — image included —
// survive this sweep intact.
function oversizedBinaryField(
  part: Record<string, unknown>,
): { mimeType: string; length: number } | null {
  if (typeof part.data === "string" && part.data.length > MAX_INLINE_BINARY_CHARS) {
    const mimeType = typeof part.mimeType === "string" ? part.mimeType : "unknown";
    return { mimeType, length: part.data.length };
  }
  const resource = part.resource;
  if (resource && typeof resource === "object") {
    const r = resource as Record<string, unknown>;
    if (typeof r.blob === "string" && r.blob.length > MAX_INLINE_BINARY_CHARS) {
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : "unknown";
      return { mimeType, length: r.blob.length };
    }
  }
  return null;
}

// Replaces a dropped, oversized binary content part with a short text part
// naming what was lost. For an IMAGE mimeType this points at analyze_image
// (backend-executed, works by URL) — but only when `visionConfigured` is
// true: `src/ai/chatTurn.ts` deletes analyze_image from the tool set
// whenever `isVisionConfigured(config)` is false (no VISION_MODEL), and
// naming a tool that isn't there leaves the model with no way to see the
// screen at all rather than a clear dead end. Non-image binaries (a large
// PDF, audio) get no such pointer either way — analyze_image only inspects
// images. Size is an estimate: base64 inflates bytes by ~4/3, so dividing
// back out gives the original payload size without decoding it (decoding
// would spend real CPU on data we're about to throw away).
// The exact marker text describeDroppedBinaryPart() emits for an IMAGE
// payload, shared with resultHadImageDropped() below. These two MUST agree:
// the detector drives whether wrapGetScreenImageTool bothers resolving a URL
// for analyze_image, so if a rename let them drift apart the detector would
// silently always return false and the URL enrichment would quietly stop
// happening — a capability disappearing with no error anywhere.
const IMAGE_DROPPED_LABEL = "Image content dropped";

function describeDroppedBinaryPart(
  mimeType: string,
  length: number,
  visionConfigured: boolean,
): { type: "text"; text: string } {
  const approxKb = Math.max(1, Math.round((length * 0.75) / 1024));
  const isImage = mimeType.startsWith("image/");
  const label = isImage ? IMAGE_DROPPED_LABEL : "Binary content dropped";
  const hint = isImage
    ? visionConfigured
      ? " Call analyze_image with an image URL to inspect it visually instead."
      : " There is no tool available this turn to inspect an image's pixels directly."
    : "";
  return {
    type: "text",
    text:
      `[${label}: ${mimeType}, ~${approxKb}KB, over the ${Math.round(MAX_INLINE_BINARY_CHARS / 1024)}KB inline ` +
      `limit. Raw bytes are never returned here for a payload this size.${hint}]`,
  };
}

export function sanitizeMcpToolResult(result: unknown, visionConfigured: boolean): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const output = removeBase64Fields(result) as Record<string, unknown>;
  const content = output.content;
  if (!Array.isArray(content)) return output;

  output.content = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const typed = part as Record<string, unknown>;
    const oversized = oversizedBinaryField(typed);
    if (oversized) {
      return describeDroppedBinaryPart(oversized.mimeType, oversized.length, visionConfigured);
    }
    const text = typed.text;
    if (typeof text !== "string") return part;
    try {
      const parsed = JSON.parse(text);
      const sanitized = removeBase64Fields(parsed);
      return { ...typed, text: JSON.stringify(sanitized) };
    } catch {
      return part;
    }
  });
  return output;
}

/** Wraps EVERY tool the MCP client returned (any server, not just Refero's
 * two hand-wrapped ones) so its result always passes through
 * sanitizeMcpToolResult before reaching the model. Without this, a tool
 * nobody thought to hand-wrap — refero_get_screen_image was exactly this
 * case until now — leaks raw image bytes the instant it's added or a server
 * ships a new one; every current and future tool needs this floor, not just
 * the ones we remembered to special-case. A tool with no `execute` (the
 * client-executed pen tools, if this were ever pointed at that map) or a
 * non-function value passes through unchanged by reference, matching
 * wrapReferoTool's identity-preserving convention. */
export function sanitizeAllToolResults(
  tools: Record<string, unknown>,
  visionConfigured: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const typed = tool as ReferoTool | undefined;
    if (!typed || typeof typed.execute !== "function") {
      out[name] = tool;
      continue;
    }
    const originalExecute = typed.execute.bind(typed);
    out[name] = {
      ...typed,
      execute: async (input: unknown, options: unknown) => {
        const res = await originalExecute(input, options);
        return sanitizeMcpToolResult(res, visionConfigured);
      },
    };
  }
  return out;
}

interface ReferoTool {
  description?: string;
  title?: string;
  inputSchema?: unknown;
  toModelOutput?: unknown;
  type?: unknown;
  _meta?: unknown;
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

type ToolExecute = (input: unknown, options: unknown) => Promise<unknown>;

/** Wraps a single named Refero tool (no-op if absent or execute-less), optionally
 * rewriting its description and always rewriting its execute function. Keeps the
 * tool-map reference unchanged (`===`) when the named tool isn't present, so
 * composing several wraps over an unaffected map is still an identity op. */
function wrapReferoTool(
  tools: Record<string, unknown>,
  name: string,
  options: {
    describe?: (description: string | undefined) => string;
    transformExecute: (originalExecute: ToolExecute) => ToolExecute;
  },
): Record<string, unknown> {
  const tool = tools[name] as ReferoTool | undefined;
  if (!tool || typeof tool.execute !== "function") {
    return tools;
  }

  const originalExecute = tool.execute.bind(tool);
  return {
    ...tools,
    [name]: {
      ...tool,
      ...(options.describe ? { description: options.describe(tool.description) } : {}),
      execute: options.transformExecute(originalExecute),
    },
  };
}

const INVALID_STYLE_UUIDS_PATTERN = /invalid[-_ ]?style[-_ ]?uuids?/i;
const STYLE_UUID_DESCRIPTION_HINT =
  "Pass exactly one valid style UUID (from refero_search_styles results) per call; multiple UUIDs are rejected.";
const STYLE_UUID_ERROR_HINT =
  "Pass exactly one valid style UUID from refero_search_styles results per call.";

function withStyleUuidHint(text: string): string {
  return INVALID_STYLE_UUIDS_PATTERN.test(text) ? `${text} ${STYLE_UUID_ERROR_HINT}` : text;
}

/** Appends the deterministic retry hint to any text content part whose text
 * indicates invalid style UUIDs (case-insensitive, either spelling). Skips
 * enrichment entirely for results explicitly marked `isError: false` (a
 * benign success payload should never gain a retry hint, even if its text
 * happens to contain the phrase); Refero's exact error shape is otherwise
 * unverified, so `isError` being true or absent still allows matching.
 * Returns the input object unchanged (`===`) when nothing matches, avoiding
 * a needless clone of the already-sanitized payload. */
function enrichStyleUuidResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const output = result as Record<string, unknown>;
  if (output.isError === false) return result;

  const content = output.content;
  if (!Array.isArray(content)) return result;

  const hasMatch = content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      typeof (part as Record<string, unknown>).text === "string" &&
      INVALID_STYLE_UUIDS_PATTERN.test((part as Record<string, unknown>).text as string),
  );
  if (!hasMatch) return result;

  return {
    ...output,
    content: content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const typed = part as Record<string, unknown>;
      if (typeof typed.text !== "string") return part;
      return { ...typed, text: withStyleUuidHint(typed.text) };
    }),
  };
}

/** Same hint, applied when Refero signals the error by throwing instead of
 * returning an error result. */
function enrichStyleUuidThrownError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!INVALID_STYLE_UUIDS_PATTERN.test(message)) return err;

  const hinted = withStyleUuidHint(message);
  if (err instanceof Error) {
    const wrapped = new Error(hinted);
    wrapped.cause = err;
    return wrapped;
  }
  return new Error(hinted);
}

const GET_SCREEN_IMAGE_URL_HINT =
  "Returns a resolvable image URL when possible (often only a thumbnail — see below), or the raw image itself when it's small enough to send inline; a large image is dropped as text rather than returned raw.";

// Pulls a usable image URL out of refero_get_screen's (already-sanitized)
// result, in whichever of the shapes it might arrive: response_format:"json"
// puts the fields directly at the top level or inside `structuredContent`.
// Live-verified 2026-09-17 against real screen_ids, and the claim in an
// earlier version of this comment ("both preview_url and thumbnail_url are
// present and resolvable") does NOT hold in general: a mobile screenshot
// (screen_id d07f994c-274a-40ac-905e-6be6fc8553b2) returned `preview_url:
// null` with only `thumbnail_url` set; a desktop/web screenshot
// (screen_id 40379d1d-931c-4475-88f6-ae1f2011ca74) returned both, both
// resolving 200 image/jpeg via CloudFront; and refero_search_screens'
// results carry `thumbnail_url` only — no `preview_url` field at all.
// preview_url is preferred when present (the larger, non-thumbnail image);
// a thumbnail URL is still a URL — far better than the alternative of no URL
// at all — so it's accepted as a fallback rather than treated as failure,
// and the model should not assume the URL it gets back is full-size.
function extractScreenPreviewUrl(getScreenResult: unknown): string | null {
  const tryObject = (obj: unknown): string | null => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    if (typeof o.preview_url === "string" && o.preview_url) return o.preview_url;
    if (typeof o.thumbnail_url === "string" && o.thumbnail_url) return o.thumbnail_url;
    return null;
  };

  if (!getScreenResult || typeof getScreenResult !== "object") return null;
  const res = getScreenResult as Record<string, unknown>;

  const direct = tryObject(res.structuredContent) ?? tryObject(res);
  if (direct) return direct;

  const content = res.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as Record<string, unknown>;
      if (typed.type !== "text" || typeof typed.text !== "string") continue;
      try {
        const url = tryObject(JSON.parse(typed.text));
        if (url) return url;
      } catch {
        // Not JSON (markdown response_format) — nothing to extract here.
      }
    }
  }
  return null;
}

function textResult(text: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text }] };
}

function withThumbnailSize(input: unknown): Record<string, unknown> {
  return input && typeof input === "object"
    ? { ...(input as Record<string, unknown>), image_size: "thumbnail" }
    : { image_size: "thumbnail" };
}

// True when `result` is exactly the shape describeDroppedBinaryPart produces
// for an IMAGE mimeType (the "[Image content dropped: ..." text) — the
// signal that the real call below returned an oversized image that
// sanitizeMcpToolResult (already applied, see connectAndFetchTools) replaced
// rather than let through. Checked by prefix rather than a shared sentinel
// constant because the two live in different modules and the text is itself
// documentation for the model; a change to the wording only needs to keep
// the same opening tag.
function resultHadImageDropped(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" && text.startsWith(`[${IMAGE_DROPPED_LABEL}:`);
  });
}

/**
 * refero_get_screen_image's own execute returns MCP image content — exactly
 * the bytes sanitizeMcpToolResult exists to keep out of the model's context
 * WHEN IT'S TOO BIG. A production session burned ~95k tokens (57% of one
 * request's whole payload) on two calls to this tool alone, both re-sent on
 * every subsequent tool-loop step — that's still true for a full-size image,
 * but sanitizeAllToolResults (applied to every MCP tool before this wrap
 * runs, see connectAndFetchTools) now only drops payloads over
 * MAX_INLINE_BINARY_CHARS, not every image regardless of size. So this wrap
 * calls the real (already-sanitized) tool FIRST and lets a small image pass
 * through untouched — a vision-capable model on the shipped config
 * (OpenRouter, native on both axes) sees it directly, exactly as it would
 * any other tool-result image. An earlier version of this wrap unconditionally
 * replaced the call with a text pointer regardless of size, which meant the
 * model could never see this tool's image natively even when it easily could
 * have.
 *
 * Only when that real call comes back with an image dropped (oversized) does
 * this reach for a URL: it calls refero_get_screen with the same screen_id
 * (the already-wrapped `tools.refero_get_screen` — forced to
 * image_size:"none", sanitized) and hands back its preview/thumbnail URL, so
 * the model can follow up with analyze_image (backend-executed, built for
 * inspecting an image by URL) — a URL costs ~20 tokens against this tool's
 * own ~50,000. That second call is skipped entirely when `visionConfigured`
 * is false: `chatTurn.ts` deletes analyze_image from the tool set whenever
 * `isVisionConfigured(config)` is false (no VISION_MODEL), so naming it, or
 * spending a real upstream call to resolve a URL nothing can act on, would
 * both be pointless — the dropped-text sanitizeMcpToolResult already produced
 * (which itself omits the analyze_image mention in that case) is the best
 * available answer and is returned as-is.
 *
 * `visionConfigured` false ALSO forces `image_size:"thumbnail"` on the real
 * call up front, maximizing the odds a small image survives the size
 * threshold intact — worthwhile even without analyze_image, since the CHAT
 * model itself might be vision-capable (a different axis from
 * `isVisionConfigured`, which this wrap has no visibility into) and would
 * see a surviving thumbnail natively via vision-messages.ts's passthrough.
 *
 * One real image-fetch call happens per invocation, never two: the old
 * "resolve URL, then ALSO always fall back to a real thumbnail call" shape
 * made a second, guaranteed-useless upstream call whenever the URL lookup
 * failed and the unconditional (pre-threshold) sanitizer would have stripped
 * that fallback's result to a placeholder anyway. The URL lookup here is now
 * purely an ENRICHMENT after a genuine drop, not a redundant fallback path.
 */
function wrapGetScreenImageTool(
  tools: Record<string, unknown>,
  visionConfigured: boolean,
): Record<string, unknown> {
  const tool = tools.refero_get_screen_image as ReferoTool | undefined;
  const screenTool = tools.refero_get_screen as ReferoTool | undefined;
  if (!tool || typeof tool.execute !== "function") return tools;
  if (!screenTool || typeof screenTool.execute !== "function") return tools;

  const originalExecute = tool.execute.bind(tool);
  const getScreenExecute = screenTool.execute.bind(screenTool);

  return {
    ...tools,
    refero_get_screen_image: {
      ...tool,
      description: tool.description
        ? `${tool.description} ${GET_SCREEN_IMAGE_URL_HINT}`
        : GET_SCREEN_IMAGE_URL_HINT,
      execute: async (input: unknown, options: unknown) => {
        const normalizedInput = visionConfigured ? input : withThumbnailSize(input);
        // Already sanitized (size-threshold, see sanitizeAllToolResults in
        // connectAndFetchTools) — a small image is already the final result.
        const result = await originalExecute(normalizedInput, options);
        if (!visionConfigured || !resultHadImageDropped(result)) return result;

        const screenId =
          input && typeof input === "object"
            ? (input as Record<string, unknown>).screen_id
            : undefined;
        if (typeof screenId === "string" && screenId) {
          try {
            const screenResult = await getScreenExecute(
              { screen_id: screenId, response_format: "json" },
              options,
            );
            const url = extractScreenPreviewUrl(screenResult);
            if (url) {
              return textResult(
                `Image URL for screen ${screenId} (may be a thumbnail rather than the full ` +
                  `screenshot — see this tool's description): ${url}\n` +
                  "Call analyze_image with this URL to inspect it visually — this tool does " +
                  "not return large image bytes directly.",
              );
            }
          } catch {
            // Fall through to the already-computed dropped-text `result` —
            // not worth a second real call for the same bytes we already
            // know got dropped.
          }
        }
        return result;
      },
    },
  };
}

export function wrapReferoTools(
  tools: Record<string, unknown>,
  visionConfigured: boolean,
): Record<string, unknown> {
  let result = wrapReferoTool(tools, "refero_get_screen", {
    // Force no binary payloads from Refero and sanitize any accidental base64 in result.
    transformExecute: (originalExecute) => async (input, options) => {
      const normalizedInput =
        input && typeof input === "object"
          ? { ...(input as Record<string, unknown>), image_size: "none" }
          : { image_size: "none" };
      const res = await originalExecute(normalizedInput, options);
      return sanitizeMcpToolResult(res, visionConfigured);
    },
  });

  result = wrapReferoTool(result, "refero_get_style", {
    // Steer the model toward a single valid UUID up front, and give it a
    // deterministic hint to retry with if it still sends several/invalid ones.
    describe: (description) =>
      description ? `${description} ${STYLE_UUID_DESCRIPTION_HINT}` : STYLE_UUID_DESCRIPTION_HINT,
    transformExecute: (originalExecute) => async (input, options) => {
      try {
        const res = await originalExecute(input, options);
        return enrichStyleUuidResult(sanitizeMcpToolResult(res, visionConfigured));
      } catch (err) {
        throw enrichStyleUuidThrownError(err);
      }
    },
  });

  // refero_get_screen_image needs the ALREADY-WRAPPED refero_get_screen
  // (image_size forced to "none", sanitized) to resolve a URL from, so this
  // runs last, against `result` rather than the original `tools`.
  result = wrapGetScreenImageTool(result, visionConfigured);

  return result;
}

function connectAndFetchTools(
  entry: MCPServerEntry,
  apiKey: string,
  visionConfigured: boolean,
): Promise<CachedEntry> {
  const pending = withTimeout(
    (async () => {
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: entry.url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      });
      const tools = await client.tools();
      // Every tool from every configured MCP server gets the base sanitizer,
      // not just Refero's two hand-wrapped ones — a tool nobody thought to
      // special-case (refero_get_screen_image was exactly this until now)
      // must not be the one that leaks raw image bytes. Refero's
      // server-specific wraps then layer on top of the already-sanitized
      // map (double-sanitizing their own two tools is harmless — see
      // sanitizeMcpToolResult's idempotency: nothing it strips can reappear).
      const sanitized = sanitizeAllToolResults(tools, visionConfigured);
      const wrappedTools =
        entry.name === "refero" ? wrapReferoTools(sanitized, visionConfigured) : sanitized;
      console.log(`[mcp] Connected to ${entry.name} at ${entry.url}`);
      return { client, tools: wrappedTools };
    })(),
    MCP_CONNECT_TIMEOUT_MS,
    entry.name,
  );

  pending.catch(() => {
    cache.delete(entry.name);
  });

  return pending;
}

export async function getMCPTools(
  config: Config,
): Promise<Record<string, unknown>> {
  // Whether analyze_image exists on THIS turn's tool set — decides both the
  // size sanitizer's wording (never name a tool that chatTurn.ts is about to
  // delete) and refero_get_screen_image's own strategy (see
  // wrapGetScreenImageTool's doc comment). Computed once per call: the
  // per-server client cache below is keyed only by server name, so if this
  // ever needs to vary WITHIN one process (it doesn't today — VISION_MODEL
  // is fixed at boot), a config change would need to also bust the cache.
  const visionConfigured = isVisionConfigured(config);

  const promises: Promise<CachedEntry>[] = [];
  for (const entry of MCP_SERVERS) {
    const apiKey = config[entry.apiKeyEnvField];
    if (!apiKey) continue;

    if (!cache.has(entry.name)) {
      cache.set(entry.name, connectAndFetchTools(entry, apiKey, visionConfigured));
    }
    promises.push(cache.get(entry.name)!);
  }

  const results = await Promise.allSettled(promises);

  const merged: Record<string, unknown> = {};
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      Object.assign(merged, result.value.tools);
    } else {
      const name = MCP_SERVERS[index]?.name ?? "unknown";
      console.warn(`[mcp] Failed to fetch tools from ${name}:`, result.reason);
    }
  }
  return merged;
}

export async function closeAllMCPClients(): Promise<void> {
  const entries = [...cache.entries()];
  cache.clear();

  await Promise.allSettled(
    entries.map(async ([name, pending]) => {
      try {
        const { client } = await pending;
        await client.close();
        console.log(`[mcp] Closed client: ${name}`);
      } catch (err) {
        console.warn(`[mcp] Error closing client ${name}:`, err);
      }
    }),
  );
}
