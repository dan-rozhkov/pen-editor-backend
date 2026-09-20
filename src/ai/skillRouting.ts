import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneQuestion,
} from "../services/systemone.js";
import { scrubPii } from "../analysis/pii.js";

// Jev-backed auto-pick of which skill (if any) a user's message is asking
// for. Today the model spends a whole extra round trip on this: it reads
// the "Available Skills" catalog in the system prompt, emits a load_skill
// tool call, gets the result, then continues. This lets prepareChatTurn
// inject the skill up front — skipping that round trip — when the pick is
// confident enough to act on (see SKILL_ROUTING_MIN_CONFIDENCE in
// config.ts). House style mirrors src/analysis/embeddings.ts: fail-open,
// scrub before sending, never let an optional vendor break the caller.
//
// Two-pass design, ported from TypeSafe's own "skill suggestion" cookbook
// (docs.typesafe.ai/cookbooks/skill_suggestion) — see
// docs/specs/2026-09-17-jev-skill-routing-design.md's addendum for the full
// writeup. Pass 1 ranks EVERY curated skill in one Choice question, and
// asks three Noul questions ("does this turn need a skill at all?") over
// the same state. That "need a skill at all?" question is deliberately a
// Noul, not a `none` option folded into the Choice: a Choice answers a
// RELATIVE question (which option wins among the ones offered), a Noul
// answers an ABSOLUTE one (does this hold at all) — see
// docs.typesafe.ai/primitives/noul.md and .../model-jaggedness/jev-1.13.md's
// "Common-sense structural invariants" section. Folding "none of these" in
// as just another Choice option (the old design) forces the model to weigh
// it against every real skill on the SAME relative footing, which is not
// the question being asked. Pass 2 re-reads the top 3 candidates from pass
// 1's `probabilities` ranking, PLUS pass 1's own `choice` winner if it
// somehow isn't already among them (finding #4 — `choice` and
// `probabilities` are separate response fields, so nothing guarantees the
// winner is the argmax), now with each skill's fuller description and the
// opening of its own Markdown body, and asks a per-candidate Noul ("does
// THIS skill do the specific thing asked for?") that can reject all of them
// even though pass 1 was confident one was the best of the bunch.

// This sits in the hot path of every chat request, ahead of the first
// streamed token (TTFT) — but only in enforce mode, and only up to
// SKILL_ROUTING_ENFORCE_BUDGET_MS overall (see routeSkill). 1.5s is a
// deliberate PER-CALL budget for the enforce path specifically — a TTFT
// bound, chosen to be small next to a multi-second LLM turn while still
// giving Jev a realistic window to answer a single evaluate() call. It is
// NOT the per-call cap used in shadow mode — see SKILL_ROUTING_SHADOW_BUDGET_MS
// and routeSkill's `perCallSignal` for why the two calls need different
// per-call ceilings, not just different overall ones.
export const SKILL_ROUTING_TIMEOUT_MS = 1_500;

// Shadow mode is fire-and-forget (chatTurn.ts never awaits it), so it can
// afford a much laxer overall budget than enforce mode without touching
// TTFT — it only has to be BOUNDED, not fast, so a rate-limited Jev can't
// leak an unbounded number of concurrent in-flight requests across chat
// turns. Not a config knob: unlike the enforce budget, nothing about
// deployment topology should change this number, and a hardcoded ceiling
// is one less way shadow mode's own timing could accidentally start
// affecting user-facing behavior.
//
// This is also, deliberately, the PER-CALL cap `routeSkill` uses for every
// evaluate() call it makes while running in shadow mode (see
// RouteSkillOptions.perCallTimeoutMs and routeSkill's `perCallSignal`) — not
// just the overall one. Round-3 review finding: `perCallSignal()` used to
// hardcode SKILL_ROUTING_TIMEOUT_MS (1.5s) as the per-call cap for BOTH
// modes, so two shadow-mode calls could never exceed ~3s regardless of this
// 8s ceiling — it could never bind, and worse, it censored the very data
// shadow mode exists to collect: Jev genuinely answering pass 1 in 2s under
// load became `reason: "error"` (a 1.5s timeout) instead of a real verdict.
// Passing this constant as the per-call cap too means each shadow-mode call
// is bounded only by whatever remains of the shared overall deadline
// (AbortSignal.any always takes the earliest of the two, and the overall
// deadline is always tighter once any time has elapsed) — genuinely "bounded,
// not fast," as this comment always said, rather than re-imposing enforce
// mode's TTFT-shaped cap on a path that was never on the TTFT path at all.
export const SKILL_ROUTING_SHADOW_BUDGET_MS = 8_000;

// Bounds what a single chat message can ship to a third-party vendor. The
// router only needs the shape of the request ("make a prototype of X"),
// never the payload — but a user can paste a 100 KB HTML blob, a long
// brief, or log output, and without a cap every such turn would send all of
// it: in enforce mode that is awaited on the request path, so it blows both
// the 1.5s per-call budget and the vendor bill for text that cannot change the
// pick. Truncation happens BEFORE scrubPii, never after — cutting a scrubbed
// string could slice a redaction in half and leak the tail of a match.
const MAX_ROUTED_TEXT_CHARS = 2_000;

