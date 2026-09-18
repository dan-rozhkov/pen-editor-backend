import { createMCPClient } from "@ai-sdk/mcp";
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { isVisionConfigured } from "../services/vision.js";

/** Hard deadline for connecting to an MCP server and listing its tools. A hung
 * upstream must not pin the shared in-flight cache entry forever — rejection
 * evicts it (see the `.catch` in getMCPTools below) so the next request
 * retries. */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;

// `onLateResolve` fires when `promise` settles successfully AFTER this
// timeout has already rejected — the connection nobody is waiting for
// anymore. Without it, that connection's transport is orphaned: the caller
// already moved on (and evicted whatever cache entry was tracking it), so
// nothing else in the process would ever call `.close()` on it, leaking one
// transport per connect that finishes just late enough to miss the
// deadline. A late REJECTION needs no such hook — there is no resource to
// clean up when the promise never produced a value.
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`[mcp] ${label}: connect/tools timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          onLateResolve?.(value);
        } else {
          resolve(value);
        }
      },
      (err) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      },
    );
  });
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface CachedEntry {
  client: MCPClient;
  tools: Record<string, unknown>;
  // Reference count for in-flight USES of `tools`, not cache hits — every
  // getMCPTools() call that resolves this entry increments it, and the
  // matching releaseMCPTools(tools) call (wired through prepareChatTurn's
  // returned `tools`, see attachMobbinRelease) decrements it. Needed
  // because a request's tool-loop can run far longer than this entry's TTL
  // (30 min) or its turn in the LRU eviction order — without it,
  // pruneExpired/enforceMaxSize would close a client a concurrent request
  // is mid-call on, breaking that request's stream on a now-dead transport.
  refCount: number;
  // Set once this entry has been evicted from `cache` (TTL/LRU) but could
  // not be closed immediately because refCount > 0. `closeResolved` is
  // deferred until releaseEntry brings refCount to 0, with RETIRE_FORCE_CLOSE_MS
  // as a backstop against a caller that never releases (e.g. crashes
  // without the request's "close" handler firing).
  retiring: boolean;
  // Guards against closing twice: the grace-period backstop timer and a
  // releaseEntry-triggered close can otherwise both fire for the same
  // entry.
  closed: boolean;
}

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

// removeBase64Fields only catches a field literally named "base64" — which is
// NOT the MCP standard image content shape ({type:"image", data, mimeType},
// or the rarer {type:"file", data, mimeType} file-content variant some
// servers emit for an image attachment). That field is named "data", not
// "base64", so it sails straight through removeBase64Fields untouched —
// confirmed against @ai-sdk/mcp's own mcpToModelOutput (node_modules/
// @ai-sdk/mcp/dist/index.js), which promotes exactly this shape into a real
// image part for every MCP tool, via a `toModelOutput` it wires onto every
// tool unconditionally.
//
// See MAX_INLINE_BINARY_CHARS below and oversizedBinaryField, which apply a
// SIZE-based gate to any binary payload, image or not, rather than dropping
// every image regardless of size.
//
// Mobbin's previews are deliberately low-resolution, meant to be read by the
// model rather than a human, and the shipped chat provider (OpenRouter,
// the only one — see CLAUDE.md's "Chat model provider" section) carries a
// tool-result image straight through to the model as a real image part
// (`providerHandlesToolResultImages`, src/ai/modelRef.ts, unconditionally
// true today). So the threshold below only needs to guard against a
// genuinely oversized SINGLE payload — a full-resolution screenshot smuggled
// into a result, or a pathological upstream response — not against ordinary
// preview images. It used to be 24,000 chars (~6,000 tokens, tuned for
// Refero's occasional full-size screenshot); raised to 200,000 (~50,000
// tokens) so one Mobbin preview image passes through WHOLE or drops WHOLE,
// never half — clipping a single preview mid-payload would leave the model
// looking at a truncated, undecodable image with no error anywhere.
//
// This is a PER-PART ceiling only. search_screens/search_sections can still
// return up to MOBBIN_LIMIT_CAPS-many items (8), each with its own preview
// under this ceiling — see MAX_TOTAL_BINARY_CHARS_PER_RESULT below for the
// AGGREGATE budget that actually bounds what one tool result costs.
export const MAX_INLINE_BINARY_CHARS = 200_000;

// Aggregate budget across every part of ONE tool result. The per-part
// ceiling above stops a single oversized payload, but does nothing about
// many payloads that are each individually fine: search_screens/
// search_sections can return up to 8 items (MOBBIN_LIMIT_CAPS), each with an
// inline preview — 8 previews at, say, 150,000 chars apiece sum to 1.2M
// chars (~300,000 tokens) in ONE tool result, and that whole result is
// re-sent to the model on every subsequent step of the tool loop (useChat
// resends full history on each auto-continuation). This is exactly the
// context-overflow failure class c598b2f was written to close (95,000
// tokens from two screenshots there; this is the same shape at MCP-search
// scale). Set to 300,000 chars (~75,000 tokens at the same ~4-chars/token
// ratio used to size MAX_INLINE_BINARY_CHARS above) — enough for one
// full-size legitimate preview plus a couple of smaller ones, comfortably
// under "a couple tens of thousands of tokens" as a hard ceiling for a
// single re-sent tool result, but far short of what an un-budgeted batch of
// 8 would otherwise cost.
export const MAX_TOTAL_BINARY_CHARS_PER_RESULT = 300_000;

// Extracts a binary payload's {mimeType, length} from one content part,
// regardless of size, wherever it might be hiding: the standard MCP image
// shape ({type:"image"|"file", data}), the rarer {type:"audio", data}
// variant, AND an MCP embedded resource ({type:"resource",
// resource:{blob, mimeType}}) — which carries its payload under a DIFFERENT
// key (`resource.blob`, not `data` or `base64`) and previously passed
// through both removeBase64Fields and any type-based image check
// untouched. Shared by the per-part oversized check AND the aggregate
// budget below, which both need to find the same payload.
function extractBinaryField(
  part: Record<string, unknown>,
): { mimeType: string; length: number } | null {
  if (typeof part.data === "string") {
    const mimeType = typeof part.mimeType === "string" ? part.mimeType : "unknown";
    return { mimeType, length: part.data.length };
  }
  const resource = part.resource;
  if (resource && typeof resource === "object") {
    const r = resource as Record<string, unknown>;
    if (typeof r.blob === "string") {
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : "unknown";
      return { mimeType, length: r.blob.length };
    }
  }
  return null;
}

// Returning null for anything at or under the threshold is what lets a
// small payload of ANY shape survive the per-part sweep intact.
function oversizedBinaryField(
  part: Record<string, unknown>,
): { mimeType: string; length: number } | null {
  const field = extractBinaryField(part);
  return field && field.length > MAX_INLINE_BINARY_CHARS ? field : null;
}

// Replaces a dropped, oversized binary content part with a short text part
// naming what was lost. For an IMAGE mimeType this points at analyze_image
// (backend-executed, works by URL) — but only when `visionConfigured` is
// true: `src/ai/chatTurn.ts` deletes analyze_image from the tool set
// whenever `isVisionConfigured(config)` is false (no VISION_MODEL), and
// naming a tool that isn't there leaves the model with no way to see the
// image at all rather than a clear dead end. Non-image binaries (a large
// PDF, audio) get no such pointer either way — analyze_image only inspects
// images. Size is an estimate: base64 inflates bytes by ~4/3, so dividing
// back out gives the original payload size without decoding it.
export const IMAGE_DROPPED_LABEL = "Image content dropped";

function describeDroppedBinaryPart(
  mimeType: string,
  length: number,
  visionConfigured: boolean,
  reason: "oversized" | "aggregate-budget" | "vision-unavailable" = "oversized",
): { type: "text"; text: string } {
  const approxKb = Math.max(1, Math.round((length * 0.75) / 1024));
  const isImage = mimeType.startsWith("image/");
  const label = isImage ? IMAGE_DROPPED_LABEL : "Binary content dropped";

  // "vision-unavailable" is a different failure mode from the two size-based
  // ones below: the payload is perfectly small enough to send, but the
  // MODEL selected for this turn cannot read images at all (see
  // gateImagesForVisionlessModel). The hint therefore points at
  // mobbin_url/image_url — fields that survive untouched in a SIBLING
  // content part of the same result, never redacted by this function —
  // rather than at "raw bytes are never returned for a payload this size",
  // which would be a false claim for a payload this small.
  if (reason === "vision-unavailable") {
    const hint = isImage
      ? visionConfigured
        ? " Call analyze_image with this item's image_url to inspect it visually instead."
        : " There is no tool available this turn to inspect an image's pixels directly — " +
          "use the mobbin_url/image_url fields already included in this result if you need to reference it."
      : "";
    return {
      type: "text",
      text:
        `[${label}: ${mimeType}, ~${approxKb}KB, withheld because the model selected for this turn ` +
        `cannot read images.${hint}]`,
    };
  }

  const hint = isImage
    ? visionConfigured
      ? " Call analyze_image with an image URL to inspect it visually instead."
      : " There is no tool available this turn to inspect an image's pixels directly."
    : "";
  const reasonText =
    reason === "oversized"
      ? `over the ${Math.round(MAX_INLINE_BINARY_CHARS / 1024)}KB inline limit`
      : `this tool result's total inline binary content exceeded the ${Math.round(MAX_TOTAL_BINARY_CHARS_PER_RESULT / 1024)}KB aggregate budget across all its parts`;
  return {
    type: "text",
    text:
      `[${label}: ${mimeType}, ~${approxKb}KB, ${reasonText}. ` +
      `Raw bytes are never returned here for a payload this size.${hint}]`,
  };
}

