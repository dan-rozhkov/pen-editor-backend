import type { ModelMessage, TextPart, ToolCallPart } from "ai";
import type { Config } from "../config.js";
import type { SystemOneAnswer, SystemOneClient, SystemOneQuestion } from "../services/systemone.js";
import { scrubPii } from "../analysis/pii.js";
import { collectImageSlots, type ImageSlot } from "./vision-messages.js";
import { MAX_RESCUED_IMAGES } from "./image-budget.js";

// Phase 2 of the image context budget: relevance instead of recency, on Jev.
// See docs/specs/2026-09-21-jev-image-relevance-design.md for the full
// design and docs/specs/2026-09-20-image-context-budget-design.md for phase
// 1, which this sits on top of. House style throughout mirrors
// src/ai/skillRouting.ts (fail-open, scrub before sending, never let an
// optional vendor break the caller) — see that module's header comment for
// the same reasoning, not repeated here.
//
// One Noul per candidate, not a Choice. A Choice answers a RELATIVE
// question ("which of these images is most needed") — with seven unneeded
// screenshots it would still confidently name the "best" of them. A Noul
// answers the ABSOLUTE question this pass actually needs: does THIS image,
// on its own, still matter for what's being asked right now. Same
// Choice-vs-Noul distinction skillRouting.ts's header already works
// through for skill picking.
//
// WHY toolCallId, NOT a hash of the image, is the ratchet key: toolCallId
// is stable across every turn of a session, unique, and free — it is
// already on the ToolResultPart. Hashing the image (visionCacheKey) is a
// sha256 over up to 6MB of base64, run synchronously on the event loop —
// exactly the cost src/ai/vision-messages.ts made `ImageSlot.key` lazy to
// avoid, and paying it again here just to build a cache key would reopen
// that cost on every candidate, every turn, whether or not Jev is even
// consulted.

// One `evaluate` call per turn, at most this many BRAND NEW candidates
// (never before seen for this session). Candidates below the elision
// cutoff accumulate turn over turn, but only about S (TOOL_RESULT_ELISION_
// STEP) of them become new on any given turn, so this comfortably covers a
// normal step with margin. A candidate that doesn't fit is cached as "not
// rescued" — see resolveImageRescues — a decision we didn't actually make,
// but freezing it is more honest than leaving it to flap between turns.
export const MAX_NEW_VERDICTS_PER_TURN = 4;


// Per-call budget: this pass sits ahead of the first streamed token in
// enforce mode (chatTurn.ts awaits it), so — like
// SKILL_ROUTING_TIMEOUT_MS — it must stay small next to a multi-second LLM
// turn. The production value is config.IMAGE_RELEVANCE_TIMEOUT_MS; this
// constant is only the fallback for a caller (chiefly tests) that doesn't
// pass config through, kept in one place so it can't silently drift from
// the config default.
export const DEFAULT_IMAGE_RELEVANCE_TIMEOUT_MS = 1_500;

// Same reasoning as skillRouting.ts's MAX_ROUTED_TEXT_CHARS: bounds what one
// turn ships to a third-party vendor. The user's own message can be
// arbitrarily long; only a bounded tail is useful signal for "is this image
// still needed", and every extra character is vendor bill + latency Jev
// doesn't need to spend.
const MAX_REQUEST_CHARS = 2_000;

// Bounds one candidate's rendered "args" line. Tool arguments are
// structured JSON, not prose a human wrote — scrubPii runs BEFORE this
// truncation (not after, unlike MAX_REQUEST_CHARS below), specifically so a
// data: URL or long base64 blob that happens to be sitting in some tool's
// arguments (unlikely, but not impossible — some MCP tool could take an
// image reference as input) can never survive as a still-matching fragment
// split across the truncation boundary. See the module header's "pixels
// never leave" invariant and this file's own test coverage for it.
const MAX_ARGS_CHARS = 300;

/** Truncates to the last `max` characters — same tail-preference as
 * skillRouting.ts's truncateTail: the text closest to "now" is the most
 * useful signal, and a long user message's most recent line is usually
 * what disambiguates "use the first screenshot" style references. */
function truncateTail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

function extractMessageText(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextPart => (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The last user message's text, joined across parts — mirrors
 * chatTurn.ts's buildRecentContext extraction, but reads ModelMessage[]
 * (post-convertToModelMessages) rather than the raw UIMessage list, since
 * that is the shape this pass and image-budget.ts both already work with. */
function lastUserMessageText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return extractMessageText(message.content);
  }
  return "";
}

