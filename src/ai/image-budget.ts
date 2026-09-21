import type { ModelMessage, ToolResultPart } from "ai";
import {
  collectImageSlots,
  replaceImagePartsInOutput,
  type ImageSlot,
} from "./vision-messages.js";

// See docs/specs/2026-09-20-image-context-budget-design.md for the full
// design. In short: nothing before this pass bounds how many images ride
// along in the message history, and `applyVisionPreprocessing` only trims
// the vision-less / can't-carry-tool-result-images paths — the fully-native
// case (OpenRouter + a vision model, i.e. the shipped default) has NO cap at
// all. Every get_screenshot result stays in the history verbatim, so a
// 15-screenshot session resends ~15 full-size images on every subsequent
// request, including each tool-loop auto-continuation.
//
// Runs BEFORE applyVisionPreprocessing (see chatTurn.ts), collapsing old
// screenshots to stable text so vision preprocessing only ever considers
// what this pass left live.

// Worst case 8 live images (H + S - 1), ~14k visual tokens — plus the tail
// of one multi-image result, since a result's images are elided together
// and the walk stops rather than splitting one.
export const MAX_LIVE_TOOL_RESULT_IMAGES = 6;
export const TOOL_RESULT_ELISION_STEP = 3;

// WHY ONLY TOOL-RESULT IMAGES, and not the user's own attachments.
//
// Eliding an image replaces it with text that does not carry its content.
// For a screenshot that is a fair trade: the placeholder below tells the
// model how to get the pixels back, and get_screenshot will happily produce
// them again. A user attachment has no such tool — once it is gone from the
// history, nothing can reconstruct it, and "use the palette from the first
// image I sent" becomes unanswerable.
//
// An earlier draft elided attachments too, rendering a cached description
// from services/vision.ts in their place. Code review killed it on two
// counts, both correct. First, that cache is filled ONLY by describeImage(),
// which applyVisionPreprocessing calls only on the non-native paths — on the
// shipped default it is always empty, so the "description" branch never
// fired and every elided attachment became a contentless stub. Second,
// reading that cache at render time made the replacement text a function of
// mutable process-global state rather than of the history: an image
// described later (a re-taken identical screenshot, a re-attached file)
// would flip an older slot's text from placeholder to description, and an
// LRU eviction would flip it back — rewriting the middle of the history and
// invalidating the provider's cached prefix, which is the exact failure this
// whole design exists to avoid.
//
// So the replacement text here is a CONSTANT, and attachments are left
// alone. That leaves attachment growth unbounded on purpose; it is bounded
// in practice by MAX_IMAGE_PARTS (4 per message) and by the frontend
// downscaling attachments before upload, and bounding it properly means
// converting an attachment to a description instead of dropping it — see
// the spec's phase 2, not this pass.

// Deliberately constant: a pure function of nothing, so an elided slot's
// text is byte-identical on every later turn. The two variants differ only
// in the recovery advice, which is picked from `slot.label` — the
// tool-result kind covers every image-bearing tool result, not just
// get_screenshot (an MCP reference screen is labelled "Image"), and telling
// the model to screenshot the canvas because a Mobbin screen aged out would
// send it to do unrelated work — and add another tool-result slot doing it.
// Deliberately describes the ACTION ("take a fresh screenshot") instead of
// naming get_screenshot: chatTurn.ts drops that tool from the per-request
// tool set when the model can't see and no VISION_MODEL is configured, and
// the chat model is picked per chat — so a chat that took screenshots on a
// vision model and was then switched to a text-only one would otherwise be
// told to call a tool that is no longer there.
const SCREENSHOT_PLACEHOLDER =
  "[Screenshot omitted to save context — it aged out of the live-image window. Take a fresh screenshot if you need to see the current canvas.]";
const TOOL_IMAGE_PLACEHOLDER =
  "[Image from an earlier tool result omitted to save context — it aged out of the live-image window. Call the tool again if you need to see it.]";

function placeholderFor(slot: ImageSlot): string {
  return slot.label === "Screenshot" ? SCREENSHOT_PLACEHOLDER : TOOL_IMAGE_PLACEHOLDER;
}

// How many IMAGES may be spared at once — not how many slots.
//
// Slot-counting was wrong: one tool result is one slot but can carry a
// whole page of MCP previews, so "two rescued slots" could mean sixteen
// images staying live. A rescued slot's images are the exact amount by
// which the live-image ceiling rises above phase 1's H + S - 1, so the cap
// has to be denominated in the same unit as the ceiling. A side effect
// worth naming: a single result carrying more images than this cap can
// never be rescued at all, which is the right call — sparing a sixteen-
// image search result is not what this feature is for.
//
// Counted over candidates ALREADY cached as rescued (not a running total
// across the process) — see resolveImageRescues for exactly what this gates.
export const MAX_RESCUED_IMAGES = 2;