// Second-pass gate, applied PER-REQUEST (never baked into the cached
// CachedEntry — see the comment on `gateImagesForVisionlessModel` below for
// why): strips any image content part that survived sanitizeMcpToolResult's
// size-based gates (i.e. was small enough to keep) when the model selected
// for THIS turn cannot read images at all. Non-image binaries (a small PDF)
// are left alone — they were never the vision problem.
function dropRemainingImagesForVisionlessModel(
  result: unknown,
  visionConfigured: boolean,
): unknown {
  if (!result || typeof result !== "object") return result;
  const output = { ...(result as Record<string, unknown>) };
  const content = output.content;
  if (!Array.isArray(content)) return output;

  output.content = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const typed = part as Record<string, unknown>;
    const binary = extractBinaryField(typed);
    if (binary && binary.mimeType.startsWith("image/")) {
      return describeDroppedBinaryPart(
        binary.mimeType,
        binary.length,
        visionConfigured,
        "vision-unavailable",
      );
    }
    return part;
  });
  return output;
}

export function sanitizeMcpToolResult(result: unknown, visionConfigured: boolean): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const output = removeBase64Fields(result) as Record<string, unknown>;
  const content = output.content;
  if (!Array.isArray(content)) return output;

  // Running total of binary chars kept so far, and a sticky flag: once the
  // aggregate budget is crossed, every REMAINING binary part is replaced —
  // not just the one that pushed the total over — so this tool result's
  // total cost is actually bounded, not merely "bounded except for
  // whichever part happened to trip the check".
  let runningTotal = 0;
  let budgetExceeded = false;

  output.content = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const typed = part as Record<string, unknown>;

    const oversized = oversizedBinaryField(typed);
    if (oversized) {
      // Already over the per-part ceiling on its own — dropped regardless
      // of the aggregate budget, and never added to runningTotal since
      // nothing of it survives.
      return describeDroppedBinaryPart(oversized.mimeType, oversized.length, visionConfigured);
    }

    const binary = extractBinaryField(typed);
    if (binary) {
      if (budgetExceeded || runningTotal + binary.length > MAX_TOTAL_BINARY_CHARS_PER_RESULT) {
        budgetExceeded = true;
        return describeDroppedBinaryPart(
          binary.mimeType,
          binary.length,
          visionConfigured,
          "aggregate-budget",
        );
      }
      runningTotal += binary.length;
      // Falls through to the JSON-text pass below (a part with a binary
      // field never also has a JSON-encoded `text` field in practice, but
      // there's no reason to special-case that out).
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

interface McpTool {
  description?: string;
  title?: string;
  inputSchema?: unknown;
  toModelOutput?: unknown;
  type?: unknown;
  _meta?: unknown;
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

/** Wraps EVERY tool the MCP client returned so its result always passes
 * through sanitizeMcpToolResult before reaching the model. Without this, a
 * tool nobody thought to hand-wrap leaks raw image/binary bytes the instant
 * it's added or a server ships a new one — every current and future tool
 * needs this floor. A tool with no `execute` (a static-schema entry, if this
 * were ever pointed at that map) or a non-function value passes through
 * unchanged by reference. */
export function sanitizeAllToolResults(
  tools: Record<string, unknown>,
  visionConfigured: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const typed = tool as McpTool | undefined;
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

// Mobbin's own documented ceilings/defaults are looser than we want to
// re-send on every step of a tool loop: search_screens/search_sections
// allow up to 30 (default 20), search_flows allows up to 10 (default 5).
// Each result item carries an inline preview image, so a wide `limit`
// multiplies straight into tokens re-sent on every subsequent tool-loop
// step. Clamped down to a small, fixed ceiling regardless of what the model
// requests (or omits) — never guessed, this value is meant to be measured
// against live output and adjusted from there.
const MOBBIN_LIMIT_CAPS: Readonly<Record<string, number>> = {
  search_screens: 8,
  search_sections: 8,
  search_flows: 4,
};

function clampLimitInput(input: unknown, cap: number): Record<string, unknown> {
  const obj: Record<string, unknown> =
    input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  const requested = obj.limit;
  const requestedNumber = typeof requested === "number" ? requested : undefined;
  obj.limit = requestedNumber !== undefined ? Math.min(requestedNumber, cap) : cap;
  return obj;
}

/** Wraps the three Mobbin tools (whichever are present) so `limit` in the
 * call arguments is clamped to MOBBIN_LIMIT_CAPS before the real call, no
 * matter what the model asked for (or omitted). Only rewrites arguments —
 * the tool's declared schema/description is untouched, so the model still
 * sees Mobbin's own documented ceiling and may be surprised results come
 * back capped lower; that's an acceptable, silent clamp rather than a
 * rejected call. */
function wrapMobbinTools(tools: Record<string, unknown>): Record<string, unknown> {
  let result = tools;
  for (const [name, cap] of Object.entries(MOBBIN_LIMIT_CAPS)) {
    const tool = result[name] as McpTool | undefined;
    if (!tool || typeof tool.execute !== "function") continue;
    const originalExecute = tool.execute.bind(tool);
    result = {
      ...result,
      [name]: {
        ...tool,
        execute: (input: unknown, options: unknown) =>
          originalExecute(clampLimitInput(input, cap), options),
      },
    };
  }
  return result;
}

const MOBBIN_SERVER = {
  name: "mobbin",
  url: "https://api.mobbin.com/mcp",
} as const;

// The credential now arrives per request (the browser's own Mobbin OAuth
// token, never stored server-side — see docs/superpowers/specs/
// 2026-09-18-mobbin-mcp-design.md), so the client cache can no longer be
// keyed by server name alone: every distinct user who ever connects would
// otherwise leave a live MCP client sitting in the process forever. Keyed
// instead by a SHA-256 hash of the access token — never the raw token
// itself, which must never be logged or held as a cache key verbatim — with
// a TTL and a maximum size, evicting (and `client.close()`-ing) whichever
// comes first.
const MOBBIN_CLIENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MOBBIN_CLIENT_CACHE_MAX_SIZE = 200;

// Backstop for an entry that gets retired (TTL/LRU) while still leased and
// then never released — a crashed request, a client that disconnects
// without the "close" event firing, etc. Force-closes it anyway after this
// grace period so a stuck lease can't pin a dead transport open forever.
// Comfortably longer than MCP_CONNECT_TIMEOUT_MS and than any single
// request is expected to run, including a slow research turn.
const RETIRE_FORCE_CLOSE_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  pending: Promise<CachedEntry>;
  expiresAt: number;
}

// Insertion order doubles as LRU order: `touch` deletes+re-inserts a key on
// every cache hit, so the least-recently-used entry is always the first one
// Map iteration yields.
const cache = new Map<string, CacheEntry>();

// Non-enumerable marker attached to every tools object handed back from
// getMCPTools, so releaseMCPTools(tools) can find its way back to the exact
// CachedEntry it was leased from — by object identity, never by re-deriving
// the cache key from the token. That matters because the cache key can be
// re-used by a NEWER entry while an OLDER one for the same key is still
// retiring (see evictIfCurrent below) — looking the entry up again by key
// at release time could hit the wrong one.
const RELEASE_SYMBOL = Symbol("mobbin-mcp-release");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function closeResolved(resolved: CachedEntry, reason: string): void {
  if (resolved.closed) return;
  resolved.closed = true;
  resolved.client
    .close()
    .then(() => console.log(`[mcp] Closed mobbin client (${reason})`))
    .catch((err) => {
      console.warn(`[mcp] Error closing mobbin client (${reason}):`, err);
    });
}

// Marks an already-resolved (or eventually-resolving) entry as retiring: it
// is no longer reachable via `cache`, but must not be closed out from under
// a request that is still mid-call on it. Closes immediately if nothing is
// using it, otherwise defers to releaseEntry (or the grace-period backstop).
function retireEntry(entry: CacheEntry, reason: string): void {
  entry.pending
    .then((resolved) => {
      resolved.retiring = true;
      if (resolved.refCount <= 0) {
        closeResolved(resolved, reason);
        return;
      }
      setTimeout(() => {
        if (!resolved.closed) {
          console.warn(
            `[mcp] Force-closing a retired mobbin client after ${RETIRE_FORCE_CLOSE_MS}ms grace ` +
              `period — a leaseholder never released it (${reason})`,
          );
          closeResolved(resolved, `${reason}-forced`);
        }
      }, RETIRE_FORCE_CLOSE_MS).unref?.();
    })
    .catch(() => {
      // The connection never succeeded — nothing was ever leased out of it,
      // so there is nothing to close.
    });
}

function releaseEntry(resolved: CachedEntry): void {
  resolved.refCount = Math.max(0, resolved.refCount - 1);
  if (resolved.retiring && resolved.refCount === 0) {
    closeResolved(resolved, "released-after-retire");
  }
}

/** Releases a lease acquired via getMCPTools — call exactly once per
 * getMCPTools() call whose tools may have been used, when the caller is
 * truly done with them (e.g. once the whole /api/chat request, including
 * every tool-loop step, has finished or aborted). A no-op for a tools
 * object with no Mobbin lease attached (no token was supplied, or it came
 * from a mock in tests), so it's always safe to call. */
export function releaseMCPTools(tools: Record<string, unknown>): void {
  const release = (tools as Record<PropertyKey, unknown>)[RELEASE_SYMBOL];
  if (typeof release === "function") {
    (release as () => void)();
  }
}

/** Copies the release hook from a Mobbin tools object onto the merged tools
 * object a caller actually keeps and returns (e.g. chatTurn.ts's `{
 * ...penTools, ...mcpTools, ... }`). Plain object-spread only copies
 * ENUMERABLE properties, and the release hook is deliberately non-enumerable
 * (so it never shows up in a `for...in`/JSON.stringify of the tool set) —
 * so without this, the hook would silently vanish the moment mcpTools is
 * spread into anything else, and releaseMCPTools would become a no-op for
 * every real caller. */
export function attachMobbinRelease(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): void {
  const release = (source as Record<PropertyKey, unknown>)[RELEASE_SYMBOL];
  if (typeof release === "function") {
    Object.defineProperty(target, RELEASE_SYMBOL, { value: release, enumerable: false });
  }
}

// Evicts by key unconditionally — safe only when the caller already knows
// `entry` IS the current occupant of `key` in `cache` (e.g. iterating a
// synchronous snapshot of `cache.entries()`, with no `await` in between).
function evict(key: string, reason: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  retireEntry(entry, reason);
}

// Evicts `entry` only if it is STILL the current occupant of `key`. Needed
// for any eviction triggered from inside an async continuation (e.g. a
// connect failure's `.catch`, which can run well after the failing entry
// was itself superseded by a newer, successful connect for the same key —
// the 10s MCP_CONNECT_TIMEOUT_MS window plus reconnect is more than enough
// time for that to happen under LRU/TTL churn). Evicting-by-key there would
// tear down the NEW, live entry instead of the dead one.
function evictIfCurrent(key: string, entry: CacheEntry, reason: string): void {
  if (cache.get(key) !== entry) return;
  cache.delete(key);
  retireEntry(entry, reason);
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of [...cache.entries()]) {
    if (entry.expiresAt <= now) evict(key, "ttl-expired");
  }
}

function enforceMaxSize(): void {
  while (cache.size > MOBBIN_CLIENT_CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    evict(oldestKey, "lru-evicted");
  }
}

function connectAndFetchTools(token: string, visionConfigured: boolean): Promise<CachedEntry> {
  return withTimeout(
    (async () => {
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: MOBBIN_SERVER.url,
          headers: { Authorization: `Bearer ${token}` },
        },
      });
      const tools = await client.tools();
      // Every tool gets the base sanitizer before the limit-clamp wrap —
      // sanitizeAllToolResults must see the tool map first so a tool nobody
      // thought to special-case still never leaks raw binary bytes.
      const sanitized = sanitizeAllToolResults(tools, visionConfigured);
      const wrapped = wrapMobbinTools(sanitized);
      console.log(`[mcp] Connected to ${MOBBIN_SERVER.name} at ${MOBBIN_SERVER.url}`);
      const resolved: CachedEntry = {
        client,
        tools: wrapped,
        refCount: 0,
        retiring: false,
        closed: false,
      };
      Object.defineProperty(wrapped, RELEASE_SYMBOL, {
        value: () => releaseEntry(resolved),
        enumerable: false,
      });
      return resolved;
    })(),
    MCP_CONNECT_TIMEOUT_MS,
    MOBBIN_SERVER.name,
    // A connect that finishes AFTER the timeout already gave up: nobody
    // holds a lease on it (it was never returned to a caller), so close it
    // immediately rather than leaking the transport.
    (late) => closeResolved(late, "connected-after-timeout"),
  );
}

