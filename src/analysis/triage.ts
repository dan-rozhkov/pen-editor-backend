import type {
  SystemOneClient,
  SystemOneNoulQuestion,
} from "../services/systemone.js";
import { scrubPii } from "./pii.js";

// A cheap pre-filter in front of the expensive per-session extractInsights()
// call (src/analysis/insights.ts). Jev (TypeSafe AI's "System One" model) is
// asked four yes/no ("noul") questions — one per sessionInsightsSchema
// category — in a SINGLE evaluate() call, since the vendor evaluates
// questions in parallel ("speculative fan-out"): four questions cost barely
// more than one. Wording below mirrors INSIGHTS_SYSTEM in insights.ts so the
// cheap pass and the expensive pass agree on what counts.

// Triage does not need the full 200k-char transcript the big model gets —
// pass this as renderSessionText's maxChars so its existing head+tail
// truncation keeps BOTH ends of the session (a correction often lands right
// at the end — never truncate tail-only).
export const TRIAGE_MAX_CHARS = 40_000;

const TRIAGE_QUESTIONS: Record<string, SystemOneNoulQuestion> = {
  errors: {
    type: "noul",
    instructions:
      "In this session between a user and an AI design agent that edits a canvas via tools, did any tool call fail or return an error?",
    criteria: {
      true: "At least one tool call failed, returned an error, or the trace records a stream error.",
      false: "Every tool call in the session succeeded; no errors appear anywhere in the trace.",
    },
  },
  corrections: {
    type: "noul",
    instructions:
      "In this session, did the user push back on or correct something the agent did?",
    criteria: {
      true: "The user objected to, corrected, or asked the agent to redo/change something it had just done.",
      false: "The user never pushed back on or corrected any agent action.",
    },
  },
  memory_requests: {
    type: "noul",
    instructions:
      "In this session, did the user ask the agent to remember something, or to always/never do something going forward?",
    criteria: {
      true: 'The user asked the agent to remember a fact or preference, or said something like "always do X" / "never do Y".',
      false: "The user never asked the agent to remember or persistently follow a rule.",
    },
  },
  agent_claims: {
    type: "noul",
    instructions:
      "In this session, did the agent state something about itself — a limitation, an assumption, a plan, or a conclusion?",
    criteria: {
      true: "The agent explicitly said something about its own limitations, assumptions, plans, or conclusions.",
      false: "The agent never made a statement about itself; it only performed actions.",
    },
  },
};

export type TriageVerdict = {
  decision: "skip" | "extract";
  scores: Record<string, number>;
  max: number;
  model: string | null;
  reason: "scored" | "unavailable" | "error";
};

// Fail-open by design: a broken or rate-limited Jev must NEVER cause a
// session's insights to be dropped. Every error from the client is caught
// here and turned into an "extract" verdict — losing insight data silently
// is the exact failure mode this function exists to guard against.
export async function triageSession(
  client: SystemOneClient,
  sessionText: string,
  threshold: number,
): Promise<TriageVerdict> {
  try {
    const { model, answers } = await client.evaluate({
      // Same privacy posture as the expensive extractInsights() call: Jev is
      // a new third-party vendor receiving user transcripts, so it must
      // never see unscrubbed text.
      state: scrubPii(sessionText),
      questions: TRIAGE_QUESTIONS,
    });
    const scores: Record<string, number> = {};
    for (const key of Object.keys(TRIAGE_QUESTIONS)) {
      const answer = answers[key];
      // Every TRIAGE_QUESTIONS entry is a "noul" question, but the client's
      // response schema accepts any of the three answer shapes for any id —
      // a vendor change or mis-keyed answer could return "choice"/"score"
      // here. Scoring that as 0 would silently bias toward "skip" (see the
      // fail-open contract below); throwing into the catch instead forces
      // this session through "extract", never through a fabricated zero.
      if (answer.type !== "noul") {
        throw new Error(
          `System One returned an unexpected answer type "${answer.type}" for noul question "${key}".`,
        );
      }
      scores[key] = answer.noul;
    }
    const max = Math.max(...Object.values(scores));
    const decision: TriageVerdict["decision"] =
      Object.values(scores).every((score) => score < threshold) ? "skip" : "extract";
    return { decision, scores, max, model, reason: "scored" };
  } catch (err) {
    console.warn("[analyze] triage failed, falling back to extraction:", err);
    return { decision: "extract", scores: {}, max: 0, model: null, reason: "error" };
  }
}
