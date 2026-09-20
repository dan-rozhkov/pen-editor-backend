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
import { parseModelRef, providerHandlesToolResultImages } from "./modelRef.js";

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
// model an operator pointed CHAT_MODEL at, or a showcase CLI
// --model override) is assumed
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

// By the time this pass runs, an image-bearing tool result has already been
// through that tool's own `toModelOutput`, which promotes a raw image
// payload into a real image part so a vision-capable model actually sees
// the picture. For get_screenshot that's src/ai/tools.ts's own
// `toModelOutput`, promoting the handler's `JSON.stringify({ imageData })`.
// For every MCP tool (Mobbin included) it's `mcpToModelOutput`
// (@ai-sdk/mcp), which promotes an MCP `{type:"image", data, mimeType}`
// content part into exactly the same `image-data` shape — confirmed by
// reading node_modules/@ai-sdk/mcp/dist/index.js's mcpToModelOutput, which
// is wired onto every tool the client returns, not only the ones this repo
// hand-wraps. So regardless of which tool produced it, the shape here is
// usually `{type:"content", value:[{type:"image-data", data, mediaType}]}`
// — and that part is exactly what must NOT survive for a vision-less model
// or a provider that can't carry a tool-result image. The text/json/object
// shapes are still handled, since toModelOutput passes an error result
// through untouched and older histories may predate it.
//
// Belt-and-suspenders with src/ai/mcp.ts's sanitizeMcpToolResult, which
// already strips MCP image content at the SOURCE (before it ever becomes a
// ToolResultPart) — this function is the backstop for any image that gets
// here anyway: a tool this module doesn't know is MCP-backed, a future
// client-executed tool that returns image bytes, or a sanitizer bug. The
// INVARIANT on applyVisionPreprocessing above is what this backstop exists
// to hold even when the primary defense has a gap.
//
// Returns the image parts of a tool result, cheaply: `count` is computed
// without allocating anything image-sized, while `first()` builds the actual
// data URL only when a caller asks for it. The split exists because
// applyImageBudget walks every slot in the history to decide what stays live
// but never needs a payload — it only counts — whereas
// applyVisionPreprocessing needs the payload for the handful of slots it
// actually describes. Materializing every ~1MB screenshot up front made that
// cost unconditional for every request, synchronously before streamText().
interface ToolResultImages {
  count: number;
  first: () => string | null;
}

const NO_IMAGES: ToolResultImages = { count: 0, first: () => null };

/** An MCP content part, as it survives convertToModelMessages. */
interface McpImagePart {
  type: string;
  data?: unknown;
  mimeType?: unknown;
}

/**
 * The three image-bearing MCP content shapes, kept in step with
 * src/ai/mcp.ts's own extractBinaryField — which sanitizes exactly these:
 * `{type:"image", data, mimeType}`, the rarer `{type:"file", data,
 * mimeType:"image/…"}` some servers emit for an attachment, and
 * `{type:"resource", resource:{blob, mimeType}}`. Missing any of them
 * reopens the INVARIANT gap this whole branch exists to close.
 */
function mcpImagePayload(part: unknown): { data: string; mediaType: string } | null {
  if (!part || typeof part !== "object") return null;
  const typed = part as McpImagePart & { resource?: unknown };
  const mediaTypeOf = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.startsWith("image/") ? value : fallback;

  if (typed.type === "image" && typeof typed.data === "string") {
    return { data: typed.data, mediaType: mediaTypeOf(typed.mimeType, "image/png") };
  }
  if (
    typed.type === "file" &&
    typeof typed.data === "string" &&
    typeof typed.mimeType === "string" &&
    typed.mimeType.startsWith("image/")
  ) {
    // Unlike `image`, a `file` part is only an image when it says so — a
    // PDF attachment arrives in this same shape.
    return { data: typed.data, mediaType: typed.mimeType };
  }
  if (typed.type === "resource" && typed.resource && typeof typed.resource === "object") {
    const resource = typed.resource as { blob?: unknown; mimeType?: unknown };
    if (
      typeof resource.blob === "string" &&
      typeof resource.mimeType === "string" &&
      resource.mimeType.startsWith("image/")
    ) {
      return { data: resource.blob, mediaType: resource.mimeType };
    }
  }
  return null;
}

