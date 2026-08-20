import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolApprovalResponse,
  ToolResultPart,
} from "ai";
import { getModels, type Config } from "../config.js";
import {
  describeImage,
  isVisionConfigured,
  peekCachedDescriptionByKey,
  peekCachedFailureByKey,
  visionCacheKey,
} from "../services/vision.js";
import { parseScreenshotDataUrl } from "./screenshotOutput.js";

// Budget for ONE turn — but of NEW vision calls, not of images total. The
// route caps images per *message* (MAX_IMAGE_PARTS, src/routes/chat.ts), but
// this pass walks the whole history, so a long conversation — or a
// hand-rolled request carrying a long one — would otherwise fan out one
// vision call per image ever attached. 8 is well past what any real turn
// needs (the composer allows 4 per message) while keeping the worst case
// bounded.
//
// Why "new calls" and not "images": an earlier version of this budget kept
// the N most-recent images by POSITION and replaced everything older with a
// constant placeholder. That silently broke provider prompt caching — the
// same image, at the same spot in history, would be a real description on
// turn N (when it was among the 8 newest) and flip to the placeholder text
// on turn N+1 (once newer images pushed it out), rewriting message content
// in the MIDDLE of the history and invalidating the cached prefix for
// everything after it. Budgeting new describeImage() *calls* instead means
// an already-described image (services/vision.ts's cache, checked via
// peekCachedDescription before any budget is spent) always renders the same
// text again, for free, no matter how old it is or how many newer images
// arrived since. Only images this pass has never described before compete
// for the budget, and only those can degrade to the placeholder.
export const MAX_DESCRIBED_IMAGES_PER_TURN = 8;

// Separate, and deliberately much larger, upper bound on how many FULL
// descriptions may be rendered into one turn's prompt at all — cache hits
// included. Budgeting only *new* describeImage() calls (above) fixed the
// prompt-cache-breaking bug, but it also removed the old cap on total
// rendered text: a vision-less model whose agent calls get_screenshot on
// many steps of a long conversation would, with every screenshot now
// permanently cached, drag every one of them back into every future
// request in full (up to VISION_MAX_TOKENS each) — history is never
// trimmed for this pass. This constant re-caps the total, independent of
// the new-call budget.
//
// This constant is in real tension with the stability goal this module
// exists for: any cap on total rendered descriptions means some image,
// once it ages out of the window, flips from a full description to the
// placeholder — the exact kind of mid-history text change that breaks a
// provider's cached prompt prefix. That is accepted, not hidden: crossing
// this limit costs exactly ONE cache-prefix break for the one image that
// falls out of the window that turn, which is far cheaper than the
// unbounded prompt growth of not having a limit at all. Setting it well
// above MAX_DESCRIBED_IMAGES_PER_TURN (24 vs. 8), rather than equal to it,
// is what keeps that break rare in practice: most real sessions stay under
// 24 distinct described images, so the window is rarely exceeded and the
// instability this trades away almost never triggers.
//
// 24 (vs. the previous position-based scheme's effective ~8) is a deliberate
// choice, confirmed in review rather than left as a guess: at up to
// VISION_MAX_TOKENS (1200) per description, 24 rendered descriptions is a
// worst case of ~29k tokens of every request, versus ~9.6k before. Two
// things keep that acceptable. First, 1200 is a ceiling on ONE description,
// not a typical one — most descriptions land well short of it, so ~29k is a
// worst case, not the common case. Second, and more importantly: after the
// first turn that renders a given image, its description text is
// byte-identical on every later turn (that is this whole module's job), so
// those tokens sit inside the provider's cached prompt prefix and are
// billed as cache reads, not fresh input — a fraction of the cost per
// token. Turning this cap back down to claw back some of that budget would
// instead buy back worst-case token count at the price of MORE FREQUENT
// cache-prefix breaks (see this constant's own comment above), and a broken
// prefix re-prices the ENTIRE history after the break at full fresh-token
// rates — which costs far more than the extra cached description tokens a
// generous cap here ever adds. Generous-and-usually-cached beats
// tight-and-frequently-invalidated.
export const MAX_RENDERED_DESCRIPTIONS = 24;

// Constant text for a slot collapsed purely because it fell outside the
// MAX_RENDERED_DESCRIPTIONS window (oldest-first) — deliberately a single
// fixed string rather than one that varies per slot, so this collapse is
// itself stable: an image that stays outside the window across turns keeps
// rendering byte-identical text, and only crossing the window boundary (not
// e.g. its exact position within the collapsed region) can change it.
const RENDER_LIMIT_PLACEHOLDER = `[Image omitted: this request already reached the limit of ${MAX_RENDERED_DESCRIPTIONS} rendered image descriptions in one turn. Ask for it again if you need it described.]`;

