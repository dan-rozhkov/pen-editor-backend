import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import type { Config } from "../../config.js";
import { logSession } from "../../logging.js";
import { createModel } from "../provider.js";
import { MEMORY_REVIEW_INTERVAL, type MemoryStore } from "../memory/store.js";
import { createMemoryToolContext, getMemoryTools, memoryInputSchema } from "../memory/tool.js";
import { renderMemorySnapshot } from "../memory/render.js";
import { selectReviewPrompt } from "../skills/prompts.js";
import type { LearnedSkillStore } from "../skills/learnedStore.js";
import { createSkillRunContext } from "../skills/runContext.js";
import { getSelfSkillTools } from "../skills/tool.js";
import type { TraceQueryable } from "../../tracing/traceStore.js";

const REVIEW_MAX_STEPS = 8;

/** Phase 2 (self-authored skills): the review fires every this many
 * accumulated tool steps, tracked in agent_review_state.steps_since_skill
 * (bumped unconditionally by MemoryStore.bumpCounters; this is only the
 * due-threshold). Independent of MEMORY_REVIEW_INTERVAL, which counts USER
 * TURNS, not tool steps — skills are learned from how a task went, which
 * tracks with how much tool-calling happened, not how many messages it took. */
export const SKILL_REVIEW_INTERVAL = 15;

// Background review, no user waiting on it — but it must not hold a
// multi-MB transcript (modelMessages can carry base64 image parts from
// earlier turns) in memory forever if the provider hangs. 90s is generous
// for an 8-step tool loop against a normal provider while still bounding
// the worst case. Overridable per-call (`reviewTimeoutMs`) so tests don't
// have to actually wait 90s to exercise the timeout path.
const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;

// Generic stub message for a client-executed pen tool the model reached for
// mid-review. NOT specific to "only the memory tool runs here" — which
// subsystems actually run depends on what's enabled (memory-only,
// skill-only, or both; see the reviewTools assembly below), so a blanket
// claim about which ONE tool is available would just be wrong for the other
// two cases. It only needs to say "not this one," not name the alternative.
const REVIEW_TOOL_UNAVAILABLE =
  "This tool is not available during a background self-improvement review. Ignore the system prompt's tool-usage instructions for this turn.";

// Second line of defense for the `memory` tool specifically: SKILL_REVIEW_PROMPT's
// wording is conditioned on whether `memory` actually exists in reviewTools
// (see prompts.ts's buildSkillReviewPrompt), but a model can still reach for
// it despite correct instructions — a stale system-prompt fragment, or just
// not reading closely. Without this stub, turnTools (built from the ACTUAL
// turn's tool set) has no `memory` entry at all when MEMORY_ENABLED is off,
// so buildReviewToolStubs has nothing to swap in, and the call would hit a
// hard NoSuchToolError instead of a harmless string result — see the
// "Prompt: SKILL_REVIEW_INTERVAL" fix in the finding this addresses.
const MEMORY_TOOL_UNAVAILABLE =
  "Persistent memory is disabled for this deployment — there is no memory tool in this run. Ignore any instruction that says otherwise.";

// The turn's FULL system prompt (`system` below) is reused verbatim to keep
// the provider's prefix cache warm — see the comment on `system` in
// MaybeRunReviewInput. That prompt's FIRST DECISION / Mandatory-flow text
// tells the model to call load_skill, get_editor_state, get_variables, etc.
// before doing anything else — and since `system` is shared with `/api/chat`
// verbatim, it can steer the model toward ANY tool the real turn advertised:
// not just `penTools`, but also `load_skill` (getSkillTools()), MCP tools,
// and web tools — whichever ones `prepareChatTurn` assembled for this turn.
// Handing the review run a stub set built from only `penTools` (as before)
// means the model reaching for `load_skill` or an MCP tool — exactly what
// the prompt tells it to do — gets a hard `NoSuchToolError` from the AI SDK,
// and the whole review is aborted rather than just skipping the save. Worse,
// by the time that throw happens `store.bumpCounters` has already reset the
// turn counter, so the user silently gets no review for another
// MEMORY_REVIEW_INTERVAL turns.
//
// Fix: stub every client-executed tool from the ACTUAL turn tool set passed
// in as `turnTools` (same trick as src/showcase/runner.ts, which faces the
// identical problem running generateText() outside a browser) so an
// off-script tool call gets a harmless string result instead of throwing.
// Tools that already run on the backend (get_guidelines, get_style_guide*,
// the real memory tool, ...) are left untouched — they still execute for
// real, which is harmless (read-only, or the memory tool itself, which gets
// overwritten with the review's own context by the caller anyway).
function buildReviewToolStubs(turnTools: ToolSet): ToolSet {
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(turnTools)) {
    const entry = def as { execute?: unknown };
    // Already runnable server-side (get_guidelines, get_style_guide*, ...):
    // pass it through verbatim so it still executes for real, exactly as it
    // would in the real turn — only the client-executed tools below get a
    // stub swapped in.
    result[name] = typeof entry.execute === "function"
      ? def
      : { ...(def as object), execute: async () => REVIEW_TOOL_UNAVAILABLE };
  }
  return result as ToolSet;
}