// Same ordering rule as MAX_ROUTED_TEXT_CHARS, applied to the (already
// small, caller-assembled) tail of prior turns — see chatTurn.ts's
// buildRecentContext. Deliberately much smaller than the request text: this
// is a hint ("what was the previous message about"), not a transcript, and
// keeping the combined state small matters for Jev's own state+question
// budget (32k tokens) as much as for the vendor bill.
//
// Kept from the TAIL of the string, not the head: buildRecentContext already
// builds oldest→newest, so the tail is the message closest to the current
// turn — the one most likely to disambiguate "now do the same for the login
// screen." Slicing from the head instead (the original bug here) discarded
// exactly that message whenever the four-message window ran over budget.
const MAX_CONTEXT_CHARS = 1_000;

/** Truncates to the last `max` characters, never the first — see
 * MAX_CONTEXT_CHARS's comment. A no-op when `s` is already short enough. */
function truncateTail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

// How many SKILL.md characters of a shortlisted candidate's own body pass 2
// gets to read, on top of its full description. 700 is the value the
// cookbook measured against (docs.typesafe.ai/cookbooks/skill_suggestion) —
// enough to separate two similarly-described skills without shipping the
// whole file.
const EXCERPT_CHARS = 700;

// How many top-ranked candidates from pass 1 get a proper read in pass 2.
// The cookbook's own number — three is enough room for a full description
// plus an excerpt per option while staying well under Jev's 255-option
// Choice limit and its 32k token budget.
const SHORTLIST_SIZE = 3;

// Default gate/fits thresholds, used when a caller (chiefly tests) doesn't
// pass its own — config.ts's SKILL_ROUTING_GATE_THRESHOLD /
// SKILL_ROUTING_FITS_THRESHOLD carry the same numbers for production. Kept
// in sync deliberately: these ARE the cookbook's measured defaults
// (GATE_THRESHOLD / FITS_THRESHOLD), not independently tuned.
const DEFAULT_GATE_THRESHOLD = 0.3;
const DEFAULT_FITS_THRESHOLD = 0.3;
const DEFAULT_ENFORCE_BUDGET_MS = 2_500;

// Three Noul questions over the SAME state pass 1 sends to the Choice
// question, asking — in three different ways — whether this turn wants a
// documented workflow followed rather than an ordinary direct edit made.
// Everything in this app is "design", so a question about SUBJECT MATTER
// (the cookbook's own domain distinguished "acting on the user's system" from
// "explaining") cannot separate the two here: moving a rectangle and running
// a structured critique are both squarely "design work". These three instead
// ask about the SHAPE of the request — is a named, multi-step process called
// for, is this a substantial new piece of work rather than a tweak to
// something that exists, and (inverted) would a single direct edit already
// be enough. Their mean is the gate value (see routeSkill).
const GATE_QUESTIONS: Record<string, string> = {
  documented_workflow:
    "Would a careful designer handling this request follow a specific named workflow with " +
    "its own steps and conventions — such as running a structured critique, building a " +
    "multi-screen clickable prototype, assembling a slide deck, or porting a design from an " +
    "existing repo — rather than simply making the requested change directly?",
  substantial_new_work:
    "Is the user asking for a substantial new piece of design work — a whole new screen, a " +
    "batch of screens, a full flow, or a systematic review of existing work — rather than a " +
    "small, self-contained tweak to something that already exists?",
  direct_edit_suffices:
    "Could a competent designer fully satisfy this request with a single direct edit to the " +
    "canvas — moving, resizing, recoloring, restyling, or rewording something that already " +
    "exists — with no special process, handoff, or multi-step workflow involved?",
};

// A "yes" on this one points AWAY from needing a skill, unlike the other
// two — so its noul value must be inverted (1 - v) before averaging into
// the gate. Handled explicitly here, by name, rather than inferred: see
// jev-1.13.md's "Common-sense structural invariants" — P(x) and 1 - P(not x)
// are not guaranteed to line up, so an inverted QUESTION's raw noul is not
// automatically comparable to the others without this flip.
const INVERTED_GATE_KEYS = new Set(["direct_edit_suffices"]);

// Deliberately NOT "...if any" — this Choice does not (and, post-redesign,
// never did) offer a way to say "none of these apply"; asking it that way
// anyway dangled an answer the option set doesn't contain, nudging the model
// toward an artificially confident forced pick — exactly the number
// pass1Budget's own fit-less path exists to guard against not acting on. The
// "is a skill needed AT ALL" judgment lives entirely in the three gate Nouls
// above (see GATE_QUESTIONS's comment and the file header's Choice-vs-Noul
// distinction): a Choice only ever answers the RELATIVE question "which of
// the offered options is the closest fit," so that's the only thing this
// instruction asks it.
const CHOICE_INSTRUCTIONS =
  "Which of these skills is the closest fit for the user's latest request?";