/** Finds the assistant tool-call part matching `toolCallId`, for reading
 * the tool name and arguments a candidate's image resulted from. A
 * tool-result carries neither by itself (ToolResultPart has toolName, but
 * ImageSlot doesn't retain it — see that type's own fields), so this is the
 * one place both are recovered, by correlating on the id both parts share. */
function findToolCall(messages: ModelMessage[], toolCallId: string): ToolCallPart | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const typed = part as ToolCallPart;
      if (typed.type === "tool-call" && typed.toolCallId === toolCallId) return typed;
    }
  }
  return undefined;
}

function safeArgsText(input: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(input) ?? "";
  } catch {
    raw = "[unserializable arguments]";
  }
  // Scrub BEFORE truncating — see MAX_ARGS_CHARS's comment.
  return truncateTail(scrubPii(raw), MAX_ARGS_CHARS);
}

type RescueCandidate = ImageSlot & { toolCallId: string };

/**
 * Builds the `state` sent to Jev: the user's latest message plus one line
 * per candidate — which tool produced it, that call's (scrubbed, size
 * capped) arguments, and how many images have arrived since. NEVER reads
 * `candidate.image` or `candidate.key` — this function does not even import
 * anything capable of resolving a slot's pixel payload, so a future edit
 * cannot accidentally wire it in without first adding that import right
 * here. See the module header and this file's test coverage for the
 * invariant this exists to hold: no base64, ever, at any size, reaches Jev.
 */
function buildState(
  messages: ModelMessage[],
  candidates: RescueCandidate[],
  allToolResultSlots: ImageSlot[],
): { request: string; candidates: Record<string, string> } {
  const request = scrubPii(truncateTail(lastUserMessageText(messages), MAX_REQUEST_CHARS));

  const candidateLines: Record<string, string> = {};
  for (const candidate of candidates) {
    const call = findToolCall(messages, candidate.toolCallId);
    const toolName = call?.toolName ?? candidate.label;
    const argsText = call ? safeArgsText(call.input) : "(no recorded arguments)";
    const ownIndex = allToolResultSlots.findIndex((s) => s.toolCallId === candidate.toolCallId);
    const imagesAgo =
      ownIndex >= 0
        ? allToolResultSlots.slice(ownIndex + 1).reduce((sum, s) => sum + s.imageCount, 0)
        : "unknown";
    candidateLines[candidate.toolCallId] =
      scrubPii(`tool: ${toolName}; arguments: ${argsText}; images since: ${imagesAgo}`);
  }

  return { request, candidates: candidateLines };
}

function rescueQuestion(tag: string): string {
  return (
    `Look at the candidate labeled "${tag}" in state.candidates. Based on the user's latest ` +
    "request in state.request and that candidate's own line (which tool produced it, its " +
    "arguments, and how many images have arrived since), is that specific image still needed " +
    "to fully satisfy what the user is asking for right now? Answer no if the request doesn't " +
    "depend on that image at all, or could be fully satisfied without looking at it again."
  );
}

// ── The храповик (ratchet) cache ────────────────────────────────────────
//
// Keyed `${sessionId}:${toolCallId}` — see the module header for why
// toolCallId, not an image hash. FIRST WRITE WINS: once a slot's verdict is
// recorded (rescued or not), it is never re-asked or re-decided for the
// rest of the process's life for that session. Both outcomes are cached,
// not just "rescued" — caching only the positive would let a
// not-rescued-on-turn-T slot become eligible again on turn T+1, i.e.
// resurrect, which is exactly the mid-history rewrite phase 1 exists to
// prevent (see the design doc's "Храповик, и чем он держится" section).
//
// Bounded + LRU-evicted, same shape as services/vision.ts's description
// cache: an in-process Map is not a database, and a long-running server
// must not let it grow without bound across every session/toolCallId pair
// it ever sees.
const RATCHET_CACHE_MAX_ENTRIES = 4_000;
let ratchetCache = new Map<string, boolean>();

function ratchetKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function ratchetGet(key: string): boolean | undefined {
  const value = ratchetCache.get(key);
  if (value === undefined) return undefined;
  // Refresh LRU recency on read, same as vision.ts's cacheGet — a slot
  // that keeps getting asked about (re-attached, re-referenced across many
  // turns) should not be the one evicted just because it was cached long
  // ago.
  ratchetCache.delete(key);
  ratchetCache.set(key, value);
  return value;
}

