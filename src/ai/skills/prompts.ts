import { MEMORY_REVIEW_PROMPT } from "../memory/prompts.js";

// Trailing user message of the background review run when only the skill
// counter fired. Ported verbatim (Hermes). Do not paraphrase: the bias
// against creating new skills, and the do-not-capture list, are the two
// things standing between this loop and a library full of
// "fix-the-thing-2026-08-11" entries.
export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich body. Not a long flat list of narrow one-session-one-skill entries. This shapes HOW you update, not WHETHER you update.

Signals that warrant action (any one is enough): the user corrected your style, tone, format, or verbosity (frustration signals like 'stop doing X' are FIRST-CLASS skill signals); the user corrected your workflow; a non-trivial technique, fix, or workaround emerged; a skill consulted this session was wrong or outdated — patch it NOW.

Preference order — a strong bias against creating new skills:
1. UPDATE A SKILL THAT WAS LOADED THIS SESSION — it is the skill that was in play.
2. UPDATE AN EXISTING SKILL that covers this class of task (check the catalog, view it first).
3. Only when nothing covers the class: CREATE A NEW CLASS-LEVEL SKILL. The name MUST NOT be a specific error string, feature codename, or 'fix-X / debug-Y-today' session artifact. If the proposed name only makes sense for today's task, it's wrong — fall back to (1) or (2).

Do NOT capture: environment-dependent failures (missing binaries, 'command not found'); negative claims about tools — these harden into refusals the agent cites against itself for months after the actual problem was fixed; transient errors that resolved; one-off task narratives; unresolved failures — do NOT write failed attempts up as a 'reliable workflow'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat.

'Nothing to save.' is a real option but should NOT be the default.`;

// The trailing tool-restriction sentence used to be baked into
// SKILL_REVIEW_PROMPT itself, unconditionally claiming "you can call skill
// AND memory management tools." That's only true when MEMORY_ENABLED is on
// — a supported deployment can run with SELF_SKILLS_ENABLED alone, and in
// that shape the review's tool set never gets a `memory` entry (see
// maybeRunReview in selfimprove/review.ts). The model followed the prompt
// literally, called `memory` anyway, and hit a hard NoSuchToolError that
// aborted the whole review after the counter had already been reset — so
// the wording has to match what tools are ACTUALLY offered this run, not
// what subsystem happens to be due.
function skillToolsAvailabilityLine(memoryAvailable: boolean): string {
  return memoryAvailable
    ? "You can only call skill and memory management tools. Other tools will be denied at runtime — do not attempt them."
    : "You can only call skill management tools here — there is no memory tool in this run (persistent memory is disabled for this deployment). Other tools, including memory, will be denied at runtime — do not attempt them.";
}

/** SKILL_REVIEW_PROMPT plus the tool-restriction sentence appropriate to
 * whether `memory` actually exists in this review run's tool set —
 * MEMORY_ENABLED, not `due.memoryDue` (a skill-only review still gets the
 * real `memory` tool whenever memory is enabled at all; see the whitelist
 * comment in maybeRunReview). */
export function buildSkillReviewPrompt(memoryAvailable: boolean): string {
  return `${SKILL_REVIEW_PROMPT}\n\n${skillToolsAvailabilityLine(memoryAvailable)}`;
}

// Joins the memory half to the skill half when both counters fire in the same
// request. Without it the model treats the second half as a restatement of the
// first and writes the same lesson into memory twice.
export const MEMORY_SKILL_BRIDGE = `Memory captures 'who the user is and what the current situation and state of your operations are'; skills capture 'how to do this class of task for this user'. When the user complains about how you handled a task, update the skill that governs that task — memory alone isn't enough.`;

export function buildCombinedReviewPrompt(): string {
  // Combined only ever fires when due.memoryDue is true, which itself only
  // happens when MEMORY_ENABLED is on (see the due-gate in review.ts) — so
  // memory is always genuinely available here.
  return `${MEMORY_REVIEW_PROMPT}\n\n${MEMORY_SKILL_BRIDGE}\n\n${buildSkillReviewPrompt(true)}`;
}

// Picks which trailing user message the background review run gets, based on
// which counter(s) actually crossed their threshold this request. Combined
// when both fired in the same request (rare but possible — a long turn can
// cross the memory-turns and skill-steps thresholds together); otherwise
// whichever single half is due. Neither due → null, and the caller skips the
// review run entirely rather than spending a generateText call on nothing.
//
// `memoryAvailable` is whether the `memory` tool actually exists in this
// review's tool set (i.e. config.MEMORY_ENABLED) — independent of whether
// memory happens to be DUE this request. The review's tool whitelist adds
// `memory` whenever the subsystem is enabled at all (see maybeRunReview), so
// a skill-only review can still legitimately have it; the prompt text must
// agree with the tool set it's actually paired with either way.
export function selectReviewPrompt(
  due: { memoryDue: boolean; skillDue: boolean },
  memoryAvailable: boolean,
): string | null {
  if (due.memoryDue && due.skillDue) return buildCombinedReviewPrompt();
  if (due.memoryDue) return MEMORY_REVIEW_PROMPT;
  if (due.skillDue) return buildSkillReviewPrompt(memoryAvailable);
  return null;
}