const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. " +
  "Which one? Read what each actually does, not just its name.";

export interface SkillRouteCandidate {
  name: string;
  description: string;
  /** Full skill body (frontmatter already stripped by skills.ts), used to
   * build pass 2's fuller per-candidate criteria for the shortlisted three. */
  content: string;
}

export interface RouteSkillOptions {
  /** The user's message text (current turn only — not the full history). */
  messageText: string;
  /** Curated skills only — see the comment at the call site in chatTurn.ts
   * for why user/learned skills are deliberately excluded from this pick. */
  candidates: SkillRouteCandidate[];
  /** Minimum PEAK PROBABILITY (`max(probabilities)`, see peakProbability)
   * for pass 2's Choice winner to be treated as "real" rather than
   * low-confidence noise — see routeSkill. Despite the name (kept for
   * config-var/backward-compat reasons — this is config.ts's
   * SKILL_ROUTING_MIN_CONFIDENCE), this is NOT the vendor's `confidence`
   * field: `confidence` is a deterministic function of the peak AND the
   * option count (`(n*peak-1)/(n-1)`), so a fixed bar on it is far stricter
   * over pass 2's 3-4-candidate shortlist than it would be over pass 1's
   * full catalog. Peak probability does not have that artifact — it reads
   * the same regardless of how many candidates were on the table — which is
   * why it, not `confidence`, is what gates. The vendor `confidence` is
   * still computed and reported in the verdict (`SkillRouteVerdict.confidence`)
   * alongside the new `peak` field, so shadow logs carry both numbers. */
  threshold: number;
  /** Mean of the three gate nouls below which nothing is suggested at all
   * and pass 2 never runs. Defaults to the cookbook's own measured value. */
  gateThreshold?: number;
  /** The best per-candidate "does this specific skill fit" noul from pass 2
   * must clear this or the whole shortlist is dropped. Defaults to the
   * cookbook's own measured value. */
  fitsThreshold?: number;
  /** Wall-clock budget across BOTH passes combined. Enforce mode awaits
   * this on the request path ahead of TTFT, so it must stay small
   * (config.ts's SKILL_ROUTING_ENFORCE_BUDGET_MS); shadow mode is
   * fire-and-forget and can afford SKILL_ROUTING_SHADOW_BUDGET_MS. */
  overallBudgetMs?: number;
  /** Per-CALL cap, combined with the shared overall deadline via
   * AbortSignal.any on every evaluate() call routeSkill makes. Defaults to
   * SKILL_ROUTING_TIMEOUT_MS (1.5s) — the enforce path's TTFT-shaped bound.
   * Shadow mode passes SKILL_ROUTING_SHADOW_BUDGET_MS here instead (see its
   * comment): a fire-and-forget run is bounded overall, not per call, so
   * each of its two calls should get whatever remains of the shared budget
   * rather than being re-clipped to enforce mode's much tighter number. */
  perCallTimeoutMs?: number;
  /** Short, PII-scrubbed-by-routeSkill (not by the caller) tail of the
   * conversation immediately before this turn — see chatTurn.ts's
   * buildRecentContext. Optional so existing callers/tests are unaffected. */
  recentContext?: string;
}

export type SkillRouteReason =
  | "picked"
  | "gated"
  | "no-fit"
  | "low-confidence"
  | "unavailable"
  // Pass 1 succeeded but pass 2 never produced a considered fit check —
  // budget exhaustion, a transport failure, or a pass-2 winner outside the
  // shortlist it was actually asked about. Distinct from "error" (pass 1
  // itself failed): here pass 1's OWN winner/confidence are known and
  // reported (see pass1Winner/pass1Confidence below) for shadow-mode
  // measurement, but `skill` is always null — a pass-1-only pick has never
  // been checked against pass 2's per-candidate fit Noul, so injecting it
  // would skip exactly the check that whole pass exists to run. See
  // pass1Budget's doc comment.
  | "budget"
  | "error";

