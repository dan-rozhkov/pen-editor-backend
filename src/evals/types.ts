// Types for the agent-eval harness. Spec: docs/specs/2026-10-20-agent-evals-design.md

/** Default wall-clock cap of one trial's agent turn. */
export const DEFAULT_TRIAL_TIMEOUT_MS = 10 * 60 * 1000;

export type EvalSuite = "regression" | "capability";
export type EvalMode = "default" | "prototype" | "slides" | "research";

export type GraderSpec =
  | { type: "embeds-present"; min: number }
  | { type: "embed-only" }
  | { type: "box-size"; width?: number; height?: number; platform?: "mobile" | "desktop" }
  | { type: "filmstrip" }
  | { type: "html-complete" }
  | { type: "image-urls-issued" }
  | { type: "image-budget" }
  | { type: "asked-first" }
  | { type: "not-asked" }
  | { type: "skill-loaded-first"; skill: string }
  | { type: "grounded-refs" }
  | { type: "taste-clean" };

export type GraderId = GraderSpec["type"];

export interface EvalTask {
  id: string;
  suite: EvalSuite;
  mode: EvalMode;
  prompt: string;
  graders: GraderSpec[];
  /** The incident / skill line this task came from. An incident-sourced task is never softened later. */
  source: string;
}

export interface ToolCallRecord {
  index: number;
  name: string;
  args: unknown;
  result: string;
}

export interface Transcript {
  toolCalls: ToolCallRecord[];
  finalText: string;
  steps: number;
  finishReason: string;
}

export interface OutcomeEmbed {
  name: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  htmlContent: string;
}

export interface Outcome {
  embeds: OutcomeEmbed[];
  issuedImageUrls: string[];
  /** Raw `operations` string of every batch_design call, in order. */
  batchOperations: string[];
  generatedImageCalls: number;
  /** Skill that prepareChatTurn itself injected (slash command or auto-pick), if any. */
  injectedSkill?: string;
  skillSource?: "slash" | "auto";
}

export interface GraderResult {
  id: GraderId;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

export type TrialStatus = "completed" | "infra_error" | "skipped";

export interface TrialResult {
  taskId: string;
  trial: number;
  status: TrialStatus;
  /** infra_error / skipped reason, e.g. "openrouter_blocked", "no_mcp_tools". */
  reason?: string;
  /** Offending URLs recorded by the fetch guard. */
  blockedUrls?: string[];
  /** Error message of a non-infra failure of the turn (counts as a failed trial). */
  error?: string;
  passed: boolean;
  transcript: Transcript;
  outcome: Outcome;
  graders: GraderResult[];
}

export interface TaskStats {
  n: number;
  c: number;
  infra: number;
  skipped: number;
  /** null when no trial completed (n = 0): not measurable, not zero. */
  passAt1: number | null;
  /** null when completed trials n < k (infra/skipped ate the rest): shown "n/a". */
  passPowK: number | null;
}