// Hermes bounds its vision workers the same way (auxiliary.vision
// max_concurrency). Describing is a network round trip per image, so some
// parallelism is worth it — but not "however many images the history holds".
const DESCRIBE_CONCURRENCY = 4;

// The one place that decides "native or text" for a given model — our
// analog of Hermes's decide_image_input_mode. Static, not a runtime probe:
// reuses the same DEFAULT_MODELS/getModels metadata that already powers
// GET /api/models and the allowlist check, so this can never disagree with
// what the model dropdown shows. A model with no built-in metadata (an
// operator-added extra via OPENROUTER_ALLOWED_MODELS) is assumed
// vision-capable, matching getModels' own convention.
export function modelSupportsVision(config: Config, modelId: string): boolean {
  const model = getModels(config).find((m) => m.id === modelId);
  return model ? model.supportsVision : true;
}

function isImageMediaType(mediaType: string | undefined): boolean {
  return typeof mediaType === "string" && mediaType.startsWith("image/");
}

// Normalizes the several shapes an ImagePart/FilePart's payload can take
// into a single string describeImage() can consume (a data: URL or an
// http(s) URL). Returns null when the payload isn't something we know how
// to turn into one (e.g. an already-consumed stream).
function toImageString(data: unknown, mediaType: string | undefined): string | null {
  if (data instanceof URL) return data.toString();
  if (typeof data === "string") {
    if (data.startsWith("data:") || /^https?:\/\//i.test(data)) return data;
    // Bare base64 payload — wrap it so describeImage() gets a real data: URL.
    return `data:${mediaType ?? "image/png"};base64,${data}`;
  }
  if (data instanceof Uint8Array) {
    return `data:${mediaType ?? "image/png"};base64,${Buffer.from(data).toString("base64")}`;
  }
  if (data instanceof ArrayBuffer) {
    return `data:${mediaType ?? "image/png"};base64,${Buffer.from(new Uint8Array(data)).toString("base64")}`;
  }
  return null;
}

// By the time this pass runs, a get_screenshot result has already been through
// the tool's own `toModelOutput` (src/ai/tools.ts), which promotes the
// handler's `JSON.stringify({ imageData })` into a real image part so a
// vision-capable model actually sees the picture. So the shape here is usually
// `{type:"content", value:[{type:"image-data", data, mediaType}]}` — and that
// part is exactly what must NOT survive for a vision-less model. The
// text/json/object shapes are still handled, since toModelOutput passes an
// error result through untouched and older histories may predate it.
function extractScreenshotDataUrl(output: ToolResultPart["output"]): string | null {
  if (output.type === "content") {
    for (const part of output.value) {
      if (part.type === "image-data" || part.type === "file-data" || part.type === "media") {
        if (!part.mediaType.startsWith("image/")) continue;
        return `data:${part.mediaType};base64,${part.data}`;
      }
    }
    return null;
  }
  const raw = "value" in output ? output.value : undefined;
  return parseScreenshotDataUrl(raw)?.dataUrl ?? null;
}

// One image found in the message list, addressed by its position so the
// rewrite pass can put the resulting text back exactly where it came from.
interface ImageSlot {
  messageIndex: number;
  partIndex: number;
  /** null when the payload isn't a shape we can describe. */
  image: string | null;
  /**
   * visionCacheKey(image) — this module never passes a `question`, so this
   * is the ONE place the (up to 6MB) image string gets hashed. Every other
   * lookup below (success cache, failure cache, describeImage()) reuses this
   * key instead of re-hashing the same string, since hashing runs
   * synchronously on the event loop before streamText(). null iff image is
   * null.
   */
  key: string | null;
  /** "Image" (user attachment) or "Screenshot" (get_screenshot result). */
  label: string;
  kind: "user-part" | "tool-result";
}

function makeSlot(
  messageIndex: number,
  partIndex: number,
  image: string | null,
  label: string,
  kind: ImageSlot["kind"],
): ImageSlot {
  return {
    messageIndex,
    partIndex,
    image,
    key: image ? visionCacheKey(image) : null,
    label,
    kind,
  };
}

function collectImageSlots(messages: ModelMessage[]): ImageSlot[] {
  const slots: ImageSlot[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    if (message.role === "user") {
      message.content.forEach((part, partIndex) => {
        const typed = part as TextPart | ImagePart | FilePart;
        if (typed.type === "image") {
          slots.push(
            makeSlot(
              messageIndex,
              partIndex,
              toImageString(typed.image, typed.mediaType),
              "Image",
              "user-part",
            ),
          );
        } else if (typed.type === "file" && isImageMediaType(typed.mediaType)) {
          slots.push(
            makeSlot(
              messageIndex,
              partIndex,
              toImageString(typed.data, typed.mediaType),
              "Image",
              "user-part",
            ),
          );
        }
      });
      return;
    }
    if (message.role === "tool") {
      message.content.forEach((part, partIndex) => {
        const typed = part as ToolResultPart | ToolApprovalResponse;
        if (typed.type !== "tool-result" || typed.toolName !== "get_screenshot") return;
        const dataUrl = extractScreenshotDataUrl(typed.output);
        if (!dataUrl) return; // an error result is already plain text
        slots.push(makeSlot(messageIndex, partIndex, dataUrl, "Screenshot", "tool-result"));
      });
    }
  });
  return slots;
}

