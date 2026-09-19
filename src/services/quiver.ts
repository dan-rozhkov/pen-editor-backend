import type { Config } from "../config.js";
import { assertSvgIsInert } from "./fal.js";

/** Thrown for any non-2xx response from the Quiver API. Carries the parsed
 * error body's fields (see the module doc below) so a route can surface
 * `code`/`requestId` to the caller instead of a generic message. */
export class QuiverError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "QuiverError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Thrown when the Quiver request doesn't complete within QUIVER_TIMEOUT_MS.
 * Routes should map this to HTTP 504, same convention as
 * ImageGenerationTimeoutError/FalTimeoutError. */
export class QuiverTimeoutError extends Error {
  constructor(ms: number) {
    super(`Quiver vector generation timed out after ${ms}ms`);
    this.name = "QuiverTimeoutError";
  }
}

export function isQuiverConfigured(config: Config): boolean {
  return Boolean(config.QUIVER_API_KEY);
}

interface QuiverErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
  status?: number;
}

export interface QuiverUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export type QuiverStreamEvent =
  | { type: "delta"; svg: string }
  | { type: "done"; svg: string; usage?: QuiverUsage };

export interface StreamVectorGenerationInput {
  prompt: string;
  instructions?: string;
  signal?: AbortSignal;
}

// One SSE "record" as delimited by a blank line, decoded into its event name
// (default "message", per the SSE spec) and its (possibly multi-line) data
// payload, joined with "\n" the way the spec requires.
interface SseRecord {
  event: string;
  data: string;
}

// Splits raw SSE text into records + a leftover partial record — the caller
// re-buffers the leftover and prepends it to the next chunk. Records are
// separated by a blank line ("\n\n" or "\r\n\r\n"); normalize CRLF to LF
// first so a single split rule covers both.
function parseSseRecords(buffer: string): { records: SseRecord[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  // The last part is either empty (buffer ended exactly on a record
  // boundary) or an incomplete record — keep it for the next chunk either way.
  const rest = parts.pop() ?? "";
  const records: SseRecord[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        // A single leading space after the colon is conventional, not
        // required — strip at most one.
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
      // Other fields (id:, retry:, comments starting with ":") are ignored —
      // Quiver's stream doesn't use them and we have no use for them either.
    }
    if (dataLines.length > 0) {
      records.push({ event, data: dataLines.join("\n") });
    }
  }
  return { records, rest };
}

// Mutable accumulator threaded through interpretRecord as records are
// consumed off the wire (in the main read loop) and, once more, off the
// leftover `buffer` after the stream ends (see the doc comment on
// streamVectorGeneration for why that second pass exists).
interface StreamState {
  concatenatedDelta: string;
  sawContentEvent: boolean;
  // Set once a `content` record has been turned into the final `done`
  // event. The documented contract is "exactly one final done" — a `delta`
  // arriving after that (the ignored `index`/`n` params hint multiple
  // outputs are possible) must not be processed, so callers check this
  // after every record and stop consuming further ones.
  done: boolean;
}

// Turns one already-parsed SSE record into zero or one QuiverStreamEvents,
// mutating `state` along the way. Pulled out of the main loop so the same
// logic can run a second time over whatever is left in `buffer` after the
// stream ends (finding #1: SSE has no requirement to end on a blank line).
function interpretRecord(record: SseRecord, state: StreamState): QuiverStreamEvent[] {
  if (state.done) return []; // See StreamState.done's doc comment.

  if (record.event === "draft") {
    let parsed: { svg?: string; update_type?: string };
    try {
      parsed = JSON.parse(record.data);
    } catch {
      return []; // Malformed record — ignore rather than fail the whole stream.
    }
    if (typeof parsed.svg !== "string") return [];
    // `update_type` is otherwise unused, but its mere existence in the wire
    // format implies a `draft` payload isn't always a delta — arrow-2 has
    // only ever sent "delta" in testing, but a value we've never observed
    // could just as well be a full snapshot. We can't tell a snapshot from
    // a delta except by this field, so: anything OTHER than an explicit
    // "delta" replaces the accumulator instead of appending to it. That
    // keeps the no-content-event fallback (below) safe against a snapshot
    // getting concatenated onto whatever came before it and producing
    // corrupt SVG, at the cost of (in a scenario never observed) dropping
    // an intermediate snapshot from that fallback — an acceptable trade
    // since the fallback only exists for a stream that never sends the
    // authoritative `content` event at all.
    if (parsed.update_type && parsed.update_type !== "delta") {
      state.concatenatedDelta = parsed.svg;
    } else {
      state.concatenatedDelta += parsed.svg;
    }
    return [{ type: "delta", svg: parsed.svg }];
  }

  if (record.event === "content") {
    let parsed: { svg?: string; usage?: QuiverUsage };
    try {
      parsed = JSON.parse(record.data);
    } catch {
      return [];
    }
    if (typeof parsed.svg !== "string") return [];
    state.sawContentEvent = true;
    state.done = true;
    // Quiver output is untrusted the same way fal.ai's vectorizer output is
    // (see fal.ts:assertSvgIsInert) — the frontend's DOMParser(...,
    // "image/svg+xml") consumer is inert, but this SVG is later
    // pasted/exported/embedded elsewhere too, so this is defense in depth
    // for those paths, not a substitute for the parser being safe. Throws
    // UnsafeSvgError, mapped to HTTP 422 by the route the same way fal.ts's
    // route does.
    assertSvgIsInert(parsed.svg, "Quiver's SVG result");
    return [{ type: "done", svg: parsed.svg, usage: parsed.usage }];
  }

  // Any other event name (e.g. "reasoning") is tolerated and ignored.
  return [];
}