/**
 * The MCP content array inside a `json`-shaped tool result, or null.
 *
 * VERIFIED, not assumed: `prepareChatTurn` calls `convertToModelMessages`
 * WITHOUT `{ tools }`, and the SDK only applies a tool's `toModelOutput`
 * when the tool object is supplied. So the `content`-shaped output the
 * branch below handles is NOT what an MCP result actually looks like by the
 * time it reaches this module on a later turn — it arrives as
 * `{type:"json", value:{content:[{type:"image", data, mimeType}]}}`.
 * Without this branch, MCP images were invisible to both passes: never
 * budgeted, and (worse) never converted to text for a vision-less model,
 * silently violating applyVisionPreprocessing's own INVARIANT.
 */
function mcpContentParts(output: ToolResultPart["output"]): unknown[] | null {
  if (output.type !== "json") return null;
  const value = output.value as { content?: unknown } | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.content)) return null;
  return value.content;
}

function extractToolResultImages(
  output: ToolResultPart["output"],
  toolName: string,
): ToolResultImages {
  // STRUCTURED path: `output.type === "content"` with an image-shaped part.
  // Safe to widen to any tool — see collectImageSlots' comment — because
  // this shape only ever arrives via a real toModelOutput promotion, never
  // by a plain tool just happening to embed base64 in its text. Kept even
  // though the call site does not currently produce it (see
  // mcpContentParts' comment): passing `tools` to convertToModelMessages
  // would bring it back, and this is the defense that must not have a gap.
  if (output.type === "content") {
    const parts = output.value.filter(
      (part) =>
        (part.type === "image-data" || part.type === "file-data" || part.type === "media") &&
        part.mediaType.startsWith("image/"),
    );
    if (parts.length === 0) return NO_IMAGES;
    return {
      count: parts.length,
      first: () => {
        const part = parts[0] as { mediaType: string; data: unknown };
        return `data:${part.mediaType};base64,${String(part.data)}`;
      },
    };
  }

  // MCP path — the shape production actually sees. Widened to any tool for
  // the same reason as the structured branch: it is a typed content array,
  // not prose that merely happens to contain base64.
  const mcpParts = mcpContentParts(output);
  if (mcpParts) {
    const images = mcpParts.map(mcpImagePayload).filter((p) => p !== null);
    if (images.length === 0) return NO_IMAGES;
    return {
      count: images.length,
      first: () => `data:${images[0].mediaType};base64,${images[0].data}`,
    };
  }

  // LOOSE fallback: a plain string/text output run through
  // parseScreenshotDataUrl(), which for a bare string ends in fromDataUrl()
  // — an UNANCHORED regex that matches `data:image/...;base64,...` ANYWHERE
  // inside the text. Every client-executed tool returning a string arrives
  // in exactly this `{type:"text", value:"<whole string>"}` shape, so
  // widening this branch to any tool (not just get_screenshot) would let
  // read_embed_html/read_repo_files/read_design_repo's ENTIRE HTML/text
  // output get replaced by an image caption the moment it merely contains
  // one inline `data:image/svg+xml;base64,...` icon — the model loses the
  // markup it needs to edit and a describeImage budget unit is burned for
  // nothing. get_screenshot is the one tool whose whole string payload is
  // KNOWN to be `JSON.stringify({imageData: "<data url>"})` or an error
  // object (see screenshotOutput.ts's own doc comment) — never prose that
  // might innocently contain a data: URL — so this fallback stays gated to
  // it specifically.
  if (toolName !== "get_screenshot") return NO_IMAGES;
  const raw = "value" in output ? output.value : undefined;
  // The probe is the cheap half: parseScreenshotDataUrl() JSON.parse()s a
  // string output, and a get_screenshot payload is ~1MB of base64, so the
  // parse allocates a second copy of the whole thing. An error result
  // (`{"error": "..."}`) can never contain a data URL, so this substring
  // scan rules those out without allocating. Checks for the `data:image/`
  // prefix rather than the `imageData` key so a bare-data-URL output (the
  // non-JSON branch parseScreenshotDataUrl also supports) still counts.
  if (typeof raw === "string") {
    if (!raw.includes("data:image/")) return NO_IMAGES;
    // Count without parsing; the parse itself is deferred to first().
    return { count: 1, first: () => parseScreenshotDataUrl(raw)?.dataUrl ?? null };
  }
  // A non-string output (an already-parsed object, or a json/error-json
  // shape) has no 1MB string to avoid parsing, so resolve it right here
  // rather than promising an image that first() would then resolve to null.
  // Reporting a phantom image would both inflate applyImageBudget's count —
  // pushing a real screenshot out of the live window — and make phase 1.5
  // below overwrite a genuine error result with "unsupported image data
  // format", destroying the error text the model needs.
  const resolved = parseScreenshotDataUrl(raw)?.dataUrl ?? null;
  if (!resolved) return NO_IMAGES;
  return { count: 1, first: () => resolved };
}