// C(N) = floor(max(0, N - H) / S) * S — the chronological index below which
// every slot is elided. Deliberately NOT "keep the H most recent": that form
// recomputes to a different cutoff every time a single new image arrives, so
// the slot sitting at the boundary flips between live and elided on every
// turn, rewriting its text and breaking the provider's cached prompt prefix
// at that point in history on every single request. Stepping the cutoff in
// multiples of S means C changes only once every S new images, and — since
// the formula is monotone non-decreasing in N, and history is only appended
// to — a slot elided once is never un-elided. Live count is bounded by
// H + S - 1: for N = H + k the cutoff is floor(k/S)*S, leaving H + (k mod S).
function cutoff(totalSlots: number, liveFloor: number, step: number): number {
  return Math.floor(Math.max(0, totalSlots - liveFloor) / step) * step;
}

/**
 * Replaces one image inside a tool result with `text`.
 *
 * A `content`-shaped output is an ARRAY of parts, and only some of them are
 * images — an MCP result routinely carries explanatory text alongside its
 * screenshots. Replacing the whole `output` with a single text part (what an
 * earlier draft did, mirroring applyVisionPreprocessing) would throw that
 * text away along with the pixels, so here the image parts are swapped
 * in place and every sibling part is preserved.
 *
 * All image parts of one result are elided together, because the result is
 * one slot and the budget counts slots. That is the conservative direction:
 * a multi-image result is worth more than one slot's budget, never less.
 */
// Filtered on `kind` and `imageCount` only — deliberately never on
// `slot.image`, which is a lazy getter that would JSON.parse or concatenate
// the ~1MB payload of every screenshot in the history just to answer a
// question `imageCount` already answers for free. A tool result carrying no
// image produces no slot at all (collectImageSlots bails when the count is
// 0), so error results and plain-text tool output can never inflate the
// budget and push a real screenshot out of the live window.
function toolResultImageSlots(messages: ModelMessage[]): ImageSlot[] {
  return collectImageSlots(messages).filter(
    (slot) => slot.kind === "tool-result" && slot.imageCount > 0,
  );
}

// Counted in IMAGES, not slots. One tool result is one slot but can carry
// several images (an MCP search returns a handful of previews), so a
// slot-based count would let eight results holding eight previews each stay
// live under a budget that advertises six images.
function elisionCutoff(slots: ImageSlot[]): number {
  const totalImages = slots.reduce((sum, slot) => sum + slot.imageCount, 0);
  return cutoff(totalImages, MAX_LIVE_TOOL_RESULT_IMAGES, TOOL_RESULT_ELISION_STEP);
}

/**
 * Walks the slot list oldest-first and decides which ones pure recency
 * would elide this turn, up to `elideUpToImages` IMAGES of budget.
 *
 * `rescued` (by `toolCallId`) is Jev's phase-2 addition: see
 * docs/specs/2026-09-21-jev-image-relevance-design.md's "Спасение СДВИГАЕТ
 * вытеснение" section. A rescued slot is SKIPPED, not kept live for free —
 * it consumes none of `elideUpToImages`, so the walk simply continues to
 * the next slot in line and elides THAT one instead: a rescue changes WHICH
 * images go, not — in the common case — how many. A version that instead
 * kept a rescued slot live AND left the budget unspent would let the live
 * count grow past the ceiling one rescue at a time.
 *
 * "Common case" is load-bearing, and the ceiling is NOT exactly `H + S - 1`
 * — the design doc retracts that claim explicitly. It holds only while each
 * slot carries one image. The walk stops at the first slot that would
 * overshoot, so skipping a rescued slot can bring an oversized multi-image
 * result up against the quota sooner and elide FEWER images than pure
 * recency would have. The honest bound is `(H + S - 1) + (images in rescued
 * slots) + (tail of one multi-image result)`. That is why
 * MAX_RESCUED_IMAGES is denominated in images, and why this function
 * re-caps `sparedImages` below instead of trusting its caller — neither is
 * redundant.
 *
 * Elision is still whole-slot: a result's images go together or not at all,
 * so the walk stops at the first (non-rescued) slot that would overshoot
 * the image budget rather than splitting it.
 */