// Deliberately JSON-serializable and free of any user text or raw state —
// this is what gets logged verbatim on EVERY turn (see chatTurn.ts's
// logVerdict), in both shadow and enforce mode, so the routing behavior is
// measurable without ever putting message content in the logs.
export interface SkillRouteVerdict {
  skill: string | null;
  reason: SkillRouteReason;
  /** The winning Choice's confidence — pass 2's when pass 2 ran, otherwise
   * pass 1's (only present for "picked"/"low-confidence"/"no-fit"). This is
   * the vendor `confidence` field, reported for shadow-log analysis — `peak`
   * below is what the "low-confidence" gate actually reads. */
  confidence?: number;
  /** Pass 2 winner's PEAK PROBABILITY (`max(probabilities)`) — what the
   * "low-confidence" gate is actually compared against (see
   * RouteSkillOptions.threshold's comment for why this, not `confidence`, is
   * the right number over a 3-4-candidate shortlist). Present alongside
   * `confidence` whenever pass 2 ran, so shadow logs carry both. */
  peak?: number;
  /** Mean of the three (oriented) gate nouls from pass 1. Absent only for
   * "unavailable" (no candidates) and "error" (pass 1 itself failed). */
  gate?: number;
  /** The three gate nouls, ALREADY oriented (direct_edit_suffices inverted)
   * so a higher value always means "more likely to need a skill". */
  gateValues?: Record<string, number>;
  /** Top SHORTLIST_SIZE (name, probability) pairs from pass 1's ranking. */
  top3?: Array<[string, number]>;
  /** Per-candidate "does this skill fit" nouls from pass 2, when it ran. */
  fits?: Record<string, number>;
  /** `fits[pass2.winner]` — the specific value the no-fit gate is actually
   * compared against (see finding #1: gating on the shortlist's best fit
   * instead of the WINNER's own fit could inject a skill whose own fit was
   * low). `undefined` only in the defensive case where the winner has no
   * entry in `fits` at all, which fails the gate closed. */
  winnerFit?: number;
  model: string | null;
  pass1Ms?: number;
  pass2Ms?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Present only for reason "budget": the winner pass 1's own Choice named
   * before pass 2 ran (or before it could be trusted). NEVER injected — see
   * reason "budget"'s comment — this exists purely so shadow-mode logs can
   * measure how often the enforce budget starves pass 2 of a real fit
   * check, without that measurement ever looking like a real pick. */
  pass1Winner?: string;
  /** Pass 1's own Choice confidence for pass1Winner — see pass1Winner. */
  pass1Confidence?: number;
}

// Tools are client-executed, so one user turn arrives as several HTTP
// requests and prepareChatTurn re-resolves the same last user message on
// each of them (see lastUserIndex in chatTurn.ts — that re-resolution is
// what keeps the skill and the FIR-45 task policy alive across the loop).
// Without a cache, enforce mode would therefore pay Jev's latency and
// tokens once per STEP instead of once per turn — for an answer that
// cannot have changed, since the input to the questions is byte-identical.
// Keyed on exactly what the questions are built from, so any change to the
// text, the context, the candidate set, or a threshold is a different key
// rather than a stale hit.
const ROUTE_CACHE_TTL_MS = 10 * 60_000;

// Short-lived cache for a "budget" verdict (reason: "budget" — see
// SkillRouteReason and pass1Budget below): pass 1 succeeded but pass 2 never
// produced a considered answer (budget exhaustion, transport failure, or a
// vendor-drift winner outside the shortlist). Every step of one tool-loop
// turn must still agree — prepareChatTurn re-runs routeSkill once per STEP,
// keyed on byte-identical input, so without ANY caching here step 2 could
// re-roll the dice and get a real pass-2 answer partway through a turn that
// step 1 already decided not to route. But a "budget" verdict is a transport
// fact about ONE call, not a lasting judgment about the message — pinning it
// for the full ROUTE_CACHE_TTL_MS (10 minutes) would let one slow Jev
// response suppress routing for every OTHER turn that happens to hash to the
// same key long after this one ended. 60s splits the difference: comfortably
// longer than a realistic multi-step tool loop, far shorter than the normal
// TTL for a verdict pass 2 actually considered.
const ROUTE_CACHE_SHORT_TTL_MS = 60_000;

const ROUTE_CACHE_MAX_ENTRIES = 500;
const routeCache = new Map<string, { expiresAt: number; verdict: SkillRouteVerdict }>();

// `Skill.content` (skills.ts's parser) is ALREADY frontmatter-free by the
// time it reaches this module — the `---\n...\n---` header is split off
// there and only the body survives into `content`. A second, regex-based
// strip here used to run on that already-stripped body "just in case" — but
// applying the SAME `^---...---` pattern to real Markdown content is not a
// no-op safety net, it's a second parse that can fire on real prose: a skill
// body that legitimately opens with a `---` thematic break followed by
// another `---` (a common Markdown idiom for a divider) would have this
// treat everything up to the second `---` as leftover frontmatter and
// silently discard it — pass 2's excerpt then starts mid-document. (It used
// to also move cacheKey below, back when the key embedded a content
// excerpt directly; round-3 review replaced that with catalogFingerprint's
// length/count digest, but the mis-strip would still silently truncate what
// pass 2 actually reads, which is the real harm here.)
// Removed outright rather than made "smarter": there is nothing left to
// strip, so any match here is by construction a false positive.

/** Cheap stand-in for serializing every candidate's full body into the
 * cache key (round-3 review finding): the curated catalog getAllSkills()
 * returns is loaded once at boot and identical across every request, so its
 * bodies add no distinctness to the key beyond "this is still the same
 * catalog" — but the old key re-`JSON.stringify`d a 700-char excerpt of
 * EVERY candidate's `content` on every call, ~30 KB per chat request
 * (including every tool-loop step) and, at ROUTE_CACHE_MAX_ENTRIES (500)
 * distinct keys, up to ~15 MB retained just for that. `.length` is an O(1)
 * property read, not a re-serialization, so summing it over the candidate
 * list is negligible next to slicing+stringifying the bodies themselves; it
 * still changes if the catalog changes (a skill added/removed/edited moves
 * the count or the total length), which is all this needs to guard against
 * — the key's job is "don't reuse another catalog's verdict," not "detect
 * every possible content mutation." */
