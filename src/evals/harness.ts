import { APICallError, generateText, stepCountIs, type ToolSet } from "ai";
import type { Config } from "../config.js";
import { prepareChatTurn } from "../ai/chatTurn.js";
import type { SystemOneClient } from "../services/systemone.js";
import { DEFAULT_SCREEN_NAME, extractEmbedNodes } from "../showcase/extractEmbeds.js";
import {
  DELEGATED_BRIEF_ANSWER,
  MAX_GENERATED_IMAGES,
  SHOWCASE_MAX_STEPS,
  emulatedClientToolExecute,
  placeholderImageUrl,
} from "../showcase/runner.js";
import { runWithGuardScope } from "./fetchGuard.js";
import { runGraders, trialPassed } from "./graders.js";
import { DEFAULT_TRIAL_TIMEOUT_MS, type EvalTask, type Outcome, type ToolCallRecord, type Transcript, type TrialResult } from "./types.js";

export { DELEGATED_BRIEF_ANSWER };

// The only MCP tools a turn can carry are Mobbin's (src/ai/mcp.ts; Refero is
// gone), spelled as research.md spells them. prepareChatTurn does not expose
// which tools getMCPTools contributed, so detection is by this name list.
// Used to decide `no_mcp_tools`.
export const MCP_TOOL_NAMES: readonly string[] = ["search_screens", "search_flows", "search_sections"];

// Dropped exactly as the showcase runner drops them: no browser, no canvas.
const UNUSABLE_TOOLS = ["get_screenshot", "remove_background", "vectorize_image", "generate_vector"];

// Backend-executed tools whose real implementation calls OpenRouter (the vision
// model behind analyze_image). The fetch guard would turn any call into an
// infra_error and void the trial, so the model's choice would never be graded.
// Deleted rather than stubbed, like get_screenshot: a stub would waste a step.
// Not listed on purpose: generate_image (replaced by a placeholder executor
// below), web_search/fetch_url (Tavily and plain fetch, never OpenRouter).
export const OPENROUTER_BACKED_TOOLS = ["analyze_image"];

export interface RunTrialInput {
  task: EvalTask;
  trial: number;
  config: Config;
  /** `opencode-go/<id>` ref. */
  model: string;
  opencodeApiKey?: string;
  /** Per-user Mobbin OAuth token; without it a research task is skipped (no_mcp_tools). */
  mobbinAccessToken?: string;
  systemOne?: SystemOneClient | null;
  /** Wall-clock cap for the whole agent turn; expiry is infra_error "timeout". */
  timeoutMs?: number;
}

/** Rejects with the signal's reason when it aborts, even if `work` ignores the signal. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function buildTaskMessage(task: EvalTask): string {
  if (task.mode === "prototype") return `/prototype ${task.prompt}`;
  if (task.mode === "slides") return `/slides ${task.prompt}`;
  return task.prompt;
}

type AnyExecute = (args: unknown, options: unknown) => unknown;

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Returns the infra reason for a thrown error, or undefined for an agent failure. */
export function classifyInfraError(err: unknown, blockedUrls: string[]): string | undefined {
  if (blockedUrls.length > 0) return "openrouter_blocked";
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === undefined) return "transport";
    if (status >= 500) return "http_5xx";
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403) return "auth";
    return undefined;
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; name?: string } };
  const isAbort = (name?: string) => name === "TimeoutError" || name === "AbortError";
  if (isAbort(e?.name) || isAbort(e?.cause?.name)) return "timeout";
  if (e?.message === "fetch failed" || /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/.test(e?.cause?.code ?? "")) {
    return "transport";
  }
  return undefined;
}

const emptyTranscript = (): Transcript => ({ toolCalls: [], finalText: "", steps: 0, finishReason: "none" });
const emptyOutcome = (): Outcome => ({
  embeds: [],
  issuedImageUrls: [],
  batchOperations: [],
  generatedImageCalls: 0,
});