function ratchetSet(key: string, value: boolean): void {
  // First write wins — see this section's header comment. A second write
  // attempt for an already-decided key must never happen from
  // resolveImageRescues (it only ever asks about slots it read as
  // undefined), but guarding it here too costs nothing and keeps the
  // invariant true even if a future caller gets that wrong.
  if (ratchetCache.has(key)) return;
  ratchetCache.set(key, value);
  if (ratchetCache.size > RATCHET_CACHE_MAX_ENTRIES) {
    const oldestKey = ratchetCache.keys().next().value;
    if (oldestKey !== undefined) ratchetCache.delete(oldestKey);
  }
}

/**
 * Records `toolCallIds` as decided-against, so a slot that was actually
 * elided this turn can never be rescued on a later one.
 *
 * Needed because a rescue SHIFTS elision onto the next slot in line, and
 * that victim was never a candidate — `resolveImageRescues` only ever
 * freezes slots it was asked about. Without this, the victim reappears as a
 * fresh, uncached candidate once the cutoff advances, Jev is free to say
 * "keep it", and an already-elided image comes back: its text flips from
 * placeholder to a real image part in the MIDDLE of the history, which is
 * the exact prompt-cache break the ratchet exists to prevent — and it
 * silently re-adds the tokens the budget just saved.
 *
 * `ratchetSet` is first-write-wins, so this can never downgrade a rescue
 * (and a rescued slot is by construction never in the elision plan anyway).
 */
export function freezeElidedSlots(
  sessionId: string | undefined,
  toolCallIds: Iterable<string | undefined>,
): void {
  if (!sessionId) return; // no ratchet home — same rule as resolveImageRescues
  for (const toolCallId of toolCallIds) {
    if (typeof toolCallId === "string") ratchetSet(ratchetKey(sessionId, toolCallId), false);
  }
}

/** Test seam: the cache is module-level, so suites that assert ratchet
 * behavior across "turns" must be able to start from empty. Not used in
 * production code. */
export function resetImageRelevanceCacheForTests(): void {
  ratchetCache = new Map<string, boolean>();
}

function isNoulAnswer(
  answer: SystemOneAnswer | undefined,
): answer is Extract<SystemOneAnswer, { type: "noul" }> {
  return !!answer && answer.type === "noul";
}

