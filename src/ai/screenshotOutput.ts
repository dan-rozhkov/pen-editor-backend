import type { ModelMessage } from "ai";

// Shared understanding of what get_screenshot's AND browse_screenshot's
// frontend handlers return, used by three places that must agree: each
// tool's `toModelOutput` (which promotes the payload to a real image part
// when the AI SDK actually calls it — i.e. when convertToModelMessages is
// given `{ tools }`), `promoteScreenshotToolOutputs` below (which does the
// SAME promotion when it wasn't, which is prepareChatTurn's real call site
// — see its own comment), and applyVisionPreprocessing (which swaps the
// image part back out for a text description when the model can't read
// images).
//
// get_screenshot's handler always returns
// JSON.stringify({ imageData: "<data url>" }) on success or
// JSON.stringify({ error: "..." }) on failure — see
// pen-editor/src/lib/tools/getScreenshot.ts. browse_screenshot's handler
// returns the richer `{ imageData, url, title, width, height, snapshotId?,
// elements? }` shape (or `{ error }`) — see pen-editor's browseScreenshot.ts
// — but `imageData` is the same data: URL either way, which is all
// parseScreenshotDataUrl below cares about.

/**
 * Tool names whose result is a screenshot image and therefore shares this
 * module's parsing/toModelOutput/vision-preprocessing treatment. Exported so
 * vision-messages.ts's two tool-name checks (the loose string-fallback image
 * probe, and the "Screenshot" vs "Image" label) and tools.ts's `toModelOutput`
 * wiring stay in sync with a single source of truth instead of three
 * hand-copied `=== "get_screenshot"` checks drifting independently.
 */
export const SCREENSHOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_screenshot",
  "browse_screenshot",
]);

export interface ScreenshotImage {
  /** Base64 payload with no `data:` prefix — what an image part wants. */
  base64: string;
  mediaType: string;
  /** The full data: URL — what the vision service wants. */
  dataUrl: string;
}

const DATA_URL_RE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/;

function fromDataUrl(value: string): ScreenshotImage | null {
  const match = value.match(DATA_URL_RE);
  if (!match) return null;
  return { mediaType: match[1], base64: match[2], dataUrl: match[0] };
}

/**
 * Pulls the screenshot out of whatever shape a get_screenshot tool output
 * landed in: the raw JSON string, an already-parsed object, or a bare data
 * URL. Returns null when the output carries no image (e.g. an error result),
 * which callers treat as "leave this alone".
 */
export function parseScreenshotDataUrl(output: unknown): ScreenshotImage | null {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (typeof parsed.imageData === "string") return fromDataUrl(parsed.imageData);
      return null; // parsed fine but carries no image — an error result
    } catch {
      return fromDataUrl(output); // not JSON; maybe a bare data URL
    }
  }
  if (output && typeof output === "object") {
    const imageData = (output as Record<string, unknown>).imageData;
    if (typeof imageData === "string") return fromDataUrl(imageData);
  }
  return null;
}

export type ScreenshotContentPart =
  | { type: "text"; text: string }
  | { type: "image-data"; data: string; mediaType: string };

export interface ScreenshotContentOutput {
  type: "content";
  value: ScreenshotContentPart[];
}

/**
 * The ONE place that decides what a screenshot tool's raw output (the JSON
 * string/object the frontend handler returned — same `output` a `toModelOutput`
 * callback receives) turns into as a model-ready `content` part. Both tools'
 * `toModelOutput` call this directly, and `promoteScreenshotToolOutputs` below
 * calls it for the real production path where `toModelOutput` never runs
 * (convertToModelMessages without `{ tools }` — see that function's comment) —
 * so there is exactly one definition of the shape instead of two that could
 * drift.
 *
 * Returns null when there is no image to promote (an error result) — callers
 * leave the output untouched in that case.
 *
 * get_screenshot's payload IS the image and nothing else, so it promotes to a
 * single image-data part. browse_screenshot's payload additionally carries
 * url/title/snapshotId/elements alongside imageData, so it promotes to TWO
 * parts: a text part with the JSON minus imageData (so the element table
 * survives vision preprocessing, which only ever rewrites image parts) plus
 * the image-data part.
 */
export function screenshotOutputToContent(
  toolName: string,
  output: unknown,
): ScreenshotContentOutput | null {
  const image = parseScreenshotDataUrl(output);
  if (!image) return null;

  if (toolName === "get_screenshot") {
    return {
      type: "content",
      value: [{ type: "image-data", data: image.base64, mediaType: image.mediaType }],
    };
  }

  let rest: unknown = {};
  if (typeof output === "string") {
    try {
      rest = JSON.parse(output);
    } catch {
      rest = {};
    }
  } else if (output && typeof output === "object") {
    rest = output;
  }
  const { imageData: _imageData, ...withoutImage } = rest as Record<string, unknown>;
  return {
    type: "content",
    value: [
      { type: "text", text: JSON.stringify(withoutImage) },
      { type: "image-data", data: image.base64, mediaType: image.mediaType },
    ],
  };
}

/**
 * Promotes screenshot-tool results in an already-converted ModelMessage[]
 * from their default text/json shape into the same `content` shape each
 * tool's `toModelOutput` would have produced, HAD convertToModelMessages been
 * called with `{ tools }`. It isn't: at that call site prepareChatTurn hasn't
 * built this turn's `tools` object yet (mode selection, MCP attachment and
 * every structural/vision gate all run further down, and change what a
 * "current" tool set even means for a given turn/mode) — wiring `tools`
 * through would mean running EVERY tool's `toModelOutput` against whatever
 * definition happens to be live today, for historical tool calls that may
 * have been made under a different mode or an older schema, for a much wider
 * blast radius than the one bug being fixed here. This pass gets the one
 * promotion actually needed (screenshot outputs) without any of that.
 *
 * Pure and deterministic: same input array → byte-identical output array,
 * every time, with no dependency on anything outside the message itself.
 * That matters here specifically because prompt caching keys off the
 * resulting message bytes staying stable across a session's tool-loop
 * auto-continuations (see prepareChatTurn's systemPromptHash comment) — a
 * pass that used any non-deterministic input (wall clock, randomness, an
 * external cache) would invalidate the provider's cached prefix from this
 * point on for reasons unrelated to the conversation actually changing.
 *
 * Only touches parts whose output is still `text` or `json` (the untouched
 * default) for a name in SCREENSHOT_TOOL_NAMES; an output already shaped
 * `content` (or an error shape) is left alone, so this is safe to run even
 * if `tools` is ever passed to convertToModelMessages in the future and the
 * real toModelOutput already ran.
 */
export function promoteScreenshotToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || !SCREENSHOT_TOOL_NAMES.has(part.toolName)) return part;
      if (part.output.type !== "text" && part.output.type !== "json") return part;
      const raw = part.output.value;
      const promoted = screenshotOutputToContent(part.toolName, raw);
      if (!promoted) return part;
      messageChanged = true;
      return { ...part, output: promoted };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}