// Wraps EVERY tool in an already-resolved (cached) Mobbin tools object so
// its result additionally gets dropRemainingImagesForVisionlessModel applied
// — or passes `tools` through by reference, UNCHANGED, when the model can
// see images. This must run OUTSIDE connectAndFetchTools/the CachedEntry:
// the client cache is keyed by token hash alone (one entry can be reused
// across many requests, over its 30-minute TTL, by the SAME user with a
// DIFFERENT model selected each time), but whether images should survive is
// a property of THIS request's selected model, not of the token. Baking it
// into the cached entry — as the base sanitizer's `visionConfigured` is,
// deliberately, since that only depends on server config, not the request —
// would let request N's model decide what request N+1 sees for the same
// user, for as long as the connect that happened to be live at request N's
// time survives. Applying this gate fresh on every getMCPTools() call (using
// this call's own `modelSupportsVision`) instead means two requests from the
// same user with different models get correctly different behavior even
// while sharing the identical underlying cached MCP client.
function gateImagesForVisionlessModel(
  tools: Record<string, unknown>,
  visionConfigured: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const typed = tool as McpTool | undefined;
    if (!typed || typeof typed.execute !== "function") {
      out[name] = tool;
      continue;
    }
    const originalExecute = typed.execute.bind(typed);
    out[name] = {
      ...typed,
      execute: async (input: unknown, options: unknown) => {
        const res = await originalExecute(input, options);
        return dropRemainingImagesForVisionlessModel(res, visionConfigured);
      },
    };
  }
  return out;
}