// ── Rewriting a tool result's images ────────────────────────────────────
//
// Shared by BOTH passes (this module and image-budget.ts) because both have
// the same job at this seam: take one tool result and put text where its
// images were. It must be one definition — applyVisionPreprocessing used to
// replace the WHOLE `output` with a single text part, which was harmless
// while only get_screenshot produced slots (its output IS the image and
// nothing else) and became destructive the moment MCP results started
// producing slots too: a Mobbin result carries app names and urls in a text
// part next to its previews, and collapsing the output threw all of that
// away along with every image past the first.

const ADDITIONAL_IMAGE_NOTE =
  "[Additional image in this tool result omitted — only the first was processed.]";

function isImageContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const typed = part as { type?: unknown; mediaType?: unknown };
  if (typed.type === "image-data" || typed.type === "file-data" || typed.type === "media") {
    return typeof typed.mediaType === "string" && typed.mediaType.startsWith("image/");
  }
  // A url-shaped part carries a `url`, not a payload, and only `image-url`
  // is an image by its own type — `file-url` needs an explicit image
  // mediaType, or a `file-url` pointing at a PDF would be silently replaced
  // by an image placeholder.
  if (typed.type === "image-url") return true;
  if (typed.type === "file-url") {
    return typeof typed.mediaType === "string" && typed.mediaType.startsWith("image/");
  }
  return mcpImagePayload(part) !== null;
}

/**
 * Replaces every image part of `output` with text, preserving each sibling
 * part verbatim.
 *
 * The first image becomes `text`; any further image in the SAME result
 * becomes a constant note, because the slot — and therefore the description
 * or placeholder the caller computed — stands for the first image only.
 * They must still be replaced rather than left alone: a surviving raw image
 * part is exactly the INVARIANT violation this module exists to prevent.
 */
export function replaceImagePartsInOutput(
  output: ToolResultPart["output"],
  text: string,
): ToolResultPart["output"] {
  const rewrite = (parts: unknown[]): unknown[] => {
    let seen = 0;
    return parts.map((part) => {
      if (!isImageContentPart(part)) return part;
      seen += 1;
      return { type: "text", text: seen === 1 ? text : ADDITIONAL_IMAGE_NOTE };
    });
  };

  if (output.type === "content") {
    return { type: "content", value: rewrite(output.value) } as ToolResultPart["output"];
  }

  const mcpParts = mcpContentParts(output);
  if (mcpParts) {
    // mcpContentParts already established this is the `json` shape, so
    // `value` is present — the union as a whole doesn't know that.
    const value = (output as { value: Record<string, unknown> }).value;
    return {
      type: "json",
      value: { ...value, content: rewrite(mcpParts) },
    } as ToolResultPart["output"];
  }

  // A string/JSON-string output (get_screenshot's own shape) IS the image
  // and nothing else — see screenshotOutput.ts — so the whole output goes.
  return { type: "text", value: text };
}