function walkElisionPlan(
  slots: ImageSlot[],
  elideUpToImages: number,
  rescued?: ReadonlySet<string>,
): ImageSlot[] {
  const plan: ImageSlot[] = [];
  let elided = 0;
  // Re-capped HERE, not just where rescues are granted. imageRelevance.ts's
  // cap is read-then-await-then-write, so two overlapping turns for one
  // session can each grant up to the cap and leave twice that many cached.
  // The live-image ceiling is this function's promise to keep, so it
  // enforces the bound itself rather than trusting its input.
  let sparedImages = 0;
  for (const slot of slots) {
    if (
      rescued &&
      slot.toolCallId &&
      rescued.has(slot.toolCallId) &&
      sparedImages + slot.imageCount <= MAX_RESCUED_IMAGES
    ) {
      sparedImages += slot.imageCount;
      continue;
    }
    if (elided + slot.imageCount > elideUpToImages) break;
    elided += slot.imageCount;
    plan.push(slot);
  }
  return plan;
}

/**
 * The slots this turn's budget would elide. Called with no `rescued` it is
 * the PURE RECENCY plan — `applyImageBudget`'s own decision before any Jev
 * rescue is applied. Called WITH the resolved rescue set it is the FINAL
 * plan, which the caller needs in order to freeze those slots as decided:
 * a rescue shifts elision onto the next slot in line, and that victim was
 * never a candidate, so nothing else would ever record a verdict for it —
 * on a later turn it would show up as a FRESH candidate and Jev could
 * rescue it back to life, un-eliding an image and rewriting the middle of
 * the history. See imageRelevance.ts's freezeElidedSlots. Exported for
 * src/ai/imageRelevance.ts: these are the only slots Jev is ever allowed to
 * ask about, since it can rescue a slot recency was about to elide but can
 * never reach past the recency boundary and elide one recency would have
 * kept (see the design doc's "Спасение СДВИГАЕТ, а не отменяет" section —
 * candidates are bounded to the eviction zone by construction here, not by
 * a check downstream).
 */
export function planImageElision(
  messages: ModelMessage[],
  rescued?: ReadonlySet<string>,
): ImageSlot[] {
  const slots = toolResultImageSlots(messages);
  const elideUpToImages = elisionCutoff(slots);
  if (elideUpToImages === 0) return [];
  return walkElisionPlan(slots, elideUpToImages, rescued);
}

export interface ApplyImageBudgetOptions {
  /**
   * toolCallIds of slots Jev rescued this turn (imageRelevance.ts's
   * resolveImageRescues). A rescued slot is skipped during elision — see
   * walkElisionPlan's doc comment — never kept live "for free". Omitted or
   * empty behaves exactly like phase 1 (pure recency).
   */
  rescued?: ReadonlySet<string>;
}

/**
 * Collapses old tool-result images out of the message history before
 * `applyVisionPreprocessing` runs, using a step-wise hysteresis window. Pure:
 * depends only on `messages` and `opts.rescued`, reads no mutable state,
 * makes no network calls, and returns untouched messages by reference.
 *
 * `opts.rescued` must be computed BEFORE calling this — this function itself
 * makes no Jev call and has no opinion about relevance, only about which
 * candidate slots (see planImageElision) a caller already decided to spare.
 */
export function applyImageBudget(
  messages: ModelMessage[],
  opts: ApplyImageBudgetOptions = {},
): ModelMessage[] {
  const slots = toolResultImageSlots(messages);
  const elideUpToImages = elisionCutoff(slots);
  if (elideUpToImages === 0) return messages;

  const toElide = walkElisionPlan(slots, elideUpToImages, opts.rescued);
  if (toElide.length === 0) return messages;

  const touched = new Map<number, Map<number, ImageSlot>>();
  for (const slot of toElide) {
    const byPart = touched.get(slot.messageIndex) ?? new Map<number, ImageSlot>();
    byPart.set(slot.partIndex, slot);
    touched.set(slot.messageIndex, byPart);
  }

  return messages.map((message, messageIndex) => {
    const byPart = touched.get(messageIndex);
    if (!byPart || !Array.isArray(message.content)) return message; // untouched — same object
    const content = message.content.map((part, partIndex) => {
      const slot = byPart.get(partIndex);
      if (!slot) return part;
      const typed = part as ToolResultPart;
      return { ...typed, output: replaceImagePartsInOutput(typed.output, placeholderFor(slot)) };
    });
    return { ...message, content } as ModelMessage;
  });
}