// Runs `worker` over `items` with at most `limit` in flight, preserving order.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// The one place that formats a successful description into the text that
// replaces an image slot. Used for a freshly-described slot, a cache hit
// (peekCachedDescriptionByKey), AND every slot in a deduplicated budget unit
// — always called per-SLOT with that slot's own label, never once per unit.
// Two slots can share one underlying image (and thus one describeImage()
// call / one cache entry) while carrying different labels — e.g. the same
// screenshot re-appearing as both a user attachment ("Image") and a
// get_screenshot result ("Screenshot") — and each must still render with
// its OWN label. If either path formatted once and copied the string, or
// formatted a fresh vs. cached render differently, the two renders of the
// same slot would diverge, which is exactly the prompt-cache-breaking bug
// this module exists to avoid, just moved to a new seam.
function formatDescription(slot: ImageSlot, text: string): string {
  return `[${slot.label}: visual description]\n${text}`;
}

// The one place that formats a FAILED description (fresh or cache-replayed)
// into slot text. Same reasoning as formatDescription(): a cache hit off
// peekCachedFailureByKey() must render byte-identical text to what the
// original failing call produced, or a still-failing image's text would
// drift the moment it starts being served from the negative cache. Failure
// text carries no per-slot label, so (unlike formatDescription) it happens
// to be safe to share verbatim across slots of one unit — but it is still
// applied per-slot below for symmetry with formatDescription and so a label
// could be added here later without silently reintroducing the bug.
function formatFailure(text: string): string {
  return `[Image attached but could not be analyzed: ${text}]`;
}

// Describes ONE budget unit (a deduplicated image, one describeImage() call
// for however many slots share it) and returns the RAW result — never
// formatted here. Formatting happens per-slot at the call site, via
// formatDescription/formatFailure, so that slots sharing a unit but
// carrying different labels each get their own correctly-labeled text.
async function describeUnitImage(
  slot: ImageSlot,
  config: Config,
): Promise<{ ok: boolean; text: string }> {
  // Callers only ever pass a slot with usable image data — slots with
  // slot.image === null are resolved directly (formatFailure, no
  // describeImage call, no budget spent) before units are even built. See
  // the "unsupported image data" branch in applyVisionPreprocessing.
  return describeImage({ image: slot.image as string, config, key: slot.key as string });
}