function catalogFingerprint(candidates: SkillRouteCandidate[]): string {
  let totalContentChars = 0;
  for (const c of candidates) totalContentChars += c.content.length;
  return `${candidates.length}:${totalContentChars}`;
}

function cacheKey(opts: RouteSkillOptions, gateThreshold: number, fitsThreshold: number): string {
  return JSON.stringify([
    opts.messageText.slice(0, MAX_ROUTED_TEXT_CHARS),
    truncateTail(opts.recentContext ?? "", MAX_CONTEXT_CHARS),
    opts.threshold,
    gateThreshold,
    fitsThreshold,
    catalogFingerprint(opts.candidates),
    opts.candidates
      .map((c): [string, string] => [c.name, c.description])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ]);
}

/** Test seam: the cache is module-level, so suites that assert call counts
 * must be able to start from empty. Not used in production code. */
export function resetSkillRouteCacheForTests(): void {
  routeCache.clear();
}

function isChoiceAnswer(
  answer: SystemOneAnswer | undefined,
): answer is Extract<SystemOneAnswer, { type: "choice" }> {
  return !!answer && answer.type === "choice";
}

function isNoulAnswer(
  answer: SystemOneAnswer | undefined,
): answer is Extract<SystemOneAnswer, { type: "noul" }> {
  return !!answer && answer.type === "noul";
}

/** Same vendor glitch browseStep.ts's `hasProbabilities` guards against: the
 * response schema permits an otherwise well-formed choice answer to carry
 * `probabilities: {}`. Left unguarded here, that flows straight into
 * `ranked = Object.entries({}).sort(...)` → `[]` → an empty shortlist →
 * pass1Budget with a CACHED verdict, even though pass 2 never got a chance
 * to run — the empty distribution is a malformed answer, not a considered
 * one, so it must fail the same way every other malformed pass-1 answer
 * does: an uncaught throw here is caught by routeSkill's pass-1 try/catch
 * and resolves to `reason: "error"`, uncached. */
function hasProbabilities(answer: Extract<SystemOneAnswer, { type: "choice" }>): boolean {
  return Object.keys(answer.probabilities).length > 0;
}

/** Mirrors browseStep.ts's own `peakProbability` (not exported there, so
 * duplicated rather than imported — see this module's and browseStep.ts's
 * headers for the shared reasoning): the winning Choice's peak probability,
 * `max(probabilities)`, rather than the vendor's `confidence` field. Used
 * ONLY to gate pass 2's winner (see RouteSkillOptions.threshold's comment
 * for why `confidence` is the wrong number for a 3-4-candidate shortlist) —
 * pass 1 has no equivalent gate on its Choice at all, only the separate gate
 * Nouls. */
function peakProbability(answer: Extract<SystemOneAnswer, { type: "choice" }>): number {
  const values = Object.values(answer.probabilities);
  return values.length > 0 ? Math.max(...values) : 0;
}

interface Pass1Result {
  model: string;
  winner: string;
  confidence: number;
  ranked: Array<[string, number]>;
  gate: number;
  gateValues: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

async function runPass1(
  client: SystemOneClient,
  state: Record<string, unknown>,
  candidates: SkillRouteCandidate[],
  signal: AbortSignal,
): Promise<Pass1Result> {
  const criteria: Record<string, string | null> = {};
  for (const candidate of candidates) criteria[candidate.name] = candidate.description;

  const questions: Record<string, SystemOneQuestion> = {
    which: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria },
  };
  for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
    questions[`gate::${key}`] = { type: "noul", instructions: text };
  }

  const started = Date.now();
  const { model, answers, usage } = await client.evaluate({ state, questions, signal });
  const elapsedMs = Date.now() - started;

  const which = answers.which;
  if (!isChoiceAnswer(which)) {
    throw new Error(
      `skillRouting pass 1: expected a choice answer for "which", got "${which?.type}"`,
    );
  }
  // Membership check, not a bare trust of the vendor's string — same
  // reasoning as browseStep.ts's target-index validation (finding #9
  // there): a vendor drift or a stray hallucinated name must surface as a
  // named error (caught below, resolves to `reason: "error"`, nothing
  // injected), never silently resolve to a "picked" verdict for a skill
  // that was never actually offered.
  if (!Object.prototype.hasOwnProperty.call(criteria, which.choice)) {
    throw new Error(`skillRouting pass 1: Jev picked an unknown skill "${which.choice}"`);
  }
  // Finding #3: an empty/missing probability distribution is malformed, the
  // same class of vendor glitch as a wrong answer type — must not fall
  // through into `ranked`/the shortlist below.
  if (!hasProbabilities(which)) {
    throw new Error("skillRouting pass 1: the choice answer's probability distribution was empty");
  }

  const gateValues: Record<string, number> = {};
  const oriented: number[] = [];
  for (const key of Object.keys(GATE_QUESTIONS)) {
    const answer = answers[`gate::${key}`];
    if (!isNoulAnswer(answer)) {
      throw new Error(
        `skillRouting pass 1: expected a noul answer for "gate::${key}", got "${answer?.type}"`,
      );
    }
    const value = INVERTED_GATE_KEYS.has(key) ? 1 - answer.noul : answer.noul;
    gateValues[key] = value;
    oriented.push(value);
  }

  const ranked = Object.entries(which.probabilities).sort((a, b) => b[1] - a[1]);

  return {
    model,
    winner: which.choice,
    confidence: which.confidence,
    ranked,
    gate: oriented.reduce((a, b) => a + b, 0) / oriented.length,
    gateValues,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    elapsedMs,
  };
}