export interface MaybeRunReviewInput {
  config: Config;
  store: MemoryStore | null;
  userId: string | undefined;
  /** The turn's exact system string — reused verbatim to keep the provider's
   * prefix cache warm for the review run. */
  system: string;
  /** The exact tool set assembled for this turn by prepareChatTurn, so the
   * review's stubs cover every tool the shared system prompt might steer
   * the model toward — load_skill, MCP tools, web tools — not just
   * penTools. See the comment on buildReviewToolStubs for the failure this
   * prevents. */
  turnTools: ToolSet;
  modelMessages: ModelMessage[];
  /** The assistant text the user just received; appended so the review sees
   * the complete exchange, not just the request. */
  assistantText: string;
  stepCount: number;
  modelOverride?: string;
  /**
   * True only when this HTTP request's final step made no tool calls — i.e.
   * the model gave its actual reply to the user rather than dispatching a
   * client-executed tool call the browser still has to run and resend.
   *
   * The frontend's `lastAssistantMessageIsCompleteWithToolCalls` means one
   * user message can span 8-12 `POST /api/chat` requests (one per
   * client-tool round trip). Without this flag, `turns_since_memory` was
   * bumped on every one of those requests — so with
   * MEMORY_REVIEW_INTERVAL = 10 the review fired almost every user message,
   * often mid-turn, where `assistantText` is empty and the transcript ends
   * user → user instead of a real exchange. Gating the bump itself (not just
   * the review run) on turnComplete is what makes the counter mean "user
   * turns", matching its name and the interval it's compared against.
   */
  turnComplete: boolean;
  /** Overrides DEFAULT_REVIEW_TIMEOUT_MS — test-only knob so the timeout
   * path can be exercised without actually waiting 90s. */
  reviewTimeoutMs?: number;
  /**
   * Phase 2: learned-skill store for skill_manage/skill_view during the
   * review run. Undefined/null → the skill half of the review is skipped
   * even if SELF_SKILLS_ENABLED is on (mirrors `store` being required for
   * the memory half).
   */
  learnedSkillStore?: LearnedSkillStore | null;
  /**
   * Phase 2: direct Postgres handle skill_manage/skill_view use for their
   * own agent_selfimprove_audit writes (agent_skills has no per-target key
   * like memory's (user_id, target), so it has no equivalent to
   * MemoryStore.writeAudit — see src/ai/selfimprove/auditDb.ts).
   */
  auditDb?: TraceQueryable | null;
}

export type ReviewOutcome = "disabled" | "mid-turn" | "not-due" | "ran" | "timed-out";