/**
 * Our analog of Hermes's per-message image handling in
 * `decide_image_input_mode`, run once right before `streamText()` sees the
 * messages. A vision-capable model gets the array back untouched (native
 * path, no allocation) — otherwise every image, wherever it appears (a user
 * attachment or a `get_screenshot` tool result), is replaced by a text
 * description before this function returns.
 *
 * INVARIANT: no ImagePart/image-bearing FilePart may survive into the
 * returned array for a vision-less model. That gap is a real bug class in
 * Hermes (a raw `image_url` reaching a text-only model and erroring the
 * provider call), and this is the one place it is closed. Note the invariant
 * holds even when the per-turn budget is exceeded or a description fails —
 * both replace the image with text rather than leaving it in place.
 *
 * BUDGET SEMANTICS: four separate phases apply, in this order.
 *
 * 1. MAX_RENDERED_DESCRIPTIONS caps how many slots total (any source: cache
 *    hit or fresh call) may render a full description in one turn — the
 *    oldest slots beyond that window collapse to RENDER_LIMIT_PLACEHOLDER
 *    unconditionally, without even a cache lookup. See that constant's
 *    comment for why this cap still exists, and why it is set well above
 *    the per-turn new-call budget rather than equal to it.
 * 2. Within the rendered window, a slot with NO usable image data
 *    (slot.image === null — the payload wasn't a shape we could turn into a
 *    data/http URL) is resolved immediately to a constant "unsupported
 *    format" failure text and removed from consideration entirely. This
 *    never calls describeImage() (there is nothing to describe) and never
 *    spends the MAX_DESCRIBED_IMAGES_PER_TURN budget — a history containing
 *    several such slots must not starve the real, describable images later
 *    in that same history out of their budget.
 * 3. Every remaining slot is checked against services/vision.ts's caches —
 *    both the success cache (peekCachedDescriptionByKey) and the negative
 *    cache (peekCachedFailureByKey) — before spending anything. A hit of
 *    either kind is rendered with the exact same formatting a fresh call
 *    would produce (formatDescription / formatFailure) and never competes
 *    for the MAX_DESCRIBED_IMAGES_PER_TURN budget. The negative-cache check
 *    is what keeps a permanently-failing image from re-running the full
 *    VISION_TIMEOUT_MS-bounded describeImage() call — and re-stalling the
 *    turn — on every single request. (services/vision.ts itself only
 *    negatively caches a TIMEOUT or an empty model response, not an
 *    ordinary thrown provider error — see describeImage()'s catch block —
 *    so a transient provider blip gets a fresh shot on the very next turn
 *    instead of being pinned to "known bad" for the failure-cache TTL.)
 * 4. What's left (never described, never failed-and-cached) is deduplicated
 *    by image string — two slots carrying the same not-yet-cached image
 *    (e.g. the same screenshot appearing as both a user attachment and a
 *    get_screenshot result) collapse to a single describeImage() call. The
 *    RAW result (ok/text, not yet formatted) is then formatted separately
 *    for EACH slot in the unit with that slot's own label
 *    (formatDescription/formatFailure) — never formatted once and copied,
 *    since two slots sharing an image can carry different labels (see
 *    formatDescription's comment). Without the dedup itself, duplicate
 *    slots would each spend a budget unit and each get an
 *    independently-generated (thus almost certainly different) description,
 *    corrupting the very stability this pass exists to protect the moment
 *    one of the two copies is later served from cache and the other isn't.
 *    The deduplicated units are then budgeted against
 *    MAX_DESCRIBED_IMAGES_PER_TURN by each unit's NEWEST slot (its highest
 *    chronological position) — not its oldest/first-occurrence slot — so
 *    that a just-reattached image which happens to also appear earlier in
 *    the history is ranked by "just reattached", matching the documented
 *    "newest images win" budget semantics. The units that lose ranking
 *    degrade to a constant placeholder.
 *
 * Together, this is what keeps a given image's text byte-identical across
 * turns (and thus keeps the provider's prompt-cache prefix intact through
 * that point in history) regardless of how many newer images have shown up
 * since it was first described.
 *
 * Residual risk: both vision.ts caches are in-process and capped in size
 * (CACHE_MAX_ENTRIES / FAILURE_CACHE_MAX_ENTRIES) and the failure cache also
 * expires on a TTL. A server restart, a cache eviction, or a failure entry
 * aging out can still make a previously-stable slot's text change on a
 * later turn — this pass only guarantees stability while the underlying
 * cache entry survives, not forever.
 */
