import type { SystemOneClient } from "../services/systemone.js";
import { scrubPii } from "../analysis/pii.js";

// Jev-backed auto-pick of which skill (if any) a user's message is asking
// for. Today the model spends a whole extra round trip on this: it reads
// the "Available Skills" catalog in the system prompt, emits a load_skill
// tool call, gets the result, then continues. This lets prepareChatTurn
// inject the skill up front — skipping that round trip — when the pick is
// confident enough to act on (see SKILL_ROUTING_MIN_CONFIDENCE in
// config.ts). House style mirrors src/analysis/embeddings.ts: fail-open,
// scrub before sending, never let an optional vendor break the caller.

// This sits in the hot path of every chat request, ahead of the first
// streamed token (TTFT). 1.5s is a deliberate budget for that, not an
// arbitrary number — chosen to be small next to a multi-second LLM turn
// while still giving Jev a realistic window to answer.
export const SKILL_ROUTING_TIMEOUT_MS = 1_500;

// The option the model picks when the message doesn't match any listed
// skill — which is the common case, since most chat turns are ordinary
// edits, not a skill invocation. Without an explicit "none" choice a
// `choice` question forces a pick among the real skills and would misfire
// constantly.
const NONE_OPTION = "none";
// Bounds what a single chat message can ship to a third-party vendor. The
// router only needs the shape of the request ("make a prototype of X"),
// never the payload — but a user can paste a 100 KB HTML blob, a long
// brief, or log output, and without a cap every such turn would send all of
// it: in enforce mode that is awaited on the request path, so it blows both
// the 1.5s TTFT budget and the vendor bill for text that cannot change the
// pick. Truncation happens BEFORE scrubPii, never after — cutting a scrubbed
// string could slice a redaction in half and leak the tail of a match.
const MAX_ROUTED_TEXT_CHARS = 2_000;
const NONE_DESCRIPTION =
  "The message does not clearly match any of the other listed skills — handle it normally, without invoking a skill.";

export interface SkillRouteCandidate {
  name: string;
  description: string;
}

export interface RouteSkillOptions {
  /** The user's message text (current turn only — not the full history). */
  messageText: string;
  /** Curated skills only — see the comment at the call site in chatTurn.ts
   * for why user/learned skills are deliberately excluded from this pick. */
  candidates: SkillRouteCandidate[];
  /** Minimum confidence for the pick to be treated as a "real" pick rather
   * than low-confidence noise. */
  threshold: number;
}

export type SkillRouteVerdict = {
  skill: string | null;
  confidence: number;
  model: string | null;
  reason: "picked" | "none" | "low-confidence" | "unavailable" | "error";
};

const ROUTING_QUESTION_ID = "skill";

// Tools are client-executed, so one user turn arrives as several HTTP
// requests and prepareChatTurn re-resolves the same last user message on
// each of them (see lastUserIndex in chatTurn.ts — that re-resolution is
// what keeps the skill and the FIR-45 task policy alive across the loop).
// Without a cache, enforce mode would therefore pay Jev's latency and
// tokens once per STEP instead of once per turn — ~280ms added to every
// step's time-to-first-token for an answer that cannot have changed, since
// the input to the question is byte-identical. Keyed on exactly what the
// question is built from, so any change to the text, the catalog or the
// threshold is a different key rather than a stale hit.
const ROUTE_CACHE_TTL_MS = 10 * 60_000;
const ROUTE_CACHE_MAX_ENTRIES = 500;
const routeCache = new Map<string, { expiresAt: number; verdict: SkillRouteVerdict }>();

function cacheKey(opts: RouteSkillOptions): string {
  return JSON.stringify([
    opts.messageText.slice(0, MAX_ROUTED_TEXT_CHARS),
    opts.threshold,
    opts.candidates.map((c) => c.name).sort(),
  ]);
}

/** Test seam: the cache is module-level, so suites that assert call counts
 * must be able to start from empty. Not used in production code. */
export function resetSkillRouteCacheForTests(): void {
  routeCache.clear();
}