interface Pass2Result {
  model: string;
  winner: string;
  confidence: number;
  /** Winner's peak probability (see peakProbability) — what the winner gate
   * actually reads; `confidence` is still carried for reporting only. */
  peak: number;
  fits: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
}

async function runPass2(
  client: SystemOneClient,
  state: Record<string, unknown>,
  shortlist: SkillRouteCandidate[],
  signal: AbortSignal,
): Promise<Pass2Result> {
  const criteria: Record<string, string | null> = {};
  for (const candidate of shortlist) {
    // candidate.content is already frontmatter-free — see the comment by
    // ROUTE_CACHE_SHORT_TTL_MS above for why this must not be re-stripped.
    const excerpt = candidate.content.slice(0, EXCERPT_CHARS);
    criteria[candidate.name] = `${candidate.description} — ${excerpt}`;
  }

  const questions: Record<string, SystemOneQuestion> = {
    which: { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria },
  };
  for (const candidate of shortlist) {
    questions[`fits::${candidate.name}`] = {
      type: "noul",
      instructions:
        `Does the skill '${candidate.name}' do the specific thing the user's request asks ` +
        `for? It is described as: ${candidate.description}`,
    };
  }

  const started = Date.now();
  const { model, answers, usage } = await client.evaluate({ state, questions, signal });
  const elapsedMs = Date.now() - started;

  const which = answers.which;
  if (!isChoiceAnswer(which)) {
    throw new Error(
      `skillRouting pass 2: expected a choice answer for "which", got "${which?.type}"`,
    );
  }
  // Same membership check as pass 1 — a winner outside the shortlist we
  // actually asked about is vendor drift, not a real pick. Throwing here is
  // caught by routeSkill's pass-2 try/catch, which resolves to `reason:
  // "budget"` (pass 1's own winner reported for measurement, nothing
  // injected) — exactly the "fail open, nothing injected on drift" behavior
  // finding #8 asks for.
  if (!Object.prototype.hasOwnProperty.call(criteria, which.choice)) {
    throw new Error(`skillRouting pass 2: Jev picked an unknown skill "${which.choice}"`);
  }
  // Same vendor glitch pass 1 (and browseStep.ts) guard against: an
  // otherwise well-formed choice answer can carry `probabilities: {}`. The
  // winner gate now reads peak probability (see peakProbability), so an
  // empty distribution here must not silently resolve to peak 0 and read as
  // a confident rejection — it's a malformed answer, same class as a wrong
  // answer type, so it throws and resolves to `reason: "budget"` via
  // routeSkill's pass-2 catch, exactly like any other pass-2 failure.
  if (!hasProbabilities(which)) {
    throw new Error("skillRouting pass 2: the choice answer's probability distribution was empty");
  }

  const fits: Record<string, number> = {};
  for (const candidate of shortlist) {
    const answer = answers[`fits::${candidate.name}`];
    if (!isNoulAnswer(answer)) {
      throw new Error(
        `skillRouting pass 2: expected a noul answer for "fits::${candidate.name}", got "${answer?.type}"`,
      );
    }
    fits[candidate.name] = answer.noul;
  }

  return {
    model,
    winner: which.choice,
    confidence: which.confidence,
    peak: peakProbability(which),
    fits,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    elapsedMs,
  };
}

