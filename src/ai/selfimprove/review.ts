import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { Config } from "../../config.js";
import { logSession } from "../../logging.js";
import { createModel } from "../provider.js";
import { MEMORY_REVIEW_PROMPT } from "../memory/prompts.js";
import { MEMORY_REVIEW_INTERVAL, type MemoryStore } from "../memory/store.js";
import { createMemoryToolContext, getMemoryTools } from "../memory/tool.js";
import { renderMemorySnapshot } from "../memory/render.js";

const REVIEW_MAX_STEPS = 8;

// Background review, no user waiting on it — but it must not hold a
// multi-MB transcript (modelMessages can carry base64 image parts from
// earlier turns) in memory forever if the provider hangs. 90s is generous
// for an 8-step tool loop against a normal provider while still bounding
// the worst case. Overridable per-call (`reviewTimeoutMs`) so tests don't
// have to actually wait 90s to exercise the timeout path.
const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;

const REVIEW_TOOL_UNAVAILABLE =
  "This tool is not available during a background memory review — only the memory tool runs here. Ignore the system prompt's tool-usage instructions for this turn.";

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
  if (!config.MEMORY_ENABLED || !userId || !store) return "disabled";
  // Do not even bump the counter on a mid-turn continuation request — see
  // the `turnComplete` doc comment. Note we deliberately do NOT change the
  // "reset only after a successful review" question here: the counter still
  // resets as soon as the threshold is observed (see below), win or lose,
  // so a broken model/provider gets one review attempt per interval rather
  // than retrying on every subsequent turn.
  if (!input.turnComplete) return "mid-turn";

  try {
    const counters = await store.bumpCounters({
      userId,
      turns: 1,
      steps: input.stepCount,
      memoryInterval: MEMORY_REVIEW_INTERVAL,
    });
    if (!counters.memoryReviewDue) return "not-due";

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
    // while still showing the model current state.
    const freshSnapshotBlock = renderMemorySnapshot(await store.loadSnapshot(userId));
    const reviewPrompt = freshSnapshotBlock
      ? `${MEMORY_REVIEW_PROMPT}\n\nCurrent memory contents (do not add anything already listed here — check before every 'add'):\n\n${freshSnapshotBlock}`
      : MEMORY_REVIEW_PROMPT;
    messages.push({ role: "user", content: reviewPrompt });

    const ctx = createMemoryToolContext(store, userId, "background_review");
    // Real memory tool + stubs for everything else the system prompt might
    // steer the model towards (see buildReviewToolStubs above). The memory
    // tool is the only one with a real effect; every other name here exists
    // solely so an off-script call resolves instead of throwing.
    const result = await generateText({
      model: createModel(config, input.modelOverride),
      system: input.system,
      messages,
      tools: { ...buildReviewToolStubs(input.turnTools), ...getMemoryTools(ctx) } as ToolSet,
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
