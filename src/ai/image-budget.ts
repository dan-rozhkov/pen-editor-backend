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
/**
 * Collapses old tool-result images out of the message history before
 * `applyVisionPreprocessing` runs, using a step-wise hysteresis window. Pure:
 * depends only on `messages`, reads no mutable state, makes no network
 * calls, and returns untouched messages by reference.
 */
export function applyImageBudget(messages: ModelMessage[]): ModelMessage[] {
  // Filtered on `kind` and `imageCount` only — deliberately never on
  // `slot.image`, which is a lazy getter that would JSON.parse or
  // concatenate the ~1MB payload of every screenshot in the history just to
  // answer a question `imageCount` already answers for free. A tool result
  // carrying no image produces no slot at all (collectImageSlots bails when
  // the count is 0), so error results and plain-text tool output can never
  // inflate the budget and push a real screenshot out of the live window.
  const slots = collectImageSlots(messages).filter(
    (slot) => slot.kind === "tool-result" && slot.imageCount > 0,
  );

  // Counted in IMAGES, not slots. One tool result is one slot but can carry
  // several images (an MCP search returns a handful of previews), so a
  // slot-based count would let eight results holding eight previews each
  // stay live under a budget that advertises six images.
  const totalImages = slots.reduce((sum, slot) => sum + slot.imageCount, 0);
  const elideUpToImages = cutoff(
    totalImages,
    MAX_LIVE_TOOL_RESULT_IMAGES,
    TOOL_RESULT_ELISION_STEP,
  );
  if (elideUpToImages === 0) return messages;

  // Elision is still whole-slot: a result's images go together or not at
  // all, so walk the prefix and stop at the first slot that would overshoot
  // the image budget rather than splitting it. Monotone for the same reason
  // the cutoff is — older slots' image counts never change.
  const touched = new Map<number, Map<number, ImageSlot>>();
  let elided = 0;
  for (const slot of slots) {
    if (elided + slot.imageCount > elideUpToImages) break;
    elided += slot.imageCount;
    const byPart = touched.get(slot.messageIndex) ?? new Map<number, ImageSlot>();
    byPart.set(slot.partIndex, slot);
    touched.set(slot.messageIndex, byPart);
  }
  if (touched.size === 0) return messages;

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