// Fail-open by design: a broken, slow, or rate-limited Jev must never break
// or block a chat turn beyond its budget. Every error (including a hard
// timeout) from pass 1 is caught and turned into a `skill: null, reason:
// "error"` verdict; a pass 2 failure instead resolves to `reason: "budget"`
// (see pass1Budget) — pass 1's OWN winner/confidence are reported for
// measurement, but nothing is ever injected on this path, since a pass-1-only
// pick has never cleared pass 2's per-candidate fit check.
export async function routeSkill(
  client: SystemOneClient,
  opts: RouteSkillOptions,
): Promise<SkillRouteVerdict> {
  if (opts.candidates.length === 0) {
    return { skill: null, reason: "unavailable", model: null };
  }

  const gateThreshold = opts.gateThreshold ?? DEFAULT_GATE_THRESHOLD;
  const fitsThreshold = opts.fitsThreshold ?? DEFAULT_FITS_THRESHOLD;
  const overallBudgetMs = opts.overallBudgetMs ?? DEFAULT_ENFORCE_BUDGET_MS;

  const key = cacheKey(opts, gateThreshold, fitsThreshold);
  const hit = routeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.verdict;
  if (hit) routeCache.delete(key);

  const evict = (): void => {
    if (routeCache.size >= ROUTE_CACHE_MAX_ENTRIES) {
      // Cheap bound, not an LRU: the oldest insertion goes. Entries are
      // worthless once their turn is over, so eviction order barely
      // matters — not growing without limit does.
      const oldest = routeCache.keys().next();
      if (!oldest.done) routeCache.delete(oldest.value);
    }
  };

  const remember = (verdict: SkillRouteVerdict): SkillRouteVerdict => {
    // Only a verdict pass 2 actually produced is worth pinning at the full
    // TTL. An "error" verdict is a transport fact, not an answer about this
    // message: caching it would turn one blip into ten minutes of no
    // routing, and the very next step of the same turn is a free chance to
    // succeed. A "budget" verdict is the same class of fact, just discovered
    // one call later — see rememberShort, which pins it too, but only for a
    // SHORT TTL.
    if (verdict.reason === "error") return verdict;
    evict();
    routeCache.set(key, { expiresAt: Date.now() + ROUTE_CACHE_TTL_MS, verdict });
    return verdict;
  };

  // See ROUTE_CACHE_SHORT_TTL_MS's comment: a "budget" verdict IS cached —
  // every step of one tool-loop turn re-runs routeSkill on byte-identical
  // input and must agree on the same non-pick — but only for a short window,
  // so a single transient pass-2 blip can't suppress routing for the full
  // 10-minute TTL on a later, unrelated turn that happens to hash the same.
  const rememberShort = (verdict: SkillRouteVerdict): SkillRouteVerdict => {
    evict();
    routeCache.set(key, { expiresAt: Date.now() + ROUTE_CACHE_SHORT_TTL_MS, verdict });
    return verdict;
  };

  // Jev is a third-party vendor receiving user text, so it must never see
  // it unscrubbed — same posture as the analysis pipeline. Truncation
  // happens BEFORE scrubPii for both fields — see MAX_ROUTED_TEXT_CHARS and
  // MAX_CONTEXT_CHARS's comments.
  const state = {
    request: scrubPii(opts.messageText.slice(0, MAX_ROUTED_TEXT_CHARS)),
    recent_context: scrubPii(truncateTail(opts.recentContext ?? "", MAX_CONTEXT_CHARS)),
  };

  // One deadline shared by both calls: AbortSignal.timeout starts counting
  // from THIS line, so pass 1 and pass 2 together — not each on its own —
  // are held to overallBudgetMs. Enforce mode's caller passes
  // SKILL_ROUTING_ENFORCE_BUDGET_MS here; shadow mode passes the much
  // laxer SKILL_ROUTING_SHADOW_BUDGET_MS.
  const overallDeadline = AbortSignal.timeout(overallBudgetMs);
  // Per-call cap defaults to the enforce path's tight TTFT bound
  // (SKILL_ROUTING_TIMEOUT_MS); shadow mode passes its own, much laxer
  // SKILL_ROUTING_SHADOW_BUDGET_MS here (see chatTurn.ts's call site and
  // that constant's comment) so a call under load isn't clipped to enforce
  // mode's number just because it happens to run through the same function.
  const perCallCapMs = opts.perCallTimeoutMs ?? SKILL_ROUTING_TIMEOUT_MS;
  const perCallSignal = () => AbortSignal.any([AbortSignal.timeout(perCallCapMs), overallDeadline]);

  let pass1: Pass1Result;
  try {
    pass1 = await runPass1(client, state, opts.candidates, perCallSignal());
  } catch (err) {
    console.warn("[skillRouting] pass 1 failed, falling back to no auto-pick:", err);
    return { skill: null, reason: "error", model: null };
  }

  const top3 = pass1.ranked.slice(0, SHORTLIST_SIZE);

  if (pass1.gate < gateThreshold) {
    return remember({
      skill: null,
      reason: "gated",
      model: pass1.model,
      gate: pass1.gate,
      gateValues: pass1.gateValues,
      top3,
      pass1Ms: pass1.elapsedMs,
      inputTokens: pass1.inputTokens,
      outputTokens: pass1.outputTokens,
    });
  }

  // Findings #1/#2: a pass-1-only fallback must NEVER inject — it has never
  // been checked against pass 2's per-candidate fit Noul, which is exactly
  // the check that stops a forced pass-1 winner (see CHOICE_INSTRUCTIONS's
  // comment: pass 1's Choice has no "none" option, so it names SOME winner
  // for every message) from reaching the model unvetted. `skill` is always
  // null; pass 1's own winner/confidence are still reported, in DEDICATED
  // fields, so shadow-mode logs can measure how often the enforce budget
  // starves pass 2 without that measurement ever being mistaken for a pick.
  // Cached — see rememberShort's comment — under the short TTL.
  const pass1Budget = (): SkillRouteVerdict =>
    rememberShort({
      skill: null,
      reason: "budget",
      pass1Winner: pass1.winner,
      pass1Confidence: pass1.confidence,
      model: pass1.model,
      gate: pass1.gate,
      gateValues: pass1.gateValues,
      top3,
      pass1Ms: pass1.elapsedMs,
      inputTokens: pass1.inputTokens,
      outputTokens: pass1.outputTokens,
    });

  // Finding #4: `top3` is ranked by `probabilities`, but nothing enforces
  // that `which.choice` (pass1.winner) is that distribution's argmax —
  // `choice` and `probabilities` are separate fields in the vendor's
  // response. Without this union, a winner that fell just outside the top 3
  // by probability would be absent from pass 2's shortlist entirely, so
  // pass2's own membership check on `which.choice` (see runPass2) would
  // reject it as "unknown" even though it's a real, valid candidate — and
  // pass1.winner is ALWAYS a real candidate by this point (pass 1's own
  // membership check on `which.choice` already validated it), so
  // `byName.get(pass1.winner)` below can never miss.
  const byName = new Map(opts.candidates.map((c) => [c.name, c] as const));
  const shortlistNames = new Set<string>([...top3.map(([name]) => name), pass1.winner]);
  const shortlist = Array.from(shortlistNames)
    .map((name) => byName.get(name))
    .filter((c): c is SkillRouteCandidate => c !== undefined);

  if (shortlist.length === 0) {
    // Genuinely unreachable now, not merely assumed to be: pass1.winner is
    // unconditionally unioned into shortlistNames above (finding #4) and is
    // guaranteed to resolve via byName (pass 1 already validated it against
    // opts.candidates), so shortlist can never end up empty. (The previous
    // comment here — "should be unreachable in practice" — was wrong: before
    // the union fix, a probabilities map whose top-3 keys were all vendor
    // drift outside opts.candidates COULD empty the shortlist while leaving
    // the validated `which.choice` winner stranded off it.) Kept only as a
    // defensive backstop against a future change breaking that invariant.
    return pass1Budget();
  }

  let pass2: Pass2Result;
  try {
    pass2 = await runPass2(client, state, shortlist, perCallSignal());
  } catch (err) {
    console.warn(
      "[skillRouting] pass 2 failed or the overall budget ran out, resolving to reason \"budget\":",
      err,
    );
    return pass1Budget();
  }

  // Gate on the WINNER's own fit, not the shortlist's best fit — those can
  // diverge whenever pass 2's Choice winner isn't the candidate with the
  // highest per-candidate Noul (finding #1). A missing entry for the winner
  // (should be unreachable, since fits is built from the same shortlist the
  // Choice ran over) fails closed rather than passing on `undefined <
  // fitsThreshold` evaluating to false.
  const winnerFit = pass2.fits[pass2.winner];
  const base = {
    model: pass2.model,
    gate: pass1.gate,
    gateValues: pass1.gateValues,
    top3,
    fits: pass2.fits,
    pass1Ms: pass1.elapsedMs,
    pass2Ms: pass2.elapsedMs,
    inputTokens: pass1.inputTokens + pass2.inputTokens,
    outputTokens: pass1.outputTokens + pass2.outputTokens,
    // Vendor `confidence` is a deterministic function of peak AND option
    // count — see peakProbability's/RouteSkillOptions.threshold's comments
    // — so it must not be what the "low-confidence" gate below reads. `peak`
    // is reported here (alongside `confidence`, set below) so it flows into
    // every terminal verdict pass 2 actually produced, not just "picked".
    peak: pass2.peak,
  };

  if (winnerFit === undefined || winnerFit < fitsThreshold) {
    // Reports what was actually gated on (the winner's own fit), not the
    // shortlist's unrelated best fit — see the comment above.
    return remember({
      skill: null,
      reason: "no-fit",
      confidence: pass2.confidence,
      winnerFit,
      ...base,
    });
  }
  // Gate on the winner's PEAK PROBABILITY, not the vendor `confidence` field
  // (round-3 review finding, same option-count artifact browseStep.ts's
  // peakProbability comment describes): `confidence` over pass 2's 3-4-item
  // shortlist demands a much higher peak than the same `confidence` bar did
  // over pass 1's full catalog, so a correctly shortlisted winner at, say,
  // peak 0.75 could fail a threshold tuned against a much larger candidate
  // set. Peak reads the same regardless of shortlist size. `confidence` is
  // still reported in the verdict (`base.peak` above carries the peak
  // alongside it) so shadow logs keep both numbers.
  if (pass2.peak < opts.threshold) {
    return remember({
      skill: null,
      reason: "low-confidence",
      confidence: pass2.confidence,
      winnerFit,
      ...base,
    });
  }
  return remember({
    skill: pass2.winner,
    reason: "picked",
    confidence: pass2.confidence,
    winnerFit,
    ...base,
  });
}