async function readQuiverErrorBody(res: Response): Promise<QuiverError> {
  const status = res.status;
  const text = await res.text().catch(() => "");
  let body: QuiverErrorBody | undefined;
  try {
    body = text ? (JSON.parse(text) as QuiverErrorBody) : undefined;
  } catch {
    // Non-JSON error body — fall through to the raw text below.
  }
  const message = body?.message || text.slice(0, 200) || `Quiver request failed (${status})`;
  return new QuiverError(message, status, body?.code, body?.request_id);
}

/**
 * Streams one SVG generation from QuiverAI (`POST /v1/svgs/generations`,
 * `stream: true`). Yields `{type: "delta", svg}` for each incremental chunk
 * as it arrives (arrow-2's `draft`/`update_type: "delta"` events carry a
 * DELTA to concatenate, not the whole document so far) and exactly one
 * final `{type: "done", svg}` carrying the complete document — from the
 * `content` event when the stream sends one, or the concatenation of every
 * delta seen otherwise (arrow-2 has always sent a `content` event in
 * testing, but the fallback keeps a caller working if a model ever omits
 * it). Unknown event types (docs mention a `reasoning` phase not observed
 * for arrow-2) are ignored rather than treated as an error, so the parser
 * degrades gracefully against a wire format observed only for one model.
 */
export async function* streamVectorGeneration(
  config: Config,
  input: StreamVectorGenerationInput,
): AsyncGenerator<QuiverStreamEvent> {
  if (!config.QUIVER_API_KEY) {
    throw new QuiverError("QUIVER_API_KEY is not configured", 503);
  }

  const timeoutMs = config.QUIVER_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeoutSignal, input.signal]) : timeoutSignal;

  let res: Response;
  try {
    res = await fetch(`${config.QUIVER_BASE_URL}/svgs/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.QUIVER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.QUIVER_MODEL,
        prompt: input.prompt,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        stream: true,
      }),
      signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new QuiverTimeoutError(timeoutMs);
    }
    throw err;
  }

  if (!res.ok) {
    throw await readQuiverErrorBody(res);
  }
  if (!res.body) {
    throw new QuiverError("Quiver response had no body", res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state: StreamState = { concatenatedDelta: "", sawContentEvent: false, done: false };

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (timeoutSignal.aborted) {
          throw new QuiverTimeoutError(timeoutMs);
        }
        throw err;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const { records, rest } = parseSseRecords(buffer);
      buffer = rest;

      for (const record of records) {
        for (const event of interpretRecord(record, state)) {
          yield event;
        }
        if (state.done) return; // Exactly one final `done` — see StreamState.done.
      }
    }

    // The reader reported `done` (the underlying connection closed) with
    // `buffer` possibly still holding an unparsed record: SSE servers are
    // not required to emit a trailing blank line after the last record, so
    // a `content` record right at the end of the stream would otherwise sit
    // in `buffer` forever and never reach interpretRecord — silently
    // downgrading a real document into the concatenated-deltas fallback
    // below. Force it through the same parser as a complete buffer by
    // appending the record delimiter it may be missing.
    const { records: trailingRecords } = parseSseRecords(`${buffer}\n\n`);
    for (const record of trailingRecords) {
      for (const event of interpretRecord(record, state)) {
        yield event;
      }
      if (state.done) return;
    }
  } finally {
    reader.releaseLock();
  }

  if (!state.sawContentEvent) {
    if (!state.concatenatedDelta) {
      throw new QuiverError("Quiver stream ended with no content", 502);
    }
    // Same untrusted-output reasoning as the `content`-event path in
    // interpretRecord — this fallback document was never covered by that
    // check since it isn't built from a `content` record at all.
    assertSvgIsInert(state.concatenatedDelta, "Quiver's SVG result");
    yield { type: "done", svg: state.concatenatedDelta };
  }
}
