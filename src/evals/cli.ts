import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASTE_RULES } from "../ai/tasteCheck.js";
import { OPENCODE_CHAT_COMPLETIONS_MODELS } from "../ai/opencode.js";
import { readFlag } from "../showcase/cliFlags.js";
import { meanDefined, passAtK, passPowK } from "./metrics.js";
import { DEFAULT_TRIAL_TIMEOUT_MS, type EvalSuite, type TaskStats, type TrialResult } from "./types.js";

export const DEFAULT_EVAL_MODEL = "opencode-go/deepseek-v4-pro";
export const GO_PREFIX = "opencode-go/";

export class UsageError extends Error {}

export interface EvalArgs {
  suite: EvalSuite | "all";
  taskId?: string;
  k: number;
  model: string;
  concurrency: number;
  trialTimeoutMs: number;
}


function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer (got "${raw}")`);
  return n;
}

export function parseEvalArgs(argv: string[]): EvalArgs {
  const suite = readFlag(argv, "suite") ?? "all";
  if (suite !== "regression" && suite !== "capability" && suite !== "all") {
    throw new UsageError(`--suite must be regression, capability or all (got "${suite}")`);
  }
  const model = readFlag(argv, "model") ?? DEFAULT_EVAL_MODEL;
  if (!model.startsWith(GO_PREFIX)) {
    throw new UsageError(`--model must start with "${GO_PREFIX}" (got "${model}"): evals never use OpenRouter`);
  }
  const id = model.slice(GO_PREFIX.length);
  if (!OPENCODE_CHAT_COMPLETIONS_MODELS["opencode-go"].includes(id)) {
    throw new UsageError(`unknown OpenCode Go model "${id}"`);
  }
  return {
    suite,
    taskId: readFlag(argv, "task"),
    k: positiveInt(readFlag(argv, "k"), "k", 3),
    model,
    concurrency: positiveInt(readFlag(argv, "concurrency"), "concurrency", 2),
    trialTimeoutMs: positiveInt(readFlag(argv, "trial-timeout-ms"), "trial-timeout-ms", DEFAULT_TRIAL_TIMEOUT_MS),
  };
}

export function summarize(results: TrialResult[], k: number): Record<string, TaskStats> {
  const byTask = new Map<string, TrialResult[]>();
  for (const r of results) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out: Record<string, TaskStats> = {};
  for (const [id, trials] of byTask) {
    const counted = trials.filter((t) => t.status === "completed");
    const n = counted.length;
    const c = counted.filter((t) => t.passed).length;
    out[id] = {
      n,
      c,
      infra: trials.filter((t) => t.status === "infra_error").length,
      skipped: trials.filter((t) => t.status === "skipped").length,
      passAt1: passAtK(n, c, 1),
      passPowK: passPowK(n, c, k),
    };
  }
  return out;
}

export function suiteMeans(
  stats: Record<string, TaskStats>,
  suiteOf: (taskId: string) => EvalSuite,
): Record<string, { passAt1: number | null; passPowK: number | null }> {
  const out: Record<string, { passAt1: number | null; passPowK: number | null }> = {};
  for (const suite of ["regression", "capability"] as const) {
    const rows = Object.entries(stats).filter(([id]) => suiteOf(id) === suite);
    if (rows.length === 0) continue;
    out[suite] = {
      passAt1: meanDefined(rows.map(([, s]) => s.passAt1)),
      passPowK: meanDefined(rows.map(([, s]) => s.passPowK)),
    };
  }
  return out;
}

export function modelSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "screen";

export function runDirName(now: Date, model: string): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${modelSlug(model)}`;
}

/** Writes trials/*.json, screens/*.html and labels.template.json into runDir. */
export function writeRunArtifacts(runDir: string, results: TrialResult[]): void {
  mkdirSync(join(runDir, "trials"), { recursive: true });
  mkdirSync(join(runDir, "screens"), { recursive: true });
  const screens: Array<{ file: string; task: string; labels: Record<string, "unknown"> }> = [];
  for (const r of results) {
    writeFileSync(join(runDir, "trials", `${r.taskId}-${r.trial}.json`), JSON.stringify(r, null, 2));
    r.outcome.embeds.forEach((embed, i) => {
      const file = `screens/${r.taskId}-${r.trial}-${fileSafe(embed.name)}${i > 0 ? `-${i + 1}` : ""}.html`;
      writeFileSync(join(runDir, file), embed.htmlContent);
      screens.push({
        file,
        task: r.taskId,
        labels: Object.fromEntries(TASTE_RULES.map((rule) => [rule.id, "unknown" as const])),
      });
    });
  }
  // The labels file lives inside the run dir; calibrateRun resolves runDir against the file's own directory.
  const template = { runDir: ".", rules: TASTE_RULES.map((r) => r.id), screens };
  writeFileSync(join(runDir, "labels.template.json"), JSON.stringify(template, null, 2));
}

export function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function appendHistory(
  historyPath: string,
  entry: {
    date: string;
    sha: string;
    model: string;
    k: number;
    suite: string;
    stats: Record<string, TaskStats>;
  },
): void {
  mkdirSync(join(historyPath, ".."), { recursive: true });
  const tasks = Object.fromEntries(
    Object.entries(entry.stats).map(([id, s]) => [
      id,
      { n: s.n, c: s.c, infra: s.infra, "pass@1": s.passAt1, "pass^k": s.passPowK },
    ]),
  );
  appendFileSync(historyPath, JSON.stringify({ ...entry, stats: undefined, tasks }) + "\n");
}

export const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);

export function formatTable(stats: Record<string, TaskStats>, k: number): string {
  const rows = [["task", "n", "c", "infra", "skipped", "pass@1", `pass^${k}`]];
  for (const [id, s] of Object.entries(stats)) {
    rows.push([id, String(s.n), String(s.c), String(s.infra), String(s.skipped), pct(s.passAt1), pct(s.passPowK)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ")).join("\n");
}
