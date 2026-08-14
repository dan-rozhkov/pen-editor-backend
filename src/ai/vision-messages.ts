import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
  ToolApprovalResponse,
  ToolResultPart,
} from "ai";
import { getModels, type Config } from "../config.js";
import { describeImage, isVisionConfigured } from "../services/vision.js";
import { parseScreenshotDataUrl } from "./screenshotOutput.js";

// Budget for ONE turn. The route caps images per *message* (MAX_IMAGE_PARTS,
// src/routes/chat.ts), but this pass walks the whole history, so a long
// conversation — or a hand-rolled request carrying a long one — would
// otherwise fan out one vision call per image ever attached. Only the most
// recent images are described; older ones degrade to a placeholder. 8 is well
// past what any real turn needs (the composer allows 4 per message) while
// keeping the worst case bounded.
export const MAX_DESCRIBED_IMAGES_PER_TURN = 8;

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
  /** "Image" (user attachment) or "Screenshot" (get_screenshot result). */
  label: string;
  kind: "user-part" | "tool-result";
}

function collectImageSlots(messages: ModelMessage[]): ImageSlot[] {
  const slots: ImageSlot[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    if (message.role === "user") {
      message.content.forEach((part, partIndex) => {
        const typed = part as TextPart | ImagePart | FilePart;
        if (typed.type === "image") {
          slots.push({
            messageIndex,
            partIndex,
            image: toImageString(typed.image, typed.mediaType),
            label: "Image",
            kind: "user-part",
          });
        } else if (typed.type === "file" && isImageMediaType(typed.mediaType)) {
          slots.push({
            messageIndex,
            partIndex,
            image: toImageString(typed.data, typed.mediaType),
            label: "Image",
            kind: "user-part",
          });
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
        slots.push({
          messageIndex,
          partIndex,
          image: dataUrl,
          label: "Screenshot",
          kind: "tool-result",
        });
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

async function describeSlot(slot: ImageSlot, config: Config): Promise<string> {
  if (!slot.image) {
    return "[Image attached but could not be analyzed: unsupported image data format]";
  }
  const result = await describeImage({ image: slot.image, config });
  if (!result.ok) {
    return `[Image attached but could not be analyzed: ${result.text}]`;
  }
  return `[${slot.label}: visual description]\n${result.text}`;
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
 */
export async function applyVisionPreprocessing(
  messages: ModelMessage[],
  opts: { config: Config; modelId: string },
): Promise<ModelMessage[]> {
  const { config, modelId } = opts;
  if (modelSupportsVision(config, modelId)) return messages;

  const slots = collectImageSlots(messages);
  if (slots.length === 0) return messages;

  // Newest images win the budget: they are the ones the current request is
  // actually about.
  const overBudget = Math.max(0, slots.length - MAX_DESCRIBED_IMAGES_PER_TURN);
  const skipped = slots.slice(0, overBudget);
  const described = slots.slice(overBudget);

  const texts = new Map<string, string>();
  const key = (slot: ImageSlot) => `${slot.messageIndex}:${slot.partIndex}`;
  for (const slot of skipped) {
    texts.set(
      key(slot),
      `[Earlier image omitted: only the ${MAX_DESCRIBED_IMAGES_PER_TURN} most recent images in this conversation are described. Ask for it again if you need it.]`,
    );
  }
  const results = await mapWithConcurrency(described, DESCRIBE_CONCURRENCY, (slot) =>
    describeSlot(slot, config),
  );
  described.forEach((slot, i) => texts.set(key(slot), results[i]));

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
