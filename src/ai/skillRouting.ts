import type { SystemOneClient } from "../services/systemone.js";
import { scrubPii } from "../analysis/pii.js";

// Jev-backed auto-pick of which skill (if any) a user's message is asking
// for. Today the model spends a whole extra round trip on this: it reads
// the "Available Skills" catalog in the system prompt, emits a load_skill
// tool call, gets the result, then continues. This lets prepareChatTurn
// inject the skill up front — skipping that round trip — when the pick is
// confident enough to act on (see SKILL_ROUTING_MIN_CONFIDENCE in
// config.ts). House style (fail-open, verdict shape, PII handling) mirrors
// src/analysis/triage.ts, the other Jev consumer.

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

  const criteria: Record<string, string | null> = { [NONE_OPTION]: NONE_DESCRIPTION };
  for (const candidate of opts.candidates) {
    criteria[candidate.name] = candidate.description;
  }

  try {
    const { model, answers } = await client.evaluate({
      // Same privacy posture as triage.ts: Jev is a third-party vendor
      // receiving user text, so it must never see it unscrubbed.
      state: scrubPii(opts.messageText),
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
      return { skill: null, confidence: answer.confidence, model, reason: "none" };
    }
    if (answer.confidence < opts.threshold) {
      return { skill: null, confidence: answer.confidence, model, reason: "low-confidence" };
    }
    return { skill: answer.choice, confidence: answer.confidence, model, reason: "picked" };
  } catch (err) {
    console.warn("[skillRouting] route failed, falling back to no auto-pick:", err);
    return { skill: null, confidence: 0, model: null, reason: "error" };
  }
}