export async function applyVisionPreprocessing(
  messages: ModelMessage[],
  opts: { config: Config; modelId: string },
): Promise<ModelMessage[]> {
  const { config, modelId } = opts;
  if (modelSupportsVision(config, modelId)) return messages;

  const slots = collectImageSlots(messages); // chronological: index N is older than index N+1
  if (slots.length === 0) return messages;

  const texts = new Map<string, string>();
  const key = (slot: ImageSlot) => `${slot.messageIndex}:${slot.partIndex}`;

  // Phase 0: total-render cap. The oldest slots beyond MAX_RENDERED_DESCRIPTIONS
  // collapse unconditionally — no cache lookup, no budget spent — leaving only
  // the newest MAX_RENDERED_DESCRIPTIONS slots to go through the rest of the
  // pipeline below.
  const overRenderLimit = Math.max(0, slots.length - MAX_RENDERED_DESCRIPTIONS);
  const collapsedByRenderLimit = slots.slice(0, overRenderLimit);
  const renderable = slots.slice(overRenderLimit);
  for (const slot of collapsedByRenderLimit) {
    texts.set(key(slot), RENDER_LIMIT_PLACEHOLDER);
  }

  // Phase 1.5: slots with no usable image data at all resolve immediately —
  // describeSlot/describeImage would never be called for these anyway (a
  // deterministic "unsupported format" text), so settle them before the
  // budget is even computed. They must not compete with real, describable
  // images for MAX_DESCRIBED_IMAGES_PER_TURN.
  const describable: ImageSlot[] = [];
  for (const slot of renderable) {
    if (slot.image) {
      describable.push(slot);
    } else {
      texts.set(key(slot), formatFailure("unsupported image data format"));
    }
  }

  // Phase 2: free, stable renders for anything already in either vision.ts
  // cache — regardless of position or age within the renderable window. A
  // cached image (success or failure) never falls back to a fresh call just
  // because newer images arrived since. Every slot here has slot.key set
  // (non-null), computed once in collectImageSlots — reused here instead of
  // re-hashing the image string.
  const uncached: ImageSlot[] = [];
  for (const slot of describable) {
    const cachedOk = peekCachedDescriptionByKey(slot.key as string);
    if (cachedOk !== undefined) {
      texts.set(key(slot), formatDescription(slot, cachedOk));
      continue;
    }
    const cachedFail = peekCachedFailureByKey(slot.key as string);
    if (cachedFail !== undefined) {
      texts.set(key(slot), formatFailure(cachedFail));
      continue;
    }
    uncached.push(slot);
  }

  // Phase 3: deduplicate the remaining slots by image string before
  // spending any budget — two slots sharing the same not-yet-cached image
  // must resolve to one describeImage() call, though each still gets its
  // own formatted text below (see formatDescription's comment: shared image,
  // possibly different labels). ranked tracks each unit's NEWEST slot
  // (highest index seen while walking `uncached`, which preserves the
  // chronological order collectImageSlots produced) so budgeting ranks a
  // unit by its most-recently-attached occurrence, not its first/oldest one.
  interface BudgetUnit {
    slots: ImageSlot[];
    newestSeq: number;
  }
  const unitsByImage = new Map<string, BudgetUnit>();
  const units: BudgetUnit[] = [];
  uncached.forEach((slot, seq) => {
    const image = slot.image as string;
    let unit = unitsByImage.get(image);
    if (!unit) {
      unit = { slots: [], newestSeq: seq };
      unitsByImage.set(image, unit);
      units.push(unit);
    }
    unit.slots.push(slot);
    unit.newestSeq = Math.max(unit.newestSeq, seq);
  });

  // Phase 4: spend the budget only on units that still need a real
  // describeImage() call, ranked by each unit's newest slot — the units
  // whose most recent occurrence is oldest lose the budget first.
  const rankedOldestNewestFirst = units.slice().sort((a, b) => a.newestSeq - b.newestSeq);
  const overBudget = Math.max(0, units.length - MAX_DESCRIBED_IMAGES_PER_TURN);
  const skipped = new Set(rankedOldestNewestFirst.slice(0, overBudget));
  const described = units.filter((unit) => !skipped.has(unit));

  const budgetPlaceholder = `[Image omitted: this request already used its budget of ${MAX_DESCRIBED_IMAGES_PER_TURN} new image descriptions. Ask for it again if you need it described.]`;
  for (const unit of skipped) {
    for (const slot of unit.slots) texts.set(key(slot), budgetPlaceholder);
  }
  const results = await mapWithConcurrency(described, DESCRIBE_CONCURRENCY, (unit) =>
    describeUnitImage(unit.slots[0], config),
  );
  described.forEach((unit, i) => {
    const { ok, text } = results[i];
    for (const slot of unit.slots) {
      texts.set(key(slot), ok ? formatDescription(slot, text) : formatFailure(text));
    }
  });

  // Rebuild only the messages that actually carry an image.
  const touched = new Map<number, ImageSlot[]>();
  for (const slot of slots) {
    const list = touched.get(slot.messageIndex) ?? [];
    list.push(slot);
    touched.set(slot.messageIndex, list);
  }

  return messages.map((message, messageIndex) => {
    const messageSlots = touched.get(messageIndex);
    if (!messageSlots || !Array.isArray(message.content)) return message;
    const byPart = new Map(messageSlots.map((slot) => [slot.partIndex, slot]));
    const content = message.content.map((part, partIndex) => {
      const slot = byPart.get(partIndex);
      if (!slot) return part;
      const text = texts.get(key(slot)) ?? "[Image attached but could not be analyzed.]";
      if (slot.kind === "tool-result") {
        return { ...(part as ToolResultPart), output: { type: "text" as const, value: text } };
      }
      return { type: "text" as const, text };
    });
    return { ...message, content } as ModelMessage;
  });
}

// Re-exported so callers that only need the "is vision available at all"
// question (as opposed to "is THIS model vision-capable") don't need a
// separate import of services/vision.js just for this one check.
export { isVisionConfigured };