// Fire-and-forget from the chat route's onFinish. The user's response has
// already streamed by the time this runs, so every failure path here is a
// log line and nothing more.
//
// The review transcript is NEVER persisted into a user-visible session: a
// stored review prompt turns the agent into "the curator" on the next real
// turn (Hermes learned this the hard way). It also never triggers itself —
// this function is called from the chat route only.
export async function maybeRunReview(
  input: MaybeRunReviewInput,
): Promise<ReviewOutcome> {
  const { config, store, userId } = input;
  // `store` (MemoryStore) is the shared counters/audit handle for BOTH
  // subsystems — see the "Gated on MEMORY_ENABLED || SELF_SKILLS_ENABLED"
  // comment in app.ts. So the precondition here is "no userId, no store, or
  // NEITHER subsystem is on", not "memory specifically is off" — a
  // skills-only deployment (MEMORY_ENABLED false) must still be able to run.
  if (!userId || !store) return "disabled";
  if (!config.MEMORY_ENABLED && !config.SELF_SKILLS_ENABLED) return "disabled";

  try {
    // Bump on EVERY request, mid-turn or not — a single user message can
    // span many `POST /api/chat` round-trips (one per client-executed tool
    // call the browser has to run and resend), and each of those carries
    // its own `stepCount`. Only bumping on the final, turnComplete request
    // (as this used to) meant `steps_since_skill` only ever accumulated the
    // LAST request's step count (usually 1, since the final step by
    // definition made no tool calls) — "every 15 tool-call steps" collapsed
    // into "every ~15 user turns" and lost exactly the sensitivity to
    // how much tool-calling a task took that steps were introduced for.
    // `turns` still only increments on the completed request — mid-turn
    // requests are not user turns, they're continuations of one — so
    // `turns_since_memory`'s meaning is unaffected.
    const counters = await store.bumpCounters({
      userId,
      turns: input.turnComplete ? 1 : 0,
      steps: input.stepCount,
      memoryInterval: MEMORY_REVIEW_INTERVAL,
      // Only check (and possibly reset) the skill due-threshold on the
      // COMPLETED request — omitting skillInterval mid-turn still lets
      // steps_since_skill accumulate (that increment is unconditional in
      // the UPDATE, see bumpCounters' own doc comment) but skips the
      // due-check/reset that only makes sense once the turn is actually
      // over and a review could run. Checking due mid-turn would let a
      // threshold crossed mid-turn get silently reset with no review ever
      // firing for it.
      ...(config.SELF_SKILLS_ENABLED && input.turnComplete
        ? { skillInterval: SKILL_REVIEW_INTERVAL }
        : {}),
    });

    // Do not run (or even evaluate due-ness for) a review on a mid-turn
    // continuation request — see the `turnComplete` doc comment. The bump
    // above already happened either way, which is the whole point of this
    // fix: accumulation no longer waits for turnComplete, only the review
    // itself does.
    if (!input.turnComplete) return "mid-turn";

    // The counter itself accumulates unconditionally above (steps_since_skill
    // and turns_since_memory both always bump) — flipping a flag on later
    // does not need a fresh user to start firing. But a DUE decision still
    // requires the flag: bumpCounters can report a threshold crossed for a
    // subsystem that is nonetheless off (e.g. turns_since_memory can cross
    // memoryInterval and get silently RESET by bumpCounters even while
    // MEMORY_ENABLED is off — the interval math has no idea about the flag
    // — so a later flip-on does not inherit whatever had already
    // accumulated before the flip), and that reported due-ness must never
    // be allowed to fire a review for a disabled subsystem.
    const due = {
      memoryDue: config.MEMORY_ENABLED && counters.memoryReviewDue,
      skillDue: config.SELF_SKILLS_ENABLED && Boolean(counters.skillReviewDue),
    };
    const reviewPromptBase = selectReviewPrompt(due, config.MEMORY_ENABLED);
    if (!reviewPromptBase) return "not-due";

    const messages: ModelMessage[] = [...input.modelMessages];
    if (input.assistantText.trim()) {
      messages.push({ role: "assistant", content: input.assistantText });
    }

    // `input.system` carries the snapshot from the START of this turn (it
    // must, to keep the provider's prefix cache stable — see the field doc).
    // If a foreground `memory` call wrote something during this same turn,
    // that system-prompt snapshot is already stale by the time the review
    // runs, so the review can't see the entry it would otherwise duplicate.
    // Re-reading the snapshot fresh and appending it to the REVIEW'S user
    // message (never the system prompt) keeps the cached prefix untouched
    // while still showing the model current state. Only fetched when the
    // memory half is actually due — a skill-only review has nothing to gain
    // from it.
    let reviewPrompt = reviewPromptBase;
    if (due.memoryDue) {
      const freshSnapshotBlock = renderMemorySnapshot(await store.loadSnapshot(userId));
      if (freshSnapshotBlock) {
        reviewPrompt = `${reviewPrompt}\n\nCurrent memory contents (do not add anything already listed here — check before every 'add'):\n\n${freshSnapshotBlock}`;
      }
    }
    messages.push({ role: "user", content: reviewPrompt });

    // Tool whitelist is keyed off which SUBSYSTEMS ARE ENABLED, not which one
    // is due — buildSkillReviewPrompt's tool-availability line assumes both
    // may be present whenever memory is enabled at all, so a
    // skill-triggered review can still save a memory it happens to notice,
    // and vice versa.
    const reviewTools: ToolSet = { ...buildReviewToolStubs(input.turnTools) };
    if (config.MEMORY_ENABLED) {
      const ctx = createMemoryToolContext(store, userId, "background_review");
      Object.assign(reviewTools, getMemoryTools(ctx));
    } else if (config.SELF_SKILLS_ENABLED) {
      // Memory is off: `turnTools` (built from the REAL turn's tool set)
      // never carries a `memory` entry in this configuration (see
      // chatTurn.ts — it's only added when memoryInjected), so
      // buildReviewToolStubs above had nothing to stub for it. Register an
      // explicit stub so a model that calls `memory` anyway (despite the
      // now-conditioned prompt wording — see buildSkillReviewPrompt) gets a
      // harmless string result instead of a hard NoSuchToolError that
      // aborts the whole review after the counter's already been bumped.
      reviewTools.memory = tool({
        description: "Not available in this run — persistent memory is disabled.",
        inputSchema: memoryInputSchema,
        execute: async () => MEMORY_TOOL_UNAVAILABLE,
      });
    }
    if (config.SELF_SKILLS_ENABLED && input.learnedSkillStore && input.auditDb) {
      Object.assign(
        reviewTools,
        getSelfSkillTools({
          store: input.learnedSkillStore,
          // A FRESH run context for this review run: read-before-write must
          // be satisfied inside THIS run, never inherited from whatever the
          // foreground turn happened to load() earlier.
          runContext: createSkillRunContext(),
          db: input.auditDb,
          userId,
          origin: "background_review",
          // skill_view exists only for the review run — a normal design
          // turn reads a skill via load_skill, which already satisfies
          // skill_manage's read-before-write guard.
          includeView: true,
        }),
      );
    }

    const result = await generateText({
      model: createModel(config, input.modelOverride),
      system: input.system,
      messages,
      tools: reviewTools,
      stopWhen: stepCountIs(REVIEW_MAX_STEPS),
      // Nobody is waiting on this run (fire-and-forget from onFinish, after
      // the user's response already streamed) and nobody can cancel it, so
      // it needs its own wall-clock cap rather than relying on a caller to
      // abort it — see DEFAULT_REVIEW_TIMEOUT_MS above for why.
      abortSignal: AbortSignal.timeout(input.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS),
    });

    if (config.ENABLE_AGENT_LOGGING) {
      await logSession({
        sessionId: `memory-review-${Date.now()}`,
        timestamp: new Date().toISOString(),
        model: input.modelOverride ?? config.OPENROUTER_MODEL,
        systemPrompt: input.system,
        messages: messages as unknown[],
        steps: result.steps.map((step, i) => ({
          stepNumber: i,
          text: step.text,
          toolCalls: step.toolCalls.map((tc: Record<string, unknown>) => ({
            toolName: String(tc.toolName ?? ""),
            args: (tc.input ?? {}) as Record<string, unknown>,
          })),
          toolResults: step.toolResults.map((tr: Record<string, unknown>) => ({
            toolName: String(tr.toolName ?? ""),
            result: tr.output,
          })),
          finishReason: step.finishReason,
          usage: {
            inputTokens: step.usage.inputTokens ?? 0,
            outputTokens: step.usage.outputTokens ?? 0,
          },
        })),
        totalUsage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      }).catch((err) => console.error("[review] failed to write review log:", err));
    }

    return "ran";
  } catch (err) {
    // Node's AbortSignal.timeout() fires a DOMException named "TimeoutError"
    // (distinct from the "AbortError" a manually-aborted AbortController
    // would produce), and the AI SDK surfaces that name on the rejection it
    // raises from generateText — check it explicitly so a stuck/slow
    // provider shows up in logs as a cancellation, not lumped in with e.g.
    // an auth failure or a malformed response.
    if (isReviewTimeoutError(err)) {
      console.error(
        `[review] memory review cancelled: exceeded ${input.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS}ms wall-clock limit`,
      );
      return "timed-out";
    }
    console.error("[review] memory review failed:", err);
    return "disabled";
  }
}

function isReviewTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === "TimeoutError") return true;
  // The AI SDK sometimes wraps the underlying abort error rather than
  // rethrowing it directly — check one level of `cause` too.
  const cause = err instanceof Error ? err.cause : undefined;
  return cause instanceof Error && cause.name === "TimeoutError";
}

/** Call site for onFinish: guards both a rejected promise and a synchronous
 * throw, exactly like writeRawTraceSafe. */
export function runReviewSafe(input: MaybeRunReviewInput): void {
  try {
    maybeRunReview(input).catch((err) => {
      console.error("[review] memory review failed:", err);
    });
  } catch (err) {
    console.error("[review] memory review failed:", err);
  }
}