export async function getMCPTools(
  config: Config,
  opts: { mobbinAccessToken?: string; modelSupportsVision?: boolean } = {},
): Promise<Record<string, unknown>> {
  const token = opts.mobbinAccessToken;
  // No token → no Mobbin tools at all. Same outcome as an unset
  // REFERO_API_KEY used to be: the no-reference-tools path is already
  // exercised by every headless caller (the showcase runner, background
  // reviews) and every not-yet-connected user.
  if (!token) return {};

  // Whether analyze_image exists on THIS turn's tool set — decides both the
  // size sanitizer's wording (never name a tool that chatTurn.ts is about to
  // delete) and computed once per call. The client cache below is keyed by
  // token hash, not by this value, so a config change affecting
  // isVisionConfigured would only take effect for a token once its cached
  // client is evicted/reconnected — acceptable since VISION_MODEL is fixed
  // at boot in every real deployment.
  const visionConfigured = isVisionConfigured(config);

  // Whether the model selected for THIS request can read images at all —
  // reuses chatTurn.ts's own modelSupportsVision (the same function that
  // already gates get_screenshot) so there is exactly one source of truth
  // for "can this model see", never a second copy that could drift.
  // Defaults to true (pass images through unchanged) for any caller that
  // doesn't pass it — every existing test and the showcase runner, neither
  // of which ever reaches a Mobbin token anyway.
  const modelSupportsVision = opts.modelSupportsVision ?? true;

  pruneExpired();

  const key = hashToken(token);
  let entry = cache.get(key);
  if (entry) {
    touch(key, entry);
  } else {
    const pending = connectAndFetchTools(token, visionConfigured);
    entry = { pending, expiresAt: Date.now() + MOBBIN_CLIENT_CACHE_TTL_MS };
    cache.set(key, entry);
    enforceMaxSize();
    // A connect/tools failure must not pin a dead entry forever — evict it
    // so the next request for this same token retries from scratch. Keyed
    // by identity (evictIfCurrent), not by `key` alone: this `.catch` can
    // fire well after a newer, successful entry has replaced this failing
    // one for the same key (see evictIfCurrent's doc comment) — evicting by
    // key there would tear down the live replacement instead of the dead
    // original.
    const failedEntry = entry;
    failedEntry.pending.catch(() => evictIfCurrent(key, failedEntry, "connect-failed"));
  }

  try {
    const resolved = await entry.pending;
    resolved.refCount++;
    if (modelSupportsVision) {
      // Fast path: `resolved.tools` already carries RELEASE_SYMBOL
      // (non-enumerable, attached once in connectAndFetchTools) — returning
      // it by reference, unwrapped, means attachMobbinRelease finds it with
      // no extra work needed here.
      return resolved.tools;
    }
    // Vision-less model this turn: wrap fresh (never mutate or cache the
    // wrapped object — see gateImagesForVisionlessModel's doc comment) and
    // reattach the release hook, since object-spreading inside that wrap
    // drops the non-enumerable symbol just like the one in chatTurn.ts's
    // `{...penTools, ...mcpTools}` spread does.
    const gated = gateImagesForVisionlessModel(resolved.tools, visionConfigured);
    Object.defineProperty(gated, RELEASE_SYMBOL, {
      value: () => releaseEntry(resolved),
      enumerable: false,
    });
    return gated;
  } catch (err) {
    console.warn(`[mcp] Failed to fetch tools from ${MOBBIN_SERVER.name}:`, err);
    return {};
  }
}

export async function closeAllMCPClients(): Promise<void> {
  const entries = [...cache.entries()];
  cache.clear();

  await Promise.allSettled(
    entries.map(async ([key, entry]) => {
      try {
        const resolved = await entry.pending;
        // Unconditional: this is an explicit "shut everything down now"
        // (process shutdown, test teardown) — it deliberately does not wait
        // for refCount to drain the way TTL/LRU retirement does.
        if (resolved.closed) return;
        resolved.closed = true;
        await resolved.client.close();
        console.log(`[mcp] Closed client: ${key.slice(0, 8)}…`);
      } catch (err) {
        console.warn(`[mcp] Error closing client ${key.slice(0, 8)}…:`, err);
      }
    }),
  );
}
