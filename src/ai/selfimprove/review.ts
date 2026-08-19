import { generateText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import type { Config } from "../../config.js";
import { logSession } from "../../logging.js";
import { createModel } from "../provider.js";
import type { MemoryStore } from "../memory/store.js";
import { createMemoryToolContext, getMemoryTools, memoryInputSchema } from "../memory/tool.js";
import { renderMemorySnapshot } from "../memory/render.js";
import { selectReviewPrompt } from "../skills/prompts.js";
import type { LearnedSkillStore } from "../skills/learnedStore.js";
import { createSkillRunContext } from "../skills/runContext.js";
import { getSelfSkillTools } from "../skills/tool.js";
import type { TraceQueryable } from "../../tracing/traceStore.js";
import {
  fetchDueScenarios,
  markScenariosOffered,
  renderScenarioBlock,
  settleScenarios,
  type DueScenario,
} from "./scenarioFeed.js";

const REVIEW_MAX_STEPS = 8;

/* Both review thresholds now live in config.ts
 * (MEMORY_REVIEW_INTERVAL / SKILL_REVIEW_INTERVAL, defaults
 * DEFAULT_MEMORY_REVIEW_INTERVAL / DEFAULT_SKILL_REVIEW_INTERVAL) so they can
 * be tuned per deployment. They stay independent quantities: the memory one
 * counts USER TURNS, the skill one counts accumulated TOOL STEPS — a skill is
 * learned from how much tool-calling a task took, not how many messages it
 * spanned. */

// Tool names that mean the review actually WROTE something. Used only to
// label the per-run audit row (`saved` vs `nothing-saved`) — the writes
// themselves are audited by the tools, through their own rows.
const REVIEW_WRITE_TOOLS = new Set(["memory", "skill_manage"]);

/**
 * Writes the one-row-per-run observation. Best-effort: this is
 * instrumentation, and a failed insert must never turn a review that did its
 * job into a logged failure, nor mask the original error on the failure
 * paths.
 *
 * It is a standalone helper rather than inline code because the row has to be
 * written from FOUR places — completed-and-saved, completed-and-declined,
 * timed out, and threw. Writing it only on the completed path (as this first
 * shipped) left the instrumentation blind to exactly the failures worth
 * knowing about: a live production session on 2026-08-15 reset both counters
 * and then produced no row at all for six minutes, which is indistinguishable
 * from "the review never fired" — the precise confusion this row exists to
 * end.
 */
async function writeReviewAudit(
  store: MemoryStore,
  userId: string,
  action: "saved" | "nothing-saved" | "timed-out" | "failed",
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await store.writeAudit({
      userId,
      origin: "background_review",
      subsystem: "review",
      action,
      payload,
    });
  } catch (err) {
    console.error("[review] failed to write review audit row:", err);
  }
}

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

  // Hoisted out of the try so the catch can tell a review that FAILED from
  // one that never started, and can still describe which counters fired.
  let started = false;
  let dueForAudit: Record<string, unknown> = {};
  // Hoisted alongside dueForAudit for the same reason: the catch block needs
  // to write scenario_ids into the timed-out/failed audit row too (see the
  // comment at that write site), and `scenarios` itself is scoped inside the
  // try below.
  let scenariosForAudit: DueScenario[] = [];

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
      memoryInterval: config.MEMORY_REVIEW_INTERVAL,
      // Only check (and possibly reset) the skill due-threshold on the
      // COMPLETED request — omitting skillInterval mid-turn still lets
      // steps_since_skill accumulate (that increment is unconditional in
      // the UPDATE, see bumpCounters' own doc comment) but skips the
      // due-check/reset that only makes sense once the turn is actually
      // over and a review could run. Checking due mid-turn would let a
      // threshold crossed mid-turn get silently reset with no review ever
      // firing for it.
      ...(config.SELF_SKILLS_ENABLED && input.turnComplete
        ? { skillInterval: config.SKILL_REVIEW_INTERVAL }
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
    // Third due-source: a pattern already confirmed by several past sessions.
    // The two counters above ask "has enough happened lately?" — this asks
    // "is there standing evidence worth acting on?", which a single-session
    // review structurally cannot see (it only ever looks at the one
    // conversation in front of it). Read-only and cheap (one indexed SELECT
    // with a small LIMIT), and only worth checking once the turn is actually
    // complete — same reasoning as the skill due-check above.
    let scenarios: DueScenario[] = [];
    if (config.SCENARIOS_ENABLED && input.auditDb) {
      try {
        scenarios = await fetchDueScenarios(
          input.auditDb,
          userId,
          config.SCENARIO_CONFIRM_THRESHOLD,
        );
      } catch (err) {
        // Evidence is an enhancement on top of the counter-driven review, not
        // a replacement for it: losing the ability to read scenarios must
        // never cost the user a review that the counters had already earned
        // — so the failure is logged and swallowed, not rethrown.
        console.error("[review] failed to read due scenarios:", err);
      }
    }

    const reviewPromptBase = selectReviewPrompt(due, config.MEMORY_ENABLED);
    // A confirmed scenario can carry a review on its own, even with both
    // counters cold (memoryDue: false, skillDue: false) — selectReviewPrompt
    // returns null for that all-false `due`, so without this fallback the
    // function would return "not-due" despite having real evidence to show
    // the model. There's no dedicated "scenario-only" prompt variant: it
    // falls back to whichever subsystem prompt the deployment has enabled,
    // exactly the prompt a counter-triggered review for that subsystem would
    // have used, so the scenario block (added below) rides on infrastructure
    // that already exists rather than inventing a fourth prompt shape.
    // The `due` flags used to pick a prompt when NOTHING is fetched fresh:
    // a scenario-only review (both counters cold) still has to pick between
    // MEMORY_REVIEW_PROMPT / buildSkillReviewPrompt / the combined prompt,
    // and it does so by pretending both subsystems are "due" whenever
    // they're enabled at all — same fallback selectReviewPrompt would see
    // from a counter-triggered review, just synthesized instead of read from
    // bumpCounters. Tracked as its own variable (not thrown away after
    // picking promptBase) because the memory-snapshot block below needs to
    // know whether THIS due-shape — not the original counter-derived one —
    // is what actually put MEMORY_REVIEW_PROMPT into the prompt.
    const scenarioFallbackDue = {
      memoryDue: config.MEMORY_ENABLED,
      skillDue: config.SELF_SKILLS_ENABLED,
    };
    const promptBase =
      reviewPromptBase ??
      (scenarios.length > 0 ? selectReviewPrompt(scenarioFallbackDue, config.MEMORY_ENABLED) : null);
    if (!promptBase) return "not-due";
    // Whichever due-shape actually produced `promptBase` — the real one when
    // a counter fired, the synthesized one when only scenario evidence did.
    const promptDue = reviewPromptBase !== null ? due : scenarioFallbackDue;

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
    // while still showing the model current state. Gated on `promptDue`
    // (the due-shape that actually chose `promptBase`), NOT the raw
    // counter-derived `due` — a scenario-only review (both counters cold)
    // still gets MEMORY_REVIEW_PROMPT whenever memory is enabled at all (see
    // scenarioFallbackDue above), and that prompt tells the model to save
    // via the memory tool without listing what is already saved unless this
    // block is attached. Gating on `due.memoryDue` here left exactly that
    // case getting the "go save something" prompt with no memory snapshot to
    // check against first, which is the precise duplicate-write failure this
    // snapshot exists to prevent. A skill-only review still has nothing to
    // gain from it, so the gate stays off in that case either way.
    let reviewPrompt = promptBase;
    if (promptDue.memoryDue) {
      const freshSnapshotBlock = renderMemorySnapshot(await store.loadSnapshot(userId));
      if (freshSnapshotBlock) {
        reviewPrompt = `${reviewPrompt}\n\nCurrent memory contents (do not add anything already listed here — check before every 'add'):\n\n${freshSnapshotBlock}`;
      }
    }
    // Evidence goes in the review's USER message, appended after the memory
    // snapshot — never in `system`, which is reused verbatim above to keep
    // the provider's prefix cache warm. renderScenarioBlock returns "" for
    // an empty list, so this is a no-op when nothing is due.
    const scenarioBlock = renderScenarioBlock(scenarios);
    if (scenarioBlock) reviewPrompt = `${reviewPrompt}\n\n${scenarioBlock}`;
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

    // Mark the offer BEFORE generateText, not after: if the run times out or
    // throws below, the scenario must still count as offered — otherwise a
    // provider that reliably hangs on this prompt would keep the same
    // scenario "due" forever, offering it every single review run instead of
    // retiring it after two silent offers. A crash mid-run costing one offer
    // is the acceptable trade against a review that never terminates.
    if (scenarios.length > 0 && input.auditDb) {
      try {
        await markScenariosOffered(
          input.auditDb,
          scenarios.map((s) => s.id),
        );
      } catch (err) {
        console.error("[review] failed to mark scenarios offered:", err);
      }
    }

    started = true;
    dueForAudit = { memoryDue: due.memoryDue, skillDue: due.skillDue };
    scenariosForAudit = scenarios;
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

    // One row per run, saved or not — the only signal that distinguishes "the
    // review never fired" from "it fired and declined" on a deployment with
    // ENABLE_AGENT_LOGGING off (i.e. production).
    const calledTools = result.steps.flatMap((step) =>
      step.toolCalls.map((tc: { toolName?: unknown }) => String(tc.toolName ?? "")),
    );
    const wrote = calledTools.some((name) => REVIEW_WRITE_TOOLS.has(name));
    // Which write tool(s) actually fired, deduped — this is what
    // settleScenarios records into `distilled_into` so a distilled scenario
    // can be traced forward to what it became (a memory entry, a skill, or
    // both), not just tagged with the constant "the background review did
    // it". Order-stable dedup via Set rather than sorting: the calling order
    // (memory before skill_manage, say) is itself information worth keeping.
    const writeToolNames = [...new Set(calledTools.filter((name) => REVIEW_WRITE_TOOLS.has(name)))];

    // Settle every offered scenario against the SAME `wrote` signal the audit
    // row below uses — one review, one outcome, applied identically to
    // "did this save anything" and "did this act on the evidence it was
    // shown". A settle failure must not cost the run its already-earned
    // audit row, so it is logged and swallowed, matching every other
    // best-effort write in this function.
    if (scenarios.length > 0 && input.auditDb) {
      try {
        await settleScenarios(input.auditDb, scenarios, wrote, writeToolNames);
      } catch (err) {
        console.error("[review] failed to settle scenarios:", err);
      }
    }

    await writeReviewAudit(store, userId, wrote ? "saved" : "nothing-saved", {
      memoryDue: due.memoryDue,
      skillDue: due.skillDue,
      // The metric the whole scenario layer is judged by: saved-rate on runs
      // WITH evidence vs. runs without. Always an array — empty, not
      // omitted, when no scenario was due — so both populations are
      // countable from a single query over this column rather than needing
      // a second query for "runs where the key is absent".
      scenario_ids: scenarios.map((s) => s.id),
      steps: result.steps.length,
      // Every tool the run reached for, not just the writing ones: a review
      // burning its steps on stubbed pen tools looks identical to one that
      // genuinely had nothing to save, and only this field tells them apart.
      toolsCalled: calledTools,
      finishReason: result.finishReason,
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
    const timedOut = isReviewTimeoutError(err);
    if (timedOut) {
      console.error(
        `[review] memory review cancelled: exceeded ${input.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS}ms wall-clock limit`,
      );
    } else {
      console.error("[review] memory review failed:", err);
    }

    // Audit the failure too, but ONLY once the run had actually reached
    // generateText. A throw from the setup above (bumpCounters, the snapshot
    // read) is not a review that failed — it is a review that never started,
    // and recording it as one would corrupt the very ratio this row exists to
    // measure. `store`/`userId` are non-null past the guard at the top, but
    // `started` is what makes the distinction; note the counters have already
    // been reset by then, so a silent failure here costs a whole interval.
    if (started && store && userId) {
      await writeReviewAudit(store, userId, timedOut ? "timed-out" : "failed", {
        ...dueForAudit,
        // Same field, same shape as the success path (`scenario_ids`, always
        // an array) — omitting it here was the bug: run.ts classifies a run
        // as "with evidence" by a non-empty `payload->'scenario_ids'`, so a
        // timed-out/failed row that never wrote this key silently fell into
        // the "no evidence" bucket even when scenarios WERE offered (recall
        // markScenariosOffered already ran before generateText, specifically
        // so a crash mid-run still counts as an offer). Scenario-carrying
        // reviews run a longer prompt and are the more likely to time out,
        // so that misclassification systematically flattered the
        // no-evidence control group in exactly the comparison this metric
        // exists to make.
        scenario_ids: scenariosForAudit.map((s) => s.id),
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timeoutMs: input.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      });
    }

    return timedOut ? "timed-out" : "disabled";
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