// One image found in the message list, addressed by its position so the
// rewrite pass can put the resulting text back exactly where it came from.
// Exported for src/ai/image-budget.ts, which walks the SAME slots to decide
// what stays live before this module ever sees them — see that module's
// doc comment for why the extraction logic must not be duplicated.
export interface ImageSlot {
  messageIndex: number;
  partIndex: number;
  /**
   * The image payload as a data URL, or null when it isn't a shape we can
   * describe. LAZY: reading this may JSON.parse or concatenate a ~1MB
   * payload, so a caller that only needs to know how many images a slot
   * carries must read {@link imageCount} instead. Memoized.
   */
  image: string | null;
  /**
   * How many images this slot's part actually carries — 1 for a user
   * attachment or a get_screenshot result, but an MCP result can carry
   * several. Cheap: computed without touching any payload. This, not the
   * slot count, is what a budget must count, or a result holding eight
   * previews would be charged the same as a single screenshot.
   */
  imageCount: number;
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

// A user attachment is always exactly one image; the payload stays lazy for
// the same reason a tool result's does.
function oneUserImage(resolve: () => string | null): ToolResultImages {
  return { count: 1, first: resolve };
}

function makeSlot(
  messageIndex: number,
  partIndex: number,
  images: ToolResultImages,
  label: string,
  kind: ImageSlot["kind"],
): ImageSlot {
  // `key` is a LAZY, memoized getter rather than an eagerly computed field.
  // visionCacheKey() is a sha256 over the whole image string — up to
  // MAX_DATA_URL_BYTES (6MB) each — run synchronously on the event loop
  // before streamText(), which is exactly what that function's own comment
  // warns about. Every caller of collectImageSlots walks ALL slots but needs
  // the key for only some of them: applyVisionPreprocessing drops slots to
  // the render limit and settles cache hits before it ever looks one up, and
  // applyImageBudget never needs a key at all. Hashing every slot up front
  // made that cost unconditional for every request the moment
  // applyImageBudget started calling this on the vision-native fast path,
  // which previously returned before collectImageSlots ran. Memoized so the
  // repeated lookups in applyVisionPreprocessing's phase 2 still hash once.
  let keyMemo: string | null | undefined;
  let imageMemo: string | null | undefined;
  return {
    messageIndex,
    partIndex,
    imageCount: images.count,
    get image(): string | null {
      if (imageMemo === undefined) imageMemo = images.first();
      return imageMemo;
    },
    get key(): string | null {
      if (keyMemo === undefined) {
        const image = this.image;
        keyMemo = image ? visionCacheKey(image) : null;
      }
      return keyMemo;
    },
    label,
    kind,
  };
}

// Exported for image-budget.ts — see the ImageSlot export comment above.
export function collectImageSlots(messages: ModelMessage[]): ImageSlot[] {
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
              oneUserImage(() => toImageString(typed.image, typed.mediaType)),
              "Image",
              "user-part",
            ),
          );
        } else if (typed.type === "file" && isImageMediaType(typed.mediaType)) {
          slots.push(
            makeSlot(
              messageIndex,
              partIndex,
              oneUserImage(() => toImageString(typed.data, typed.mediaType)),
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
        if (typed.type !== "tool-result") return;
        // Was: `|| typed.toolName !== "get_screenshot"` here too, which let
        // an image from ANY other tool result — every MCP tool included —
        // bypass this whole pass entirely (both the structured AND the loose
        // extraction paths). That violated this module's own INVARIANT (see
        // applyVisionPreprocessing's doc comment) for the STRUCTURED path: an
        // MCP image, once it reaches this far, is a real ImagePart-shaped
        // `image-data` content part exactly like get_screenshot's (see
        // extractToolResultImages' comment), so there was never a
        // reason to gate that half on one tool's name. But the LOOSE fallback
        // inside extractToolResultImages is a different, riskier
        // extraction (an unanchored regex over a tool's whole string output)
        // that is only safe for get_screenshot specifically — see that
        // function's own comment — so only the structured branch is widened;
        // extractToolResultImages re-gates the loose branch on
        // toolName itself. The label distinguishes get_screenshot
        // ("Screenshot") from everything else ("Image") purely for
        // readability in the rendered description — it changes no
        // budget/cache/placeholder behavior below, all of which key off
        // `kind: "tool-result"`, not toolName.
        const images = extractToolResultImages(typed.output, typed.toolName);
        if (images.count === 0) return; // an error result is already plain text
        const label = typed.toolName === "get_screenshot" ? "Screenshot" : "Image";
        slots.push(makeSlot(messageIndex, partIndex, images, label, "tool-result"));
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
 * messages. The decision is now TWO-DIMENSIONAL, not "native or text":
 *
 *   1. Can the selected MODEL read an image at all? ({@link modelSupportsVision})
 *   2. Can the selected PROVIDER'S AI SDK integration carry an image found
 *      inside a TOOL-RESULT part through to that model, as opposed to
 *      flattening it into a giant base64 JSON string inside a plain text
 *      tool message? ({@link providerHandlesToolResultImages})
 *
 * These are independent, and were both live for a while: @ai-sdk/deepseek
 * read images in USER messages fine (dimension 1 = vision-capable) but had
 * no code path that promotes a tool-result's image-data part into a real
 * image — it always JSON.stringified it as tool-message text (dimension 2 =
 * false). That provider is gone and OpenRouter, the only one left, is native
 * on both dimensions — so dimension 2 is currently always true. The
 * distinction is kept because a vision-less model is native on neither, and
 * because a provider that stringifies tool-result images does so silently.
 *
 * The four cells:
 *   - vision=true,  tool-result-images=true  -> return `messages` untouched
 *     (native path, no allocation; e.g. OpenRouter + a vision model).
 *   - vision=true,  tool-result-images=false -> only TOOL-RESULT image slots
 *     (get_screenshot) are replaced by a text description; USER-attached
 *     images stay native, since the model can read those directly (e.g.
 *     DeepSeek-direct with a vision-capable model).
 *   - vision=false, tool-result-images=*     -> every image slot, wherever
 *     it appears, is replaced by a text description (pre-existing
 *     behavior — the provider dimension is moot when the model can't see
 *     anything anyway).
 *
 * A tool-result image that must be converted but has no VISION_MODEL
 * configured to describe it still never survives as an image part or a
 * raw base64 JSON blob: describeImage() itself returns a short, clear
 * failure text ("Vision is not configured on this server...") the instant
 * `isVisionConfigured` is false, which formatFailure() below renders in
 * place of the image — same code path as any other failed description, no
 * special-casing needed.
 *
 * INVARIANT: no ImagePart/image-bearing FilePart may survive into the
 * returned array for a slot this function decided to convert (per the
 * matrix above). That gap is a real bug class in Hermes (a raw `image_url`
 * reaching a text-only model and erroring the provider call) — as is the
 * tool-result case (a raw base64 JSON blob flooding a tool message) — and
 * this is the one place both are closed. Note the
 * invariant holds even when the per-turn budget is exceeded or a
 * description fails — both replace the image with text rather than leaving
 * it in place.
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
  opts: {
    config: Config;
    modelId: string;
    /**
     * The full, provider-prefixed model reference actually selected for
     * this turn (`modelOverride ?? config.CHAT_MODEL` at the call site) —
     * used ONLY to determine {@link providerHandlesToolResultImages}, since
     * `modelId` itself is already bare (prefix stripped, see the central
     * invariant in src/ai/provider.ts). Optional and defaults to
     * `config.CHAT_MODEL` so existing callers/tests that never pass a
     * modelOverride don't need to change.
     */
    chatModelRef?: string;
  },
): Promise<ModelMessage[]> {
  const { config, modelId } = opts;
  const vision = modelSupportsVision(config, modelId);
  const toolResultImagesNative = providerHandlesToolResultImages(
    parseModelRef(opts.chatModelRef ?? config.CHAT_MODEL).provider,
  );

  // Fully native on both dimensions: nothing to rewrite.
  if (vision && toolResultImagesNative) return messages;

  // vision=true here means we only need to rewrite TOOL-RESULT image slots
  // (get_screenshot, or any MCP tool that returns image content) —
  // user-attached images are left native since the model
  // itself can read them. vision=false means every image slot, as before.
  const scope: "all" | "tool-result-only" = vision ? "tool-result-only" : "all";

  const collected = collectImageSlots(messages); // chronological: index N is older than index N+1
  const slots =
    scope === "all" ? collected : collected.filter((slot) => slot.kind === "tool-result");
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
        const typed = part as ToolResultPart;
        return { ...typed, output: replaceImagePartsInOutput(typed.output, text) };
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
