import { createHash } from "node:crypto";
import { generateText } from "ai";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { withAgentRetry } from "../ai/retry.js";

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

// Exported so a caller that looks at the SAME image+question more than once
// (vision-messages.ts: a success-cache peek, then possibly a failure-cache
// peek, then possibly a describeImage() call — all for the same slot) can
// hash it once and reuse the key everywhere below, instead of re-running
// sha256 over a payload that can be up to MAX_DATA_URL_BYTES (6MB) of base64
// on every one of those lookups. Hashing here is synchronous and runs on the
// event loop inside prepareChatTurn, before streamText() — repeating it per
// lookup is not just wasted work, it is blocking latency added to every chat
// turn at the request's slot cap.
export function visionCacheKey(image: string, question?: string): string {
  return cacheKey(image, question);
}

function cacheSet(key: string, text: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, text);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

// Map iteration order is insertion order, and eviction above drops
// `keys().next()` — i.e. whatever was inserted longest ago. Without this,
// a frequently re-asked-about image (e.g. a screenshot re-attached across
// several steps of one turn, or across turns) would still get evicted on
// its *insertion* age even though it keeps being *used*, silently losing
// its stable description and, with it, the vision-preprocessing pass's
// ability to keep that image's text byte-identical across requests (see
// src/ai/vision-messages.ts). Reading through this function refreshes
// recency by re-inserting the entry, turning the eviction policy into a
// real LRU (least-recently-USED, not least-recently-written).
function cacheGet(key: string): string | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

// Negative cache for describeImage() failures — deliberately separate from
// the success cache above (never merged into it: describeImage must keep
// returning ok:false for a failed image, not start claiming success from a
// cache hit). Without this, a permanently-failing image (bad URL, provider
// outage, an image the vision model always times out on) never gets an
// entry in the success cache, so every request re-runs the full
// VISION_TIMEOUT_MS-bounded describeImage() call for it — and since
// applyVisionPreprocessing runs inside prepareChatTurn before streamText,
// that stalls every subsequent chat turn in the conversation by up to
// VISION_TIMEOUT_MS (120s default). A short TTL (not a permanent cache like
// the success one) lets a transient failure — a flaky provider blip — heal
// itself within a few minutes instead of being pinned to "known bad"
// forever.
const FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MAX_ENTRIES = 64;

interface FailureEntry {
  text: string;
  expiresAt: number;
}

let failureCache = new Map<string, FailureEntry>();

function pruneExpiredFailures(now: number): void {
  for (const [k, v] of failureCache) {
    if (v.expiresAt <= now) failureCache.delete(k);
  }
}

function failureCacheSet(key: string, text: string): void {
  const now = Date.now();
  pruneExpiredFailures(now);
  failureCache.delete(key);
  failureCache.set(key, { text, expiresAt: now + FAILURE_CACHE_TTL_MS });
  if (failureCache.size > FAILURE_CACHE_MAX_ENTRIES) {
    const oldestKey = failureCache.keys().next().value;
    if (oldestKey !== undefined) failureCache.delete(oldestKey);
  }
}

/**
 * Read-only negative-cache lookup — never makes a network call. Mirrors
 * peekCachedDescription() but for a failed describeImage() call: lets the
 * vision-preprocessing pass render the exact same failure text again for a
 * still-failing image without spending its per-turn budget or re-waiting
 * out VISION_TIMEOUT_MS. Expired entries are pruned lazily (here and on
 * write), so there is no background timer to worry about; they naturally
 * fall out of `failureCache` once FAILURE_CACHE_TTL_MS has passed, letting a
 * retry happen.
 */
export function peekCachedFailure(image: string, question?: string): string | undefined {
  return peekCachedFailureByKey(cacheKey(image, question));
}

/** Same as {@link peekCachedFailure}, but for a caller that already has the key (see {@link visionCacheKey}). */
export function peekCachedFailureByKey(key: string): string | undefined {
  const now = Date.now();
  pruneExpiredFailures(now);
  return failureCache.get(key)?.text;
}

/** Test hook: clears the module-level description and failure caches between tests. */
export function __resetVisionCache(): void {
  cache = new Map<string, string>();
  failureCache = new Map<string, FailureEntry>();
}

export function isVisionConfigured(config: Config): boolean {
  return config.VISION_MODEL.trim().length > 0;
}