async function askJev(
  client: SystemOneClient,
  messages: ModelMessage[],
  candidates: RescueCandidate[],
  allToolResultSlots: ImageSlot[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Map<string, number>> {
  const state = buildState(messages, candidates, allToolResultSlots);
  const questions: Record<string, SystemOneQuestion> = {};
  for (const candidate of candidates) {
    questions[candidate.toolCallId] = {
      type: "noul",
      instructions: rescueQuestion(candidate.toolCallId),
    };
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  const { answers } = await client.evaluate({ state, questions, signal: combinedSignal });

  const result = new Map<string, number>();
  for (const candidate of candidates) {
    const answer = answers[candidate.toolCallId];
    // A missing or malformed per-candidate answer is the same class of
    // vendor glitch skillRouting.ts guards against — left OUT of the map
    // (not thrown), so resolveImageRescues treats it as "no verdict for
    // this one" and leaves it uncached rather than failing the whole batch
    // over one bad entry.
    if (!isNoulAnswer(answer)) continue;
    result.set(candidate.toolCallId, answer.noul);
  }
  return result;
}

export interface ResolveImageRescuesOptions {
  config: Config;
  /** Conversation id — the ratchet's home. Absent (showcase runner, any
   * headless/no-session caller) means there is nowhere to hold the ratchet,
   * so Jev is never asked at all — see the module header and the design
   * doc's "sessionId отсутствует" section. This is a RULE, not a
   * degradation: asking Jev without a place to remember the answer would
   * let its verdict flip every turn, which is the exact instability phase 1
   * exists to prevent. */
  sessionId: string | undefined;
  /** Candidates to consider rescuing — MUST be exactly
   * `planImageElision(messages)`'s output (or a subset of it): slots pure
   * recency was already going to elide this turn. Passing a slot recency
   * would have kept live is meaningless — Jev can only spare a slot from
   * eviction, never evict one recency would have kept (see the design
   * doc's "Спасение СДВИГАЕТ, а не отменяет" section) — but this function
   * does not itself re-derive or check that constraint; the caller (chatTurn.ts)
   * is what wires `candidates` from `planImageElision`. */
  candidates: ImageSlot[];
  messages: ModelMessage[];
  signal?: AbortSignal;
  /**
   * Per-call cap for the one `evaluate`. Defaults to
   * config.IMAGE_RELEVANCE_TIMEOUT_MS, the TTFT-shaped enforce budget.
   * Shadow passes the laxer IMAGE_RELEVANCE_SHADOW_TIMEOUT_MS instead —
   * see that knob's comment for why sharing one number silently censors
   * the measurement shadow exists to produce.
   */
  timeoutMs?: number;
}

/**
 * Why a turn's rescue count came out the way it did.
 *
 * This exists because "0 rescued" is ambiguous and the ambiguity bites in
 * production: shadow mode is a MEASUREMENT, and a zero that means "Jev
 * weighed six candidates and declined all six" calls for a threshold
 * change, while a zero that means "Jev never answered" calls for fixing
 * Jev. Both printed the same line until a live run against a TypeSafe
 * account with no credits left reported `would rescue 0/6` four times in a
 * row and looked exactly like a correctly-working, conservative model.
 */
export type ImageRescueOutcome =
  /** Jev answered; `asked` candidates got a real verdict. */
  | "asked"
  /** Nothing to ask about — no candidates, or every one already decided. */
  | "nothing-to-ask"
  /** No conversation id, so no ratchet home: Jev is skipped by design. */
  | "no-session"
  /** No Jev client at all (TYPESAFE_API_KEY unset). */
  | "no-client"
  /** The rescue budget is already full, so no verdict could be acted on. */
  | "budget-full"
  /** Jev was asked and failed: timeout, transport, 4xx/5xx, bad response. */
  | "failed";

export interface ImageRescueResult {
  /** toolCallIds to spare — feed to `applyImageBudget(messages, {rescued})`. */
  rescued: ReadonlySet<string>;
  outcome: ImageRescueOutcome;
  /** How many candidates got a real verdict from Jev on THIS call. */
  asked: number;
}

/**
 * Asks Jev which of this turn's eviction candidates are still needed, and
 * returns the toolCallIds to spare. Fail-open on everything: no client, no
 * sessionId, a timeout, an error, or a malformed response all resolve to
 * "nothing new rescued" (though slots already ratcheted "rescued" on an
 * earlier turn are still returned — the ratchet is a fact this call already
 * knows for free, independent of whether THIS call to Jev succeeds). The
 * `outcome` field is what tells those cases apart; see ImageRescueOutcome.
 */
export async function resolveImageRescues(
  client: SystemOneClient | null | undefined,
  opts: ResolveImageRescuesOptions,
): Promise<ImageRescueResult> {
  const { config, sessionId, candidates, messages } = opts;

  const rescued = new Set<string>();
  // no ratchet home — see the option's doc comment
  if (!sessionId) return { rescued, outcome: "no-session", asked: 0 };
  if (candidates.length === 0) return { rescued, outcome: "nothing-to-ask", asked: 0 };

  const withIds = candidates.filter(
    (candidate): candidate is RescueCandidate => typeof candidate.toolCallId === "string",
  );
  if (withIds.length === 0) return { rescued, outcome: "nothing-to-ask", asked: 0 };

  const uncached: RescueCandidate[] = [];
  for (const candidate of withIds) {
    const key = ratchetKey(sessionId, candidate.toolCallId);
    const cached = ratchetGet(key);
    if (cached === true) rescued.add(candidate.toolCallId);
    else if (cached === undefined) uncached.push(candidate);
    // cached === false: already decided against, stays out of `rescued`.
  }

  // never asked, never cached — see doc comment
  if (!client) return { rescued, outcome: "no-client", asked: 0 };
  if (uncached.length === 0) return { rescued, outcome: "nothing-to-ask", asked: 0 };

  // MAX_RESCUED_IMAGES, counted over THIS candidate batch's already-
  // cached rescues (not a global/process-wide total — see the constant's
  // comment). Once reached, every still-undecided candidate is frozen as
  // not-rescued WITHOUT spending a Jev call: there is no room left to grant
  // even a confident "yes", so asking would only spend budget on an answer
  // this pass is required to discard.
  let rescuedImages = 0;
  for (const candidate of withIds) {
    if (rescued.has(candidate.toolCallId)) rescuedImages += candidate.imageCount;
  }
  const remainingRescueImages = MAX_RESCUED_IMAGES - rescuedImages;
  if (remainingRescueImages <= 0) {
    for (const candidate of uncached) ratchetSet(ratchetKey(sessionId, candidate.toolCallId), false);
    return { rescued, outcome: "budget-full", asked: 0 };
  }

  // MAX_NEW_VERDICTS_PER_TURN bounds how many brand-new candidates get a
  // real Jev call. Anything past it is frozen the same way — see that
  // constant's comment for why freezing (not merely deferring) is the
  // honest choice here.
  // Take the NEWEST candidates, not the oldest. `uncached` is in
  // chronological order, and in steady state it holds only the ~S slots that
  // just crossed the cutoff, so the slice direction looks like it cannot
  // matter. It matters on the FIRST turn the feature engages against an
  // existing conversation — a process restart, a mode flip, or a resumed
  // chat whose whole history arrives at once — where `uncached` is the
  // entire candidate list. Slicing from the front would then spend the
  // budget on the oldest, least relevant screenshots and permanently freeze
  // the newest ones (the very slots a rescue is meant for) as not-rescued,
  // first-write-wins, for the life of the process.
  const toAsk = uncached.slice(-MAX_NEW_VERDICTS_PER_TURN);
  const overflow = uncached.slice(0, Math.max(0, uncached.length - MAX_NEW_VERDICTS_PER_TURN));
  for (const candidate of overflow) ratchetSet(ratchetKey(sessionId, candidate.toolCallId), false);
  if (toAsk.length === 0) return { rescued, outcome: "nothing-to-ask", asked: 0 };

  // allToolResultSlots — the FULL tool-result image slot list, used only to
  // compute each candidate's "images since" line in `state` (see
  // buildState). Re-derived from `messages` here rather than threaded in by
  // the caller: it is cheap (no payload materialization — imageCount is
  // computed without touching a slot's image, same as image-budget.ts) and
  // keeps this module's contract to a plain (client, options) call.
  const allToolResultSlots = collectImageSlots(messages).filter(
    (slot) => slot.kind === "tool-result" && slot.imageCount > 0,
  );

  let verdicts: Map<string, number>;
  try {
    verdicts = await askJev(
      client,
      messages,
      toAsk,
      allToolResultSlots,
      opts.signal,
      opts.timeoutMs ?? config.IMAGE_RELEVANCE_TIMEOUT_MS ?? DEFAULT_IMAGE_RELEVANCE_TIMEOUT_MS,
    );
  } catch (err) {
    // Fail-open: nothing is cached HERE on purpose. A whole-call failure
    // (timeout, network error, malformed top-level response) is a transport
    // fact about this one attempt, not a considered verdict, so this module
    // records none — exactly like skillRouting.ts's `reason: "error"`.
    //
    // That is not the same as "these slots stay askable forever": the caller
    // freezes whatever the turn actually ELIDES (chatTurn.ts), and after a
    // failure pure recency still elides the candidates. An already-elided
    // slot must never be askable again or a later verdict would un-elide it.
    // What the free retry really buys is the slots that were NOT elided —
    // the ones a multi-image result stopped the walk short of.
    console.warn("[imageRelevance] evaluate failed, falling back to pure recency:", err);
    return { rescued, outcome: "failed", asked: 0 };
  }

  // Newest-first when handing out the remaining rescue budget: `toAsk` is
  // chronological, and if two candidates both clear the threshold the more
  // recent one is the better bet.
  let grantedImages = 0;
  for (const candidate of [...toAsk].reverse()) {
    const noul = verdicts.get(candidate.toolCallId);
    // Per-candidate malformed answer: left uncached here for the same
    // reason as a whole-call failure above — it is a vendor glitch, not a
    // verdict. Safe because the caller freezes the applied plan, so a
    // candidate this turn elides cannot be asked about (or rescued) again.
    if (noul === undefined) continue;
    const wantsRescue = noul >= config.IMAGE_RELEVANCE_MIN_NOUL;
    const fits = grantedImages + candidate.imageCount <= remainingRescueImages;
    const granted = wantsRescue && fits;
    if (granted) {
      grantedImages += candidate.imageCount;
      rescued.add(candidate.toolCallId);
    }
    ratchetSet(ratchetKey(sessionId, candidate.toolCallId), granted);
  }

  return { rescued, outcome: "asked", asked: toAsk.length };
}