export async function runTrial(input: RunTrialInput): Promise<TrialResult> {
  const { task, trial, config } = input;
  const base = { taskId: task.id, trial };
  const transcript = emptyTranscript();
  const outcome = emptyOutcome();

  return runWithGuardScope(async (scope) => {
    const infra = (reason: string, error?: unknown): TrialResult => ({
      ...base,
      status: "infra_error",
      reason,
      blockedUrls: scope.blockedUrls.length ? [...scope.blockedUrls] : undefined,
      error: error === undefined ? undefined : (error as Error)?.message ?? String(error),
      passed: false,
      transcript,
      outcome,
      graders: [],
    });

    try {
      const prepared = await prepareChatTurn({
        config,
        messages: [
          { id: `eval-${task.id}`, role: "user", parts: [{ type: "text", text: buildTaskMessage(task) }] },
        ],
        modelOverride: input.model,
        opencodeApiKey: input.opencodeApiKey,
        // Research is reached through the `/research` skill prompt, not agentMode;
        // its Mobbin tools need the per-user token.
        mobbinAccessToken: input.mobbinAccessToken,
      });
      outcome.injectedSkill = prepared.slashSkillName;
      outcome.skillSource = prepared.skillSource;

      const hadMcpTools = Object.keys(prepared.tools).some((n) => MCP_TOOL_NAMES.includes(n));
      if (task.mode === "research" && !hadMcpTools) {
        return {
          ...base,
          status: "skipped",
          reason: "no_mcp_tools",
          passed: false,
          transcript,
          outcome,
          graders: [],
        };
      }

      const tools: ToolSet = { ...prepared.tools };
      for (const name of [...UNUSABLE_TOOLS, ...OPENROUTER_BACKED_TOOLS]) delete tools[name];

      for (const name of Object.keys(tools)) {
        const entry = tools[name] as { execute?: AnyExecute };
        const impl: AnyExecute =
          typeof entry.execute === "function"
            ? entry.execute
            : name === "batch_design"
              ? batchDesignExecute(outcome)
              : name === "generate_image"
                ? generateImageExecute(outcome)
                : emulatedClientToolExecute(name);
        tools[name] = {
          ...tools[name],
          execute: async (args: unknown, options: unknown) => {
            const record: ToolCallRecord = { index: transcript.toolCalls.length, name, args, result: "" };
            transcript.toolCalls.push(record);
            try {
              const result = await impl(args, options);
              record.result = stringify(result);
              return result;
            } catch (err) {
              record.result = `ERROR: ${(err as Error)?.message ?? String(err)}`;
              throw err;
            }
          },
        } as ToolSet[string];
      }

      let error: string | undefined;
      try {
        const abortSignal = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TRIAL_TIMEOUT_MS);
        const result = await raceAbort(
          generateText({
            model: prepared.model,
            system: prepared.system,
            messages: prepared.modelMessages,
            tools,
            stopWhen: stepCountIs(SHOWCASE_MAX_STEPS),
            // No retry inside a trial: a flake is a failed trial, pass^k must see it.
            maxRetries: 0,
            abortSignal,
          }),
          abortSignal,
        );
        transcript.finalText = result.text;
        transcript.steps = result.steps.length;
        transcript.finishReason = result.finishReason;
      } catch (err) {
        const reason = classifyInfraError(err, scope.blockedUrls);
        if (reason) return infra(reason, err);
        error = (err as Error)?.message ?? String(err);
        transcript.finishReason = "error";
      }
      if (scope.blockedUrls.length > 0) return infra("openrouter_blocked");

      const graders = await runGraders({
        task,
        outcome,
        transcript,
        hadMcpTools,
        systemOne: input.systemOne ?? null,
        config,
      });
      return {
        ...base,
        status: "completed",
        error,
        passed: !error && trialPassed(graders),
        transcript,
        outcome,
        graders,
      };
    } catch (err) {
      const reason = classifyInfraError(err, scope.blockedUrls);
      if (reason) return infra(reason, err);
      return {
        ...base,
        status: "completed",
        error: (err as Error)?.message ?? String(err),
        passed: false,
        transcript,
        outcome,
        graders: [],
      };
    }
  });
}

function batchDesignExecute(outcome: Outcome): AnyExecute {
  return async (args) => {
    const operations = (args as { operations?: string }).operations ?? "";
    outcome.batchOperations.push(operations);
    const nodes = extractEmbedNodes(operations);
    // Replace-by-name like the showcase runner: a re-emitted / R()-replaced screen
    // updates its entry in place. Unnamed screens have no identity and always append.
    const ids = nodes.map((n) => {
      const existing = n.name === DEFAULT_SCREEN_NAME ? -1 : outcome.embeds.findIndex((e) => e.name === n.name);
      if (existing >= 0) {
        outcome.embeds[existing] = n;
        return existing + 1;
      }
      outcome.embeds.push(n);
      return outcome.embeds.length;
    });
    return JSON.stringify({
      success: true,
      operationsExecuted: nodes.length,
      createdNodes: nodes.map((n, i) => ({ id: `screen-${ids[i]}`, name: n.name })),
      note: nodes.length
        ? `Recorded ${nodes.length} embed screen(s) for the eval run.`
        : 'No embed screens found in this batch — only type: "embed" I()/R() operations are captured.',
    });
  };
}

function generateImageExecute(outcome: Outcome): AnyExecute {
  return async (args) => {
    const prompt = (args as { prompt?: string }).prompt ?? "";
    outcome.generatedImageCalls += 1;
    const url = placeholderImageUrl(prompt);
    outcome.issuedImageUrls.push(url);
    return JSON.stringify(
      outcome.generatedImageCalls > MAX_GENERATED_IMAGES
        ? {
            url,
            prompt,
            note: `Image budget for this run is spent (${MAX_GENERATED_IMAGES} generated). This is a placeholder — use it as-is and do not call generate_image again.`,
          }
        : { url, prompt },
    );
  };
}