/**
 * Read-only cache lookup — never makes a network call. Lets a caller (the
 * vision-preprocessing pass) ask "do we already have a stable description
 * for this image+question" without paying for or triggering a fresh
 * describeImage() call. Like describeImage()'s own cache read, this
 * refreshes the entry's LRU recency, since a peek is still a use.
 */
export function peekCachedDescription(image: string, question?: string): string | undefined {
  return peekCachedDescriptionByKey(cacheKey(image, question));
}

/** Same as {@link peekCachedDescription}, but for a caller that already has the key (see {@link visionCacheKey}). */
export function peekCachedDescriptionByKey(key: string): string | undefined {
  return cacheGet(key);
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
  /**
   * Precomputed {@link visionCacheKey} for `image`+`question`, when the
   * caller already hashed it (e.g. for a peekCachedDescription/peekCachedFailure
   * check just before this call). Saves re-hashing a payload that can be up
   * to MAX_DATA_URL_BYTES. Must be `visionCacheKey(image, question)` — passing
   * a mismatched key silently corrupts the cache, so only pass it when it was
   * derived from these exact same `image`/`question` values.
   */
  key?: string;
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

  const key = params.key ?? cacheKey(image, question);
  const cached = cacheGet(key);
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
    // Retried BEFORE any negative-cache write below — a transient failure
    // (429/5xx/connection reset) should not pin "known bad" for
    // FAILURE_CACHE_TTL_MS just because the first attempt hit a blip.
    //
    // Finding #6: maxRetries is capped at 1 here — stricter than
    // DEFAULT_AGENT_RETRY's 2 — because this call sits in a worse spot than
    // /api/chat's own retry (streamWithRetry.ts): applyVisionPreprocessing
    // fans this out to up to 8 NEW describeImage() calls per request (4 at a
    // time, see vision-messages.ts), and every one of them blocks
    // prepareChatTurn — and therefore the whole chat turn's first byte —
    // until it settles. A stuck VISION_MODEL at the chat route's default of
    // 2 retries could mean up to 8 x 3 = 24 doomed attempts and several
    // backoff sleeps of dead time before the model even starts streaming;
    // the thrown provider error also is NOT negatively cached (see the
    // comment below), so this repeats on every subsequent turn until it
    // clears. One retry (2 attempts total) still absorbs a single blip
    // without letting the fan-out multiply it into double digits.
    const result = await withAgentRetry(
      () =>
        generateText({
          model,
          maxOutputTokens: config.VISION_MAX_TOKENS,
          abortSignal: combinedSignal,
          // withAgentRetry (ai/retry.ts) is the single retry policy here —
          // without this, the AI SDK's own default (2 internal retries)
          // would stack on top of it, tripling provider calls per failure.
          maxRetries: 0,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image", image },
              ],
            },
          ],
        }),
      { signal: combinedSignal, maxRetries: 1 },
    );

    const text = result.text.trim();
    if (!text) {
      const failText = "Vision model returned an empty description.";
      failureCacheSet(key, failText);
      return { ok: false, text: failText };
    }

    cacheSet(key, text);
    return { ok: true, text };
  } catch (err) {
    // Only negatively cache failures whose retry is either expensive or
    // pointless — NOT every thrown error. A thrown provider error (429,
    // 5xx, connection reset, ...) usually fails fast and is often
    // transient: negatively caching it would pin `[Image attached but
    // could not be analyzed: ...]` into every turn of every conversation
    // that references this image for the full FAILURE_CACHE_TTL_MS, with
    // no way for the user to recover (the cache key is sha256(image), so
    // re-uploading the same bytes doesn't help) — even though a retry next
    // turn might just succeed. A timeout is different: retrying it costs
    // another full VISION_TIMEOUT_MS (up to 120s) of blocking wait inside
    // prepareChatTurn before streamText() even starts, so an image that
    // reliably times out should stay "known bad" for the TTL rather than
    // re-stalling every subsequent turn. (An empty description, handled
    // above near `cacheSet`, is the third cached case — the model's
    // response was deterministic-enough garbage, not a network fluke, so
    // retrying it immediately is unlikely to help either.)
    if (timeoutSignal.aborted) {
      const failText = `Vision request timed out after ${config.VISION_TIMEOUT_MS}ms.`;
      failureCacheSet(key, failText);
      return { ok: false, text: failText };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `Vision request failed: ${message}` };
  }
}