// Fail-open by design: a broken, slow, or rate-limited Jev must never break
// or block a chat turn. Every error (including the hard timeout below) is
// caught here and turned into a `skill: null` verdict — the model can still
// call load_skill itself exactly as it does today.
export async function routeSkill(
  client: SystemOneClient,
  opts: RouteSkillOptions,
): Promise<SkillRouteVerdict> {
  if (opts.candidates.length === 0) {
    return { skill: null, confidence: 0, model: null, reason: "unavailable" };
  }

  const key = cacheKey(opts);
  const hit = routeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.verdict;
  if (hit) routeCache.delete(key);

  const criteria: Record<string, string | null> = { [NONE_OPTION]: NONE_DESCRIPTION };
  for (const candidate of opts.candidates) {
    // Skills are plain Markdown files with no name guard, so nothing stops
    // someone adding src/skills/none.md — which would overwrite the sentinel
    // and make the vendor's `choice === "none"` mean two different things at
    // once ("no match" and "the user asked for the none skill"). The skill
    // would become permanently unroutable AND every ambiguous message would
    // read as a deliberate decline. Refuse the collision instead: the skill
    // stays reachable via load_skill, exactly like user and learned skills.
    if (candidate.name === NONE_OPTION) {
      console.warn(
        `[skillRouting] skill "${NONE_OPTION}" collides with the no-match sentinel and is excluded from auto-pick; rename it to make it routable`,
      );
      continue;
    }
    criteria[candidate.name] = candidate.description;
  }

  const remember = (verdict: SkillRouteVerdict): SkillRouteVerdict => {
    // Only a verdict Jev actually produced is worth pinning. An "error"
    // verdict is a transport fact, not an answer about this message:
    // caching it would turn one blip into ten minutes of no routing, and
    // the very next step of the same turn is a free chance to succeed.
    if (verdict.reason === "error") return verdict;
    if (routeCache.size >= ROUTE_CACHE_MAX_ENTRIES) {
      // Cheap bound, not an LRU: the oldest insertion goes. Entries are
      // worthless once their turn is over, so eviction order barely
      // matters — not growing without limit does.
      const oldest = routeCache.keys().next();
      if (!oldest.done) routeCache.delete(oldest.value);
    }
    routeCache.set(key, { expiresAt: Date.now() + ROUTE_CACHE_TTL_MS, verdict });
    return verdict;
  };

  try {
    const { model, answers } = await client.evaluate({
      // Jev is a third-party vendor receiving user text, so it must never
      // see it unscrubbed — same posture as the analysis pipeline.
      state: scrubPii(opts.messageText.slice(0, MAX_ROUTED_TEXT_CHARS)),
      questions: {
        [ROUTING_QUESTION_ID]: {
          type: "choice",
          instructions:
            "Which of these skills, if any, does the user's message ask for? Pick 'none' if it does not clearly match one.",
          criteria,
        },
      },
      signal: AbortSignal.timeout(SKILL_ROUTING_TIMEOUT_MS),
    });

    const answer = answers[ROUTING_QUESTION_ID];
    // The client's response schema accepts a noul/score answer for any
    // question id, so a vendor change or mis-keyed answer could return one
    // of those here instead of the "choice" this question asked for — in
    // which case `.choice`/`.confidence` would be undefined and neither
    // branch below would fire, returning a "picked" verdict with an
    // undefined skill/confidence that would throw in any caller reading
    // `verdict.confidence.toFixed(2)`. Fail open instead, exactly like the
    // timeout/network catch below.
    if (answer.type !== "choice") {
      console.warn(
        `[skillRouting] unexpected answer type "${answer.type}" for a choice question; falling back to no auto-pick`,
      );
      return { skill: null, confidence: 0, model, reason: "error" };
    }
    if (answer.choice === NONE_OPTION) {
      return remember({ skill: null, confidence: answer.confidence, model, reason: "none" });
    }
    if (answer.confidence < opts.threshold) {
      return remember({ skill: null, confidence: answer.confidence, model, reason: "low-confidence" });
    }
    return remember({ skill: answer.choice, confidence: answer.confidence, model, reason: "picked" });
  } catch (err) {
    console.warn("[skillRouting] route failed, falling back to no auto-pick:", err);
    return { skill: null, confidence: 0, model: null, reason: "error" };
  }
}
